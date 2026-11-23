# Teto Player

Музыкальный плеер для **Windows** (Tauri 2 + Rust) и **Android / iPhone** (Capacitor). Общий интерфейс — React 18 + TypeScript.
Автор — **KinkyWonder**.

- `Teto Player.exe` — портативная программа, установка не нужна (WebView2 уже есть в Windows 10/11). Данные: `%LOCALAPPDATA%\Teto Player`.
- Android — `Teto-1.9.0.apk` (64-битные телефоны, arm64). iPhone — неподписанный `Teto.ipa` из GitHub Actions (`.github/workflows/ios.yml`), ставится через Sideloadly.

| Документ | Что внутри |
|---|---|
| [docs/BUILD.md](docs/BUILD.md) | Сборка всех версий (Windows, Android, iOS, WASM), подпись, тесты |
| [AGENTS.md](AGENTS.md) | Карта проекта и правила для разработчиков/ИИ-агентов |
| [docs/API.md](docs/API.md) | API «Что играет» для других программ на ПК: HTTP/SSE/WebSocket, канал, файлы, оверлей OBS |
| [CHANGELOG.md](CHANGELOG.md) | История изменений |

Быстрый старт: `npm install && npm run dev` → `http://localhost:1420` (ПК-интерфейс с демо-данными) или `http://localhost:1420/?mobile` (телефон).

## Не реализовано
- WASAPI Exclusive / bit-perfect (используется общий режим).
- Нейросетевой классификатор тэгов (используются теги файлов, интернет и анализ звука).
- Скачивание на iPhone (yt-dlp нельзя запустить внутри приложения iOS).
- Opus.
