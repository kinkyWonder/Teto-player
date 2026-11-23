import { useEffect, useRef, useState } from 'react';
import { api, call, isTauri } from '../../app/api';
import { ApiSection } from './ApiSettings';
import { Icon } from '../icons';
import { getState, livePos, navigate, setState, toast, useStore } from '../../app/store';
import type { DiscordCfg, Settings, Track } from '../../core/types';
import { fmtTime } from '../../core/util';
import { Cover } from '../Cover';
import { themeKey } from '../../core/look';
import { prefs, setPrefs, subscribePrefs, type Prefs } from '../../core/prefs';
import { useSyncExternalStore } from 'react';
import { t as tr } from '../../i18n';
import { AuthorRow, CoverStyleRow, DownloadRow, HintsRow, LangRow, LayoutRow, ListAlbumRow, ReportsRow, ReprocessRow, VizSceneRows, themeEntries } from './MoreSettings';
import { DevSection, versionTap } from './DevMode';

export function usePrefs(): Prefs { return useSyncExternalStore(subscribePrefs, prefs); }
export function VizQualityRow() {
  const p = usePrefs();
  return (
    <div className="srow"><div><b>{tr('3D-визуализация')}</b><span>{tr('«Авто» — экономный режим от батареи. Открывается кнопкой ◎ в плеере, клавишей V или двойным щелчком по обложке')}</span></div>
      <div className="seg">{([['auto', 'Авто'], ['eco', 'Эконом'], ['normal', 'Обычно'], ['high', 'Максимум']] as const).map(([k, l]) => (
        <button key={k} className={p.vizQuality === k ? 'on' : ''} onClick={() => setPrefs({ vizQuality: k })}>{tr(l)}</button>))}</div>
    </div>
  );
}

type Patch = Partial<Settings>;
const save = async (p: Patch) => setState({ settings: await api.setSettings(p) });

