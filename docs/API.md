# Teto Player — API «Что играет» (Windows)

Teto Player может сообщать другим программам **на этом же компьютере**, что сейчас играет:
название, исполнитель, альбом, обложка, позиция (таймкод), состояние, **текущая и следующая строка текста песни**, очередь.
По желанию — принимать команды (пауза, следующая, перемотка, громкость, скачать по ссылке).

Подходит для оверлея в OBS, виджетов (Rainmeter, Wallpaper Engine), ботов Twitch/Discord, Stream Deck,
скриптов AutoHotkey/PowerShell/Python и своих «модулей» к плееру.

> Всё работает только на `127.0.0.1` — из сети и интернета к API не подключиться. Плеер сам ничего никуда не отправляет.

## Содержание
1. Включение · 2. Способы подключения · 3. HTTP · 4. События (SSE, WebSocket) · 5. Форматы данных ·
6. Управление · 7. Именованный канал · 8. Файлы · 9. Оверлей для OBS · 10. Безопасность · 11. Примеры

---

## 1. Включение
**Настройки → Трансляция → «Трансляция для других программ»** (по умолчанию выключено).

| Настройка | По умолчанию | Что делает |
|---|---|---|
| Порт | `7710` | HTTP/WebSocket-сервер `http://127.0.0.1:7710` |
| Именованный канал | вкл. | `\\.\pipe\teto-player` для программ на C#/C++/PowerShell |
| Файлы для OBS | выкл. | файлы в папке `nowplaying\` |
| Разрешить управление | выкл. | команды `/v1/control/*` (нужен токен) |
| Разрешить сайтам | выкл. | пускать запросы со страниц с чужим `Origin` (обычно не нужно) |

Там же: адреса, «Оверлей для OBS» (скопировать адрес / открыть), токен (показать / скопировать / новый), число подключённых клиентов.
Настройки хранятся в `settings.json` (поле `api`). Страница `http://127.0.0.1:7710/` — краткая справка и живое состояние.

## 2. Способы подключения
| Способ | Для чего | Направление |
|---|---|---|
| `GET /v1/now` | разовый опрос | запрос → ответ |
| `GET /v1/events` (SSE) | веб-страницы, Python, Node — проще всего | плеер → клиент |
| `GET /v1/ws` (WebSocket) | события и команды по одному соединению | в обе стороны |
| `\\.\pipe\teto-player` | нативные программы Windows | плеер → клиент |
| файлы `nowplaying\` | OBS «Текст из файла», Rainmeter, всё, что читает файлы | плеер → файл |

Версия протокола — поле `v` (сейчас `1`). Новые поля могут добавляться — незнакомые поля клиенту следует игнорировать.

## 3. HTTP
База `http://127.0.0.1:7710`. Ответы в UTF-8, `Cache-Control: no-store`, `Access-Control-Allow-Origin: *`.

| Метод и путь | Ответ |
|---|---|
| `GET /` | HTML-справка и живое состояние |
| `GET /v1`, `GET /v1/info` | `{ app, version, v, port, control, pipe, endpoints[] }` |
| `GET /v1/now` | состояние «что играет» (раздел 5) |
| `GET /v1/now.txt?fmt=…` | одна строка по шаблону (по умолчанию `{artist} — {title}`) |
| `GET /v1/lyrics` | весь текст текущей песни с таймкодами |
| `GET /v1/cover?size=300` | обложка текущей песни (JPEG/PNG), `size` 64…600, по умолчанию 600 |
| `GET /v1/cover/{album_id}?size=…` | обложка конкретного альбома |
| `GET /v1/queue?limit=20` | очередь от текущей песни (`limit` ≤ 500) |
| `GET /v1/events` | поток событий SSE |
| `GET /v1/ws` | WebSocket |
| `POST /v1/control/{cmd}` | управление (раздел 6) |
| `GET /overlay` | оверлей для OBS (раздел 9) |

Коды ошибок: `404` — нет такого пути или обложки; `403` — чужой Origin/Host или управление выключено; `401` — нет/неверный токен; `400` — неверные аргументы.

**Шаблон `now.txt`**: `{title} {artist} {album} {year} {genre} {format} {line} {next} {pos} {dur} {state}`.
`{pos}`/`{dur}` — `м:сс`, `{state}` — `playing`/`paused`/`stopped`. Шаблон URL-кодируется:
```
/v1/now.txt?fmt=%E2%99%AA%20%7Bartist%7D%20%E2%80%94%20%7Btitle%7D%20%5B%7Bpos%7D%2F%7Bdur%7D%5D
→ ♪ Kasane Teto — Fukkireta [1:02/3:41]
```

## 4. События (SSE и WebSocket)
| Событие | Когда | `data` |
|---|---|---|
| `hello` | сразу после подключения | полный `now` |
| `track` | сменилась песня | полный `now` |
| `state` | пауза/play/стоп, перемотка, громкость, перемешка, повтор, очередь | полный `now` |
| `line` | сменилась строка синхронизированного текста | `{track_id, pos, ts, line, next, prev}` |
| `lyrics` | текст песни загружен или изменился | как `GET /v1/lyrics` |
| `pos` | раз в секунду во время воспроизведения | `{track_id, pos, dur, ts, playing}` |

Параметры (для `/v1/events` и `/v1/ws`): `?pos=0` — без событий `pos`; `?events=track,line` — только перечисленные (`hello` приходит всегда).

**SSE** — стандартный формат `event: <имя>` / `data: <json>`, `retry: 2000`, каждые 15 с комментарий `: ping`. `EventSource` переподключается сам.

**WebSocket** `ws://127.0.0.1:7710/v1/ws` — каждое сообщение сервера: `{"event": "<имя>", "data": {...}}`. Клиент может слать команды:
```json
{ "cmd": "now", "id": 1 }
{ "cmd": "lyrics", "id": 2 }
{ "cmd": "queue", "args": { "limit": 10 }, "id": 3 }
{ "cmd": "seek", "args": { "pos": 60 }, "token": "<токен>", "id": 4 }
```
Ответ: `{"event":"reply","data":{"id":4,"ok":true,"result":{...}}}` или `{"event":"reply","data":{"id":4,"ok":false,"code":401,"error":"..."}}`.
`now`, `lyrics`, `queue` — без токена; остальные команды те же, что в разделе 6, и требуют `token`.
Сервер шлёт ping каждые 15 с и отвечает pong на ping клиента.

**Точная позиция без опроса.** В каждом сообщении есть `ts` — Unix-время (мс), когда снята `pos`. При `state == "playing"`
текущая позиция = `pos + (Date.now() - ts) / 1000`. Так можно плавно вести прогресс или караоке с `?pos=0`.

## 5. Форматы данных

### `now` (`GET /v1/now`, события `hello`, `track`, `state`)
```json
{
  "v": 1,
  "state": "playing",
  "ts": 1767225600123,
  "pos": 62.41,
  "dur": 221.0,
  "track": {
    "id": 1532, "title": "Fukkireta", "artist": "Kasane Teto", "album": "Fukkireta",
    "album_id": 211, "year": 2023, "genre": "Vocaloid", "dur": 221.0,
    "codec": "flac", "format": "FLAC 44.1 kHz / 16 bit", "path": "D:\\Music\\Teto\\Fukkireta.flac"
  },
  "cover_url": "http://127.0.0.1:7710/v1/cover/211?size=600",
  "lyrics": {
    "kind": "synced", "source": "LRCLIB", "count": 48,
    "line": { "index": 12, "t": 60.9, "end": 64.2, "text": "текущая строка" },
    "next": { "index": 13, "t": 64.2, "end": 67.8, "text": "следующая строка" },
    "prev": { "index": 11, "t": 57.1, "end": 60.9, "text": "предыдущая строка" }
  },
  "volume": 0.8, "muted": false, "shuffle": false, "repeat": "off",
  "queue": { "index": 4, "length": 37 }
}
```
- `state`: `playing` | `paused` | `stopped`. При `stopped` поля `track`, `cover_url`, `lyrics` равны `null`.
- `pos`, `dur`, `t`, `end` — секунды (дробные). `ts` — Unix-время в миллисекундах.
- `lyrics.kind`: `synced` (с таймкодами), `plain` (без таймкодов: `line`/`next`/`prev` = `null`), `none` (текста нет), `loading`.
- `lyrics.line` = `null` во вступлении до первой строки; `next` во вступлении — первая строка. `end` последней строки = длительность песни.
- `repeat`: `off` | `all` | `one`; `volume` — 0…1. Поля `track` могут быть пустыми строками / `null`, если тегов нет.

### `lyrics` (`GET /v1/lyrics`, событие `lyrics`)
```json
{ "track_id": 1532, "kind": "synced", "source": "LRCLIB",
  "lines": [ { "index": 0, "t": 12.3, "end": 15.0, "text": "..." } ] }
```
Для `plain` таймкоды `t`/`end` не имеют смысла — показывайте текст целиком.

### `line`
```json
{ "track_id": 1532, "pos": 64.25, "ts": 1767225601950,
  "line": { "index": 13, "t": 64.2, "end": 67.8, "text": "..." },
  "next": { "index": 14, "t": 67.8, "end": 71.0, "text": "..." },
  "prev": { "index": 12, "t": 60.9, "end": 64.2, "text": "..." } }
```

### `pos`
`{ "track_id": 1532, "pos": 65.0, "dur": 221.0, "ts": 1767225602000, "playing": true }`

### `queue` (`GET /v1/queue`)
`{ "index": 4, "length": 37, "items": [ { "index": 4, "id", "title", "artist", "album", "album_id", "dur" }, … ] }` — `items[0]` = текущая песня.

## 6. Управление
Включите **«Разрешить управление»** и скопируйте токен (Настройки → Трансляция). Токен передаётся заголовком
`Authorization: Bearer <токен>` или параметром `?token=<токен>`. Кнопка «Новый» выдаёт новый токен, старый перестаёт работать.

`POST /v1/control/{cmd}`, тело — JSON (если нужно):

| `cmd` | Тело | Действие |
|---|---|---|
| `play` / `pause` / `toggle` | — | воспроизведение / пауза / переключить |
| `next` / `prev` | — | следующая / предыдущая песня |
| `seek` | `{"pos": 60.5}` | перейти к секунде |
| `volume` | `{"v": 0.5}` | громкость 0…1 |
| `mute` | `{"m": true}` | без звука (без тела — переключить) |
| `shuffle` | `{"on": true}` | перемешка (без тела — переключить) |
| `repeat` | `{"mode": "one"}` | `off` / `all` / `one` |
| `download` | `{"url": "https://…"}` | в очередь загрузок: ссылка YouTube / YouTube Music / SoundCloud / Spotify |

Ответ `{"ok": true}`, ошибка — `{"ok": false, "error": "…"}` (400/401/403).
```bat
curl -X POST -H "Authorization: Bearer ТОКЕН" http://127.0.0.1:7710/v1/control/toggle
curl -X POST -H "Authorization: Bearer ТОКЕН" -d "{\"pos\":60}" http://127.0.0.1:7710/v1/control/seek
```

## 7. Именованный канал
`\\.\pipe\teto-player` — только чтение, NDJSON: одна строка = `{"event": "...", "data": {...}}` (события раздела 4,
первое — `hello`; каждые 15 с `{"event":"ping","data":null}`). Клиентов может быть сколько угодно, удалённые отклоняются.
Если плеер закрыт или трансляция выключена — канала нет: повторяйте подключение раз в несколько секунд.
Команд канал не принимает — для управления используйте HTTP или WebSocket.

## 8. Файлы
При включённых «Файлах для OBS» плеер пишет в `%LOCALAPPDATA%\Teto Player\nowplaying\` (кнопка «Папка» в настройках):

| Файл | Содержимое |
|---|---|
| `track.txt` | `Исполнитель — Название` |
| `title.txt`, `artist.txt`, `album.txt` | по отдельности |
| `line.txt`, `next_line.txt` | текущая и следующая строка текста |
| `state.txt` | `playing` / `paused` / `stopped` |
| `now.json` | как `GET /v1/now` (обновляется при смене песни/состояния/строки, не каждую секунду) |
| `cover.jpg` | обложка текущей песни |

Файл перезаписывается только при изменении, через временный файл и переименование — читатель не увидит «половину».
При остановке текстовые файлы становятся пустыми.

## 9. Оверлей для OBS
**Источники → Браузер**, URL `http://127.0.0.1:7710/overlay`, ширина ≈ 800, высота ≈ 160. Фон прозрачный.
Обложка, название, исполнитель, текущая и следующая строка текста, полоса прогресса; на паузе плавно скрывается.

| Параметр | Пример | Действие |
|---|---|---|
| `cover=0` | | без обложки |
| `lyrics=0` | | без текста песни |
| `next=0` | | без следующей строки |
| `progress=0` | | без полосы прогресса |
| `align` | `center`, `right` | выравнивание |
| `scale` | `1.5` | масштаб |
| `accent` | `%23ff4d6d` | цвет акцента (`#` = `%23`) |

Пример: `http://127.0.0.1:7710/overlay?align=center&scale=1.3&next=0&accent=%23e0315a`.

## 10. Безопасность
- Сервер слушает только `127.0.0.1` — с других устройств подключиться нельзя.
- Защита от DNS-rebinding: принимается только `Host: 127.0.0.1` / `localhost`.
- Запросы со страниц с чужим `Origin` (любой сайт) получают `403`, пока не включено «Разрешить сайтам».
  Разрешены `localhost`, `127.0.0.1`, `file://`, `null` (локальные HTML-файлы, OBS).
- Чтение без токена (это то же, что видно в статусе Discord); управление — только если включено и с токеном
  (сравнение за постоянное время). Тело запроса ≤ 64 КБ.

## 11. Примеры
Готовые файлы в [`api-examples/`](api-examples/): `teto_now.py` (Python, без зависимостей), `teto-now.mjs` (Node 18+),
`teto-pipe.ps1` (PowerShell, канал), `karaoke.html` (караоке-страница — открыть в браузере или добавить в OBS как локальный файл).

**Браузер / OBS / Electron**
```js
const es = new EventSource('http://127.0.0.1:7710/v1/events?pos=0');
es.addEventListener('track', e => {
  const n = JSON.parse(e.data);
  console.log(n.track ? `${n.track.artist} — ${n.track.title}` : 'остановлено');
});
es.addEventListener('line', e => console.log('♪', JSON.parse(e.data).line?.text ?? ''));
```

**WebSocket + управление**
```js
const ws = new WebSocket('ws://127.0.0.1:7710/v1/ws?pos=0');
ws.onmessage = m => { const { event, data } = JSON.parse(m.data); console.log(event, data); };
ws.onopen = () => ws.send(JSON.stringify({ cmd: 'next', token: 'ТОКЕН', id: 1 }));
```

**PowerShell (канал)**
```powershell
$p = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'teto-player', [System.IO.Pipes.PipeDirection]::In)
$p.Connect(5000)
$r = New-Object System.IO.StreamReader($p, [Text.Encoding]::UTF8)
while (($l = $r.ReadLine()) -ne $null) {
  $m = $l | ConvertFrom-Json
  if ($m.event -eq 'track' -and $m.data.track) { "$($m.data.track.artist) — $($m.data.track.title)" }
  if ($m.event -eq 'line' -and $m.data.line) { "  ♪ $($m.data.line.text)" }
}
```

**C#**
```csharp
using var pipe = new System.IO.Pipes.NamedPipeClientStream(".", "teto-player", System.IO.Pipes.PipeDirection.In);
pipe.Connect(5000);
using var rd = new StreamReader(pipe, System.Text.Encoding.UTF8);
while (rd.ReadLine() is string line) {
    using var doc = System.Text.Json.JsonDocument.Parse(line);
    var ev = doc.RootElement.GetProperty("event").GetString();
    if (ev == "line") Console.WriteLine(doc.RootElement.GetProperty("data").GetProperty("line"));
}
```

**AutoHotkey v2** — Ctrl+Alt+→ = следующая песня
```ahk
^!Right:: {
  req := ComObject("WinHttp.WinHttpRequest.5.1")
  req.Open("POST", "http://127.0.0.1:7710/v1/control/next")
  req.SetRequestHeader("Authorization", "Bearer ТОКЕН")
  req.Send()
}
```

## Ограничения
- API есть только в версии для Windows.
- Если порт занят, в настройках будет ошибка — выберите другой порт.
- Текст песни тот же, что показывает плеер (из тегов файла, `.lrc` рядом или из интернета, если включено).