const Toggle = ({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) => <button className={'tg' + (on ? ' on' : '')} onClick={() => onChange(!on)} />;

function Row({ t, d, children, col }: { t: string; d?: React.ReactNode; children?: React.ReactNode; col?: boolean }) {
  return (
    <div className={'srow' + (col ? ' col' : '')}>
      <div><b>{tr(t)}</b>{d && <span>{typeof d === 'string' ? tr(d) : d}</span>}</div>
      {children}
    </div>
  );
}

function Seg<T extends string | number>({ v, opts, onChange }: { v: T; opts: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {opts.map(([k, l]) => <button key={String(k)} className={k === v ? 'on' : ''} onClick={() => onChange(k)}>{tr(l)}</button>)}
    </div>
  );
}

function Range({ v, min, max, step, fmt, onChange }: { v: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  const [x, setX] = useState(v);
  useEffect(() => setX(v), [v]);
  return (
    <div className="rng">
      <input type="range" min={min} max={max} step={step} value={x} style={{ ['--v' as string]: `${((x - min) / (max - min)) * 100}%` }}
        onChange={(e) => setX(+e.target.value)} onPointerUp={() => onChange(x)} onKeyUp={() => onChange(x)} />
      <span className="mono">{fmt(x)}</span>
    </div>
  );
}

/** Text input that saves on blur / Enter / 500 ms after typing. */
function Text({ v, onChange, placeholder, mono, width }: { v: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; width?: number }) {
  const [x, setX] = useState(v);
  const t = useRef<number>();
  useEffect(() => setX(v), [v]);
  const commit = (val: string) => { clearTimeout(t.current); if (val !== v) onChange(val); };
  return (
    <input className={'inp' + (mono ? ' mono' : '')} style={width ? { width } : undefined} value={x} placeholder={placeholder} spellCheck={false}
      onChange={(e) => { const val = e.target.value; setX(val); clearTimeout(t.current); t.current = window.setTimeout(() => commit(val), 500); }}
      onBlur={() => commit(x)} onKeyDown={(e) => e.key === 'Enter' && commit(x)} />
  );
}

const SECTIONS: [string, string, string][] = [
  ['look', 'palette', 'Оформление'],
  ['fx', 'spark', 'Анимации и эффекты'],
  ['play', 'wave', 'Воспроизведение'],
  ['lib', 'lib', 'Медиатека'],
  ['covers', 'image', 'Обложки и тэги'],
  ['reports', 'clock', 'Отчёты'],
  ['discord', 'chat', 'Discord'],
  ['api', 'wave', 'Трансляция'],
  ['system', 'cpu', 'Система и ресурсы'],
  ['security', 'shield', 'Безопасность'],
  ['about', 'info', 'О программе'],
];

export function SettingsView() {
  const s = useStore((x) => x.settings);
  const p = usePrefs();
  const [devs, setDevs] = useState<string[]>([]);
  const [info, setInfo] = useState<{ version: string; data: string } | null>(null);
  const [gpu0] = useState(s.gpu);
  useEffect(() => { api.devices().then(setDevs).catch(() => {}); api.appInfo().then(setInfo).catch(() => {}); }, []);
  const jump = (id: string) => document.getElementById('set-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="set">
      <div className="ptitle">{tr('Настройки')}</div>
      <div className="snav">{SECTIONS.map(([id, ic, l]) => <button key={id} onClick={() => jump(id)}><Icon n={ic} s={14} />{tr(l)}</button>)}</div>

      <h3 id="set-look">{tr('Оформление')}</h3>
      <LayoutRow />
      <LangRow />
      <div className="themes">
        {themeEntries().map(([k, t]) => (
          <button key={k} className={'thm' + (themeKey(s.theme) === k ? ' on' : '')} onClick={() => save({ theme: k })}>
            <div className="prev" style={{ background: t.bg }}>
              <div className="ps" style={{ background: t.s1 }}><i style={{ background: t.acc }} /><i /><i /></div>
              <div className="pm">
                <div className="pc" style={{ background: `linear-gradient(135deg, ${t.acc}, ${t.acc2})` }} />
                <div className="pl" style={{ background: t.t1 }} /><div className="pl short" style={{ background: t.t1 }} />
                <div className="pb" style={{ background: t.acc }} />
              </div>
            </div>
            <span>{tr(t.name)}</span>
          </button>
        ))}
      </div>
      <Row t="Масштаб интерфейса"><Seg v={s.ui_scale} opts={[[0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%']]} onChange={(v) => save({ ui_scale: v })} /></Row>
      <Row t="Размер текста песен"><Range v={s.lyrics_size} min={0.8} max={1.6} step={0.05} fmt={(v) => Math.round(v * 100) + '%'} onChange={(v) => save({ lyrics_size: v })} /></Row>

      <h3 id="set-fx">{tr('Анимации и эффекты')}</h3>
      <Row t="Анимации" d="Переходы между экранами, наклон карточек, аура, плавное появление"><Seg v={s.anim} opts={[['full', 'Все'], ['reduced', 'Сдержанно'], ['off', 'Выкл']]} onChange={(v) => save({ anim: v })} /></Row>
      <Row t="Скорость анимаций"><Range v={s.anim_speed} min={0.5} max={2} step={0.1} fmt={(v) => v.toFixed(1) + '×'} onChange={(v) => save({ anim_speed: v })} /></Row>
      <Row t="Аура и свечение обложки" d="Размытый фон из цветов текущей обложки, пульсирует в такт басу"><Toggle on={s.glow} onChange={(v) => save({ glow: v })} /></Row>
      <Row t="Эффект матового стекла" d="Размытие под всплывающими панелями"><Toggle on={s.blur} onChange={(v) => save({ blur: v })} /></Row>
      <Row t="Визуализатор спектра" d="Считается в аудиодвижке, работает только когда окно видно и музыка играет"><Toggle on={s.visualizer} onChange={(v) => save({ visualizer: v })} /></Row>
      <VizQualityRow />
      <VizSceneRows />

      <h3 id="set-play">{tr('Воспроизведение')}</h3>
      <Row t="Устройство вывода" d="WASAPI (общий режим)">
        <select value={s.device} onChange={(e) => save({ device: e.target.value })}><option value="">{tr('По умолчанию')}</option>{devs.map((d) => <option key={d} value={d}>{d}</option>)}</select>
      </Row>
      <Row t="Выравнивание громкости" d={<LevelNote />}>
        <select value={s.replaygain} onChange={(e) => save({ replaygain: e.target.value as 'off' })}><option value="off">{tr('Выкл')}</option><option value="track">{tr('По треку')}</option><option value="album">{tr('По альбому')}</option></select>
      </Row>
      <div className="srow col">
        <div><b>{tr('Переход между треками')}</b><span>{tr('Как один трек сменяет другой при автоматическом переключении')}</span></div>
        <div className="xfs">
          {XF.map(([m, name, desc]) => (
            <button key={m} className={'xf' + (s.xf_mode === m ? ' on' : '')} onClick={() => save({ xf_mode: m })}>
              <XfCurve mode={m} />
              <b>{tr(name)}</b><span>{tr(desc)}</span>
            </button>
          ))}
        </div>
      </div>
      {s.xf_mode !== 0 && <>
        <Row t="Длительность перехода"><Range v={s.xf_ms / 1000} min={1} max={12} step={0.5} fmt={(v) => v.toFixed(1) + tr(' с')} onChange={(v) => save({ xf_ms: Math.round(v * 1000) })} /></Row>
        <Row t="Не смешивать треки одного альбома" d="Концертные и бесшовные альбомы остаются без пауз (gapless)"><Toggle on={s.xf_keep_album} onChange={(v) => save({ xf_keep_album: v })} /></Row>
      </>}
      <Row t="Плавная пауза" d="Затухание при паузе и нарастание при продолжении"><Range v={s.fade_ms} min={0} max={1000} step={10} fmt={(v) => (v ? v + tr(' мс') : tr('выкл'))} onChange={(v) => save({ fade_ms: Math.max(5, v) })} /></Row>
      <Row t="Мягкое переключение вручную" d="Короткий фейд при перемотке и переключении треков вместо резкого обрыва"><Toggle on={s.skip_fade} onChange={(v) => save({ skip_fade: v })} /></Row>
      <Row t="Запоминать позицию" d="После перезапуска продолжать с того же трека и той же секунды"><Toggle on={s.remember_pos} onChange={(v) => save({ remember_pos: v })} /></Row>
      <Row t="Продолжать играть при запуске" d="Сразу включать воспроизведение, а не ставить на паузу"><Toggle on={s.resume_on_start} onChange={(v) => save({ resume_on_start: v })} /></Row>

      <h3 id="set-lib">{tr('Медиатека')}</h3>
      <Row t="Папки с музыкой" d="Добавление, удаление, пересканирование"><button className="btn" onClick={() => navigate({ kind: 'folders' })}>{tr('Открыть')}<Icon n="chev" /></button></Row>
      <ReprocessRow />
      <ListAlbumRow />
      <HintsRow />
      <DownloadRow />

      <h3 id="set-covers">{tr('Обложки и тэги')}</h3>
      <Row t="Автоматически создавать обложки" d="Для альбомов без своей обложки — в фоне, при первом проигрывании"><Toggle on={s.auto_gen} onChange={(v) => save({ auto_gen: v })} /></Row>
      <CoverStyleRow />
      <Row t="Качество генерации" d="«Быстро» — меньше разрешение и без зерна, почти нулевая нагрузка"><Seg v={s.cover_quality} opts={[['high', 'Высокое'], ['fast', 'Быстро']]} onChange={(v) => save({ cover_quality: v })} /></Row>
      <Row t="Тэги из интернета" d="Для альбомов без тэгов — iTunes и Deezer, по одному альбому в фоне. Не нашлось — тэг определяется по звучанию"><Toggle on={s.web_genres} onChange={(v) => save({ web_genres: v })} /></Row>
      <Row t="Фоновый анализ медиатеки" d="Заранее определяет тэги, темп и энергию альбомов — по одному, с самым низким приоритетом процессора и диска"><Toggle on={s.bg_analysis} onChange={(v) => save({ bg_analysis: v })} /></Row>
      <div className="note"><Icon n="info" s={14} />{tr('Анализ трека занимает ~20–40 мс: декодируются три фрагмента по 8 с, звук прореживается до 11 кГц. Генерация рисуется на видеокарте в отдельном потоке и не тормозит интерфейс. «Пересоздать обложку» — в меню «⋯» у любого трека.')}</div>

      <h3 id="set-reports">{tr('Отчёты')}</h3>
      <ReportsRow />

      <h3 id="set-discord">Discord</h3>
      <DiscordSection d={s.discord} offline={s.offline} />

      <h3 id="set-api">{tr('Трансляция для других программ')}</h3>
      <ApiSection />

      <h3 id="set-system">{tr('Система и ресурсы')}</h3>
      <Row t="Закрывать в трей" d="Крестик прячет окно, музыка продолжает играть"><Toggle on={s.close_to_tray} onChange={(v) => save({ close_to_tray: v })} /></Row>
      <Row t="Экономия ресурсов в трее" d="Скрытый интерфейс замораживается и освобождает память; остаётся только аудиодвижок"><Toggle on={s.low_power_tray} onChange={(v) => save({ low_power_tray: v })} /></Row>
      <Row t="Запускать вместе с Windows"><Toggle on={s.autostart} onChange={(v) => save({ autostart: v })} /></Row>
      <Row t="Запускать свёрнутым в трей"><Toggle on={s.start_minimized} onChange={(v) => save({ start_minimized: v })} /></Row>
      <Row t="Аппаратное ускорение (GPU)" d="Отрисовка интерфейса, анимаций и обложек на видеокарте. Применяется после перезапуска">
        {s.gpu !== gpu0 && <button className="btn pri" onClick={() => api.restart()}><Icon n="refresh" />{tr('Перезапустить')}</button>}
        <Toggle on={s.gpu} onChange={(v) => save({ gpu: v })} />
      </Row>
      <Row t="Свернуть в трей сейчас"><button className="btn" onClick={() => api.hideToTray()}>{tr('Свернуть')}</button></Row>

      <h3 id="set-security">{tr('Безопасность и приватность')}</h3>
      <Row t="Офлайн-режим" d="Полностью отключает сеть: поиск текстов (LRCLIB) и обложек для Discord"><Toggle on={s.offline} onChange={(v) => save({ offline: v })} /></Row>
      <Row t="Защита файлов от записи" d="Запрещает любые изменения музыкальных файлов: встраивание обложек и сохранение .lrc"><Toggle on={s.write_protect} onChange={(v) => save({ write_protect: v })} /></Row>
      <Row t="Кэш обложек" d="Уменьшенные копии обложек; создаются заново автоматически"><button className="btn" onClick={() => api.clearCache('covers').then(() => toast(tr('Кэш обложек очищен')))}><Icon n="trash" />{tr('Очистить')}</button></Row>
      <Row t="Кэш текстов песен"><button className="btn" onClick={() => api.clearCache('lyrics').then(() => toast(tr('Кэш текстов очищен')))}><Icon n="trash" />{tr('Очистить')}</button></Row>
      <div className="note"><Icon n="shield" s={14} />{tr('Интерфейс работает со строгой политикой CSP: никаких внешних скриптов, только локальные файлы. Сеть используется только для LRCLIB, iTunes (обложки для Discord) и кнопки «Скачать» (YouTube Music) и полностью выключается офлайн-режимом. Discord подключается через локальный канал, без интернета с нашей стороны.')}</div>

      <h3 id="set-about">{tr('О программе')}</h3>
      <div onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) versionTap(); }}>
        <Row t={`Teto Player ${info?.version ?? ''}`} d="Локальный музыкальный плеер. Ваши файлы не изменяются без явного действия.">
          {info && isTauri && <button className="btn" onClick={() => api.revealFile(info.data)}><Icon n="folder" />{tr('Папка данных')}</button>}
        </Row>
      </div>
      <AuthorRow />
      {p.dev && <DevSection />}
    </div>
  );
}

/** ReplayGain tags, and (like the phone) measured loudness for songs without them. */
function LevelNote() {
  const [st, setSt] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => { call<{ done: number; total: number }>('level_stats').then(setSt).catch(() => {}); }, []);
  return <>{tr('По тегам ReplayGain; песни без тегов измеряются в фоне (EBU R128, ≈ −18 LUFS)')}{st && st.total > 0 ? ' · ' + tr('измерено {0} из {1}', st.done, st.total) : ''}</>;
}

const XF: [number, string, string][] = [
  [0, 'Без пауз', 'Gapless, трек за треком'],
  [1, 'Кроссфейд', 'Равномощное наложение'],
  [2, 'Линейный', 'Ровное перетекание'],
  [3, 'Провал', 'Затухание, затем вход'],
  [4, 'DJ-переход', 'Срез баса и раскрытие фильтра'],
];

function XfCurve({ mode }: { mode: number }) {
  const pts = (f: (t: number) => number) => Array.from({ length: 21 }, (_, i) => { const t = i / 20; return `${4 + t * 72},${30 - f(t) * 24}`; }).join(' ');
  const sm = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
  const curves: Record<number, [(t: number) => number, (t: number) => number]> = {
    1: [(t) => Math.cos(t * Math.PI / 2), (t) => Math.sin(t * Math.PI / 2)],
    2: [(t) => 1 - t, (t) => t],
    3: [(t) => 1 - sm(t / 0.55), (t) => sm((t - 0.45) / 0.55)],
    4: [(t) => (t < 0.7 ? 1 - t * 0.25 : Math.cos(((t - 0.7) / 0.3) * Math.PI / 2) * 0.825), (t) => sm(t / 0.35)],
  };
  return (
    <svg viewBox="0 0 80 34" className="xfc">
      {mode === 0 ? <><path d="M4 6H40V30" className="a" /><path d="M40 30V6H76" className="b" /></>
        : <><polyline points={pts(curves[mode][0])} className="a" /><polyline points={pts(curves[mode][1])} className="b" /></>}
    </svg>
  );
}

// ---------------- Discord ----------------
const VARS = ['{title}', '{artist}', '{album}', '{year}', '{genre}', '{format}'];
const BTN_PRESETS: [string, string][] = [
  ['Найти на YouTube', 'https://www.youtube.com/results?search_query={query}'],
  ['Яндекс Музыка', 'https://music.yandex.ru/search?text={query}'],
  ['Spotify', 'https://open.spotify.com/search/{query}'],
];
const SAMPLE: Track = { id: 0, path: '', title: 'Fukkireta', artist: 'Kasane Teto', album: 'Teto Territory', album_id: -1, disc: 1, no: 1, dur: 211, codec: 'FLAC', bits: 24, rate: 48000, kbps: 0, lossless: true, genre: 'J-Pop', year: 2024, fav: false };

function DiscordSection({ d, offline }: { d: DiscordCfg; offline: boolean }) {
  const set = (p: Partial<DiscordCfg>) => save({ discord: { ...getState().settings.discord, ...p } });
  const [status, setStatus] = useState('');
  const focus = useRef<{ key: keyof DiscordCfg; el: HTMLInputElement } | null>(null);
  useEffect(() => {
    let live = true;
    const poll = () => api.discordStatus().then((x) => live && setStatus(x)).catch(() => {});
    poll();
    const t = setInterval(poll, 2000);
    return () => { live = false; clearInterval(t); };
  }, [d.enabled, d.client_id]);
  const ok = status.startsWith('Подключено');
  const insertVar = (v: string) => {
    const f = focus.current;
    const key = f?.key ?? 'details';
    const cur = String(getState().settings.discord[key] ?? '');
    const pos = f?.el.selectionStart ?? cur.length;
    set({ [key]: cur.slice(0, pos) + v + cur.slice(pos) } as Partial<DiscordCfg>);
  };
  const field = (key: 'details' | 'state' | 'large_text', placeholder: string) => (
    <input className="inp" defaultValue={d[key]} key={d[key]} placeholder={placeholder} spellCheck={false}
      onFocus={(e) => (focus.current = { key, el: e.currentTarget })}
      onBlur={(e) => e.currentTarget.value !== d[key] && set({ [key]: e.currentTarget.value })}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
  );
  return (
    <div className="dsc">
      <div className="dcol">
        <Row t="Rich Presence" d={<span className={'dst' + (ok ? ' ok' : '')}><i />{d.enabled ? status || '…' : tr('Показывать в Discord, что сейчас играет')}</span>}>
          <Toggle on={d.enabled} onChange={(v) => set({ enabled: v })} />
        </Row>
        <div className="srow col">
          <div><b>Application ID</b><span>{tr('Создайте приложение на discord.com/developers/applications и назовите его «Teto Player» — это имя появится в статусе «Слушает …». Скопируйте Application ID сюда. Свои картинки (logo, play, pause) загружаются там же: Rich Presence → Art Assets.')}</span></div>
          <Text v={d.client_id} onChange={(v) => set({ client_id: v.replace(/\D/g, '') })} placeholder={tr('например 1234567890123456789')} mono />
        </div>
        <div className="srow col">
          <div><b>{tr('Текст статуса')}</b><span>{tr('Нажмите на переменную, чтобы вставить её в выбранное поле')}</span></div>
          <div className="vars-chips">{VARS.map((v) => <button key={v} className="chip mono" onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v)}>{v}</button>)}</div>
          <label className="fl">{tr('Первая строка')}{field('details', '{title}')}</label>
          <label className="fl">{tr('Вторая строка')}{field('state', '{artist}')}</label>
          <label className="fl">{tr('Подсказка при наведении на обложку')}{field('large_text', '{album} · {year}')}</label>
        </div>
        <Row t="Обложка" d={d.large_image === 'itunes' ? (offline ? tr('Офлайн-режим: будет использован ключ картинки') : tr('Ищется по исполнителю и альбому в каталоге iTunes')) : d.large_image === 'asset' ? tr('Картинка из Art Assets вашего приложения') : undefined}>
          {d.large_image !== 'none' && <Text v={d.asset_key} onChange={(v) => set({ asset_key: v })} placeholder={tr('ключ')} width={110} />}
          <select value={d.large_image} onChange={(e) => set({ large_image: e.target.value as DiscordCfg['large_image'] })}>
            <option value="itunes">{tr('Обложка альбома')}</option><option value="asset">{tr('Своя картинка')}</option><option value="none">{tr('Без картинки')}</option>
          </select>
        </Row>
        <Row t="Значок состояния" d="Маленькая иконка ▶ / ❚❚ поверх обложки (ключи из Art Assets)">
          {d.small === 'state' && <><Text v={d.play_key} onChange={(v) => set({ play_key: v })} width={80} /><Text v={d.pause_key} onChange={(v) => set({ pause_key: v })} width={80} /></>}
          <Toggle on={d.small === 'state'} onChange={(v) => set({ small: v ? 'state' : 'none' })} />
        </Row>
        <Row t="Время"><Seg v={d.timestamps} opts={[['progress', 'Полоса прогресса'], ['elapsed', 'Прошло'], ['none', 'Нет']]} onChange={(v) => set({ timestamps: v })} /></Row>
        <Row t="Имя в списке участников" d="Что показывать рядом с вашим ником: «Слушает …»"><Seg v={d.status_display} opts={[[0, 'Teto Player'], [1, 'Исполнитель'], [2, 'Трек']]} onChange={(v) => set({ status_display: v })} /></Row>
        <Row t="На паузе"><Seg v={d.paused} opts={[['show', 'Показывать'], ['clear', 'Скрывать']]} onChange={(v) => set({ paused: v })} /></Row>
        {d.paused === 'show' && <Row t="Скрывать после долгой паузы"><Range v={d.idle_min} min={0} max={60} step={1} fmt={(v) => (v ? v + ' мин' : tr('никогда'))} onChange={(v) => set({ idle_min: v })} /></Row>}
        <div className="srow col">
          <div><b>{tr('Кнопки')}</b><span>До двух кнопок со ссылками. В адресе можно использовать {'{query}'} — «исполнитель + трек»</span></div>
          {d.buttons.map((b, i) => (
            <div className="btnrow" key={i}>
              <Text v={b.label} onChange={(v) => set({ buttons: d.buttons.map((x, j) => (j === i ? { ...x, label: v } : x)) })} placeholder={tr('Текст')} width={150} />
              <Text v={b.url} onChange={(v) => set({ buttons: d.buttons.map((x, j) => (j === i ? { ...x, url: v } : x)) })} placeholder="https://…" mono />
              <button className="ib" onClick={() => set({ buttons: d.buttons.filter((_, j) => j !== i) })}><Icon n="trash" s={15} /></button>
            </div>
          ))}
          {d.buttons.length < 2 && (
            <div className="vars-chips">
              {BTN_PRESETS.map(([l, u]) => <button key={l} className="chip" onClick={() => set({ buttons: [...d.buttons, { label: l, url: u }] })}>+ {l}</button>)}
              <button className="chip" onClick={() => set({ buttons: [...d.buttons, { label: '', url: 'https://' }] })}>{tr('+ Своя')}</button>
            </div>
          )}
        </div>
      </div>
      <DiscordPreview d={d} />
    </div>
  );
}

function fill(tpl: string, t: Track, fmt: string) {
  return tpl.replace(/\{title\}/g, t.title).replace(/\{artist\}/g, t.artist).replace(/\{album\}/g, t.album).replace(/\{year\}/g, t.year ? String(t.year) : '')
    .replace(/\{genre\}/g, t.genre).replace(/\{format\}/g, fmt).replace(/\{codec\}/g, t.codec).trim().replace(/^·\s*|\s*·$/g, '').trim();
}

function DiscordPreview({ d }: { d: DiscordCfg }) {
  const p = useStore((s) => s.player);
  const album = useStore((s) => s.currentAlbum);
  const [, tick] = useState(0);
  const [art, setArt] = useState<string | null>(null);
  const t = p.track ?? SAMPLE;
  const sample = !p.track;
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i); }, []);
  useEffect(() => {
    setArt(null);
    if (sample || d.large_image !== 'itunes') return;
    let n = 0;
    const get = () => api.discordPreview().then((r) => {
      const img = (r?.activity as { assets?: { large_image?: string } } | null)?.assets?.large_image;
      if (img && img.startsWith('https://')) setArt(img);
      else if (++n < 5) setTimeout(get, 1500);
    }).catch(() => {});
    get();
  }, [t.album_id, d.large_image, d.enabled, sample]);
  const playing = sample ? true : p.playing;
  const pos = sample ? 74 : livePos(getState());
  const dur = t.dur;
  const details = fill(d.details, t, p.output || 'FLAC 24/48');
  let state = fill(d.state, t, p.output || 'FLAC 24/48');
  if (!playing) state = state ? '⏸ ' + state : tr('На паузе');
  const large = fill(d.large_text, t, p.output);
  const name = d.status_display === 1 ? t.artist : d.status_display === 2 ? t.title : 'Teto Player';
  const hidden = !playing && d.paused === 'clear';
  return (
    <div className="dprev">
      <div className="dcap">{tr('Предпросмотр')}{sample && <span> {tr('· пример')}</span>}</div>
      <div className="dcard">
        <div className="dbanner" />
        <div className="dav"><div className="dava" /><i className="don" /></div>
        <div className="dname">you<span>{tr('Слушает {0}', name)}</span></div>
        {hidden ? <div className="dempty">{tr('На паузе статус скрыт')}</div> : (
          <div className="dact">
            <div className="dh">{tr('Слушает Teto Player')}</div>
            <div className="drow">
              {d.large_image !== 'none' && (
                <div className="dimg" title={large}>
                  {art ? <img src={art} alt="" /> : <Cover a={sample ? { id: -1, cover: null, recipe: null, title: t.album, artist: t.artist, genre: t.genre } : album ?? { id: t.album_id, cover: null, recipe: null }} size={88} eager className="cv" />}
                  {d.small === 'state' && <i className="dsm"><Icon n={playing ? 'play' : 'pause'} s={10} /></i>}
                </div>
              )}
              <div className="dtx">
                {details && <b>{details}</b>}
                {state && <span>{state}</span>}
                {d.large_image !== 'none' && large && <span className="dim">{large}</span>}
                {playing && d.timestamps === 'elapsed' && <span className="dim">{tr('{0} прошло', fmtTime(pos))}</span>}
              </div>
            </div>
            {playing && d.timestamps === 'progress' && dur > 0 && (
              <div className="dprog"><span>{fmtTime(pos)}</span><div><b style={{ width: `${Math.min(100, (pos / dur) * 100)}%` }} /></div><span>{fmtTime(dur)}</span></div>
            )}
            {d.buttons.filter((b) => b.label.trim()).slice(0, 2).map((b, i) => <div key={i} className="dbtn">{fill(b.label, t, '')}</div>)}
          </div>
        )}
      </div>
      <div className="dnote">{tr('Discord обновляет статус не чаще раза в 4 секунды — это ограничение Discord.')}</div>
    </div>
  );
}
