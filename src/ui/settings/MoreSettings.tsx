/** Settings rows shared by the phone and the desktop settings. */
import { api, call, isMobile } from '../../app/api';
import { useEffect, useState } from 'react';
import { getState, navigate, setState, toast, useStore } from '../../app/store';
import { Icon } from '../icons';
import { reprocessAll } from '../../core/reprocess';
import { nextWindow, reportMonths, reportWindow, showReport, useReportWindow } from '../../report/schedule';
import { NET_SOURCES } from '../../core/download';
import { monthName } from '../../report/data';
import { prefs, setPrefs } from '../../core/prefs';
import { syncCoverLook } from '../../cover/gen';
import { isIOS } from '../../app/platform';
import { usePrefsLite } from '../../core/prefsHook';
import { t, isEn } from '../../i18n';
import { LAYOUTS, LAYOUT_THEME, THEME_LIST, themeKey } from '../../core/look';
import { SCENES } from '../../viz/scenes';
import THEMES from '../../styles/themes.json';

const Toggle = ({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) => <button className={'tg' + (on ? ' on' : '')} onClick={() => onChange(!on)} />;
const Row = ({ title, d, children }: { title: string; d?: React.ReactNode; children?: React.ReactNode }) => (
  <div className="srow"><div><b>{title}</b>{d && <span>{d}</span>}</div>{children}</div>
);
const saveTheme = async (theme: string) => setState({ settings: await api.setSettings({ theme }) });

/** Layout ("разметка"): the shapes, fonts and philosophy of the UI. The colour theme stays separate. */
export function LayoutRow() {
  const p = usePrefsLite();
  const theme = useStore((s) => themeKey(s.settings.theme));
  const want = LAYOUT_THEME[p.layout];
  const desc: Record<string, string> = {
    default: 'Мягкие формы и аура Teto',
    nothing: 'Точечный шрифт, монохром, строгие линии — в духе Nothing OS',
    apple: 'Крупные заголовки, стекло и скругления — в духе Apple Music',
  };
  return (
    <>
      <Row title={t('Разметка')} d={t(desc[p.layout] ?? desc.default)}>
        <div className="seg">{LAYOUTS.map(([k, l]) => <button key={k} className={p.layout === k ? 'on' : ''} onClick={() => setPrefs({ layout: k })}>{l}</button>)}</div>
      </Row>
      {p.layout !== 'default' && want && want !== theme && THEME_LIST[want] && (
        <div className="note"><span>{t('К этой разметке лучше всего подходит тема «{0}».', t(THEME_LIST[want].name))}{' '}
          <a style={{ color: 'var(--mint)', cursor: 'pointer' }} onClick={() => saveTheme(want)}>{t('Применить')}</a></span></div>
      )}
    </>
  );
}

export function LangRow() {
  const p = usePrefsLite();
  return (
    <Row title={t('Язык')} d="Русский · English">
      <div className="seg">{([['ru', 'Русский'], ['en', 'English']] as const).map(([k, l]) => <button key={k} className={p.lang === k ? 'on' : ''} onClick={() => setPrefs({ lang: k })}>{l}</button>)}</div>
    </Row>
  );
}

export function VizSceneRows() {
  const p = usePrefsLite();
  return (
    <>
      <Row title={t('Сцена 3D-визуализации')} d={t('С какой сцены начинать')}>
        <select value={p.vizScene} onChange={(e) => { setPrefs({ vizScene: +e.target.value }); if (p.coverStyle === 'viz') resyncCovers(); }}>
          <option value={-1}>{t('Случайная')}</option>
          {SCENES.map((n, i) => <option key={n} value={i}>{t(n)}</option>)}
        </select>
      </Row>
      <Row title={t('Менять сцену по нажатию')} d={p.vizTap ? t('Нажатие — следующая сцена, двойное — закрыть. Сами сцены не меняются') : t('Сцены меняются сами примерно раз в минуту и при смене трека')}>
        <Toggle on={p.vizTap} onChange={(v) => setPrefs({ vizTap: v })} />
      </Row>
      <Row title={t('Чувствительность визуализации')} d={t('Насколько живо сцены откликаются на звук: 0,5 — спокойно, 2,5 — очень активно. Тихие треки подтягиваются сами')}>
        <div className="vgain">
          <input type="range" min={0.5} max={2.5} step={0.1} value={p.vizSens} onChange={(e) => setPrefs({ vizSens: +e.target.value })} />
          <span className="mono">{p.vizSens.toFixed(1)}</span>
        </div>
      </Row>
    </>
  );
}

export function HintsRow() {
  const p = usePrefsLite();
  return (
    <Row title={t('Подсказки')} d={t('На странице альбома показывать песни, которых нет в медиатеке, с кнопкой «Скачать» (список треков — из iTunes)')}>
      <Toggle on={p.hints} onChange={(v) => setPrefs({ hints: v })} />
    </Row>
  );
}

/** Theme picker list (removed themes are gone; light ones are marked). */
export const themeEntries = () => Object.entries(THEMES as Record<string, { name: string; bg: string; s1: string; s2: string; acc: string; acc2: string; t1: string; light?: boolean }>);

export function ListAlbumRow() {
  const p = usePrefsLite();
  return (
    <Row title={t('Альбом в списке песен')} d={p.listAlbum ? t('У каждой песни указан её альбом') : t('Альбом не упоминается — только название и исполнитель')}>
      <Toggle on={p.listAlbum} onChange={(v) => setPrefs({ listAlbum: v })} />
    </Row>
  );
}

/** "Reprocess all files": covers, names and tags are worked out again for the whole library. */
export function ReprocessRow() {
  const [busy, setBusy] = useState(false);
  const scan = useStore((s) => s.scan);
  const run = () => setState({ dialog: {
    title: t('Переработать все файлы?'),
    text: t('Заново: обложки для песен без обложки, разбор названий и исполнителей, определение тэгов. Ваши правки, свои обложки, свои тэги, любимое и плейлисты останутся. Может занять несколько минут.'),
    ok: t('Переработать'),
    onOk: async () => {
      setBusy(true);
      try { await reprocessAll(); toast(t('Готово: медиатека переработана. Тэги из интернета подтянутся в фоне')); } catch (e) { toast(String(e)); } finally { setBusy(false); }
    },
  } });
  const going = busy || scan.state === 'scanning';
  return (
    <Row title={t('Переработать все файлы')} d={going && scan.total ? t('{0} из {1}', scan.done, scan.total) : t('Заново создать обложки, разобрать названия и определить тэги для всех песен')}>
      <button className="btn" disabled={going} onClick={run}><Icon n="refresh" />{going ? t('Идёт…') : t('Запустить')}</button>
    </Row>
  );
}

/** Covers are redrawn on demand in the current theme and style; the cache of the old look is dropped. */
const resyncCovers = () => setTimeout(() => syncCoverLook(themeKey(getState().settings.theme), prefs().coverStyle), 0);

/** Generated covers: the classic compositions or a still frame of the chosen 3D visualization. */
export function CoverStyleRow() {
  const p = usePrefsLite();
  const theme = useStore((s) => themeKey(s.settings.theme));
  const pick = (v: 'classic' | 'viz') => { setPrefs({ coverStyle: v }); syncCoverLook(theme, v); };
  return (
    <Row title={t('Стиль обложек')} d={p.coverStyle === 'viz' ? t('Созданные обложки — кадр 3D-визуализации (выбранной сцены) в цветах темы') : t('Созданные обложки — абстрактные композиции в цветах темы')}>
      <div className="seg">{([['classic', t('Классика')], ['viz', t('Как 3D')]] as const).map(([k, l]) => <button key={k} className={p.coverStyle === k ? 'on' : ''} onClick={() => pick(k)}>{l}</button>)}</div>
    </Row>
  );
}

const BROWSERS: [string, string][] = [['', '—'], ['firefox', 'Firefox'], ['chrome', 'Chrome'], ['edge', 'Edge'], ['brave', 'Brave'], ['opera', 'Opera'], ['vivaldi', 'Vivaldi'], ['chromium', 'Chromium']];

const SRC_DESC: Record<string, string> = {
  all: 'YouTube Music, YouTube, SoundCloud и ВК (если подключён) — сразу везде, лучшие совпадения сверху',
  youtube: 'YouTube Music и YouTube: студийные версии и почти всё, что выходило',
  soundcloud: 'SoundCloud: быстро, MP3 с обложкой; бывают не все треки',
  vk: 'Только ВК Музыка — нужен вход ниже',
};

/** Downloading lives in the ordinary search: type a name, press Enter. Phone: where from, format, VK. Desktop: yt-dlp + browser cookies. */
export function DownloadRow() {
  const p = usePrefsLite();
  const src = p.dlSrc ?? 'all';
  return (
    <>
      <Row title={t('Откуда качать')} d={t(SRC_DESC[isMobile ? src : src === 'vk' ? 'all' : src] ?? SRC_DESC.all) + '. ' + t('Ищите в обычном поиске: введите название и нажмите «Найти» (Enter) на клавиатуре')}>
        <select value={!isMobile && src === 'vk' ? 'all' : src} onChange={(e) => setPrefs({ dlSrc: e.target.value as 'all' })}>
          {NET_SOURCES.filter(([k]) => isMobile || k !== 'vk').map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
        </select>
      </Row>
      {!isMobile && (
        <Row title={t('Скачивание')} d={t('Экран «Скачать»: YouTube, SoundCloud и ссылки Spotify — с прогрессом, тегами и обложкой. Песни сохраняются в папку Teto Downloads')}>
          <button className="btn" onClick={() => navigate({ kind: 'download' })}><Icon n="download" s={14} />{t('Открыть')}</button>
        </Row>
      )}
      {isMobile && !isIOS && (
        <Row title={t('Формат скачанного')} d={p.dlKbps ? t('MP3 выбранного битрейта: перекодирование, дольше') : t('Оригинал без перекодирования (M4A / MP3) — в разы быстрее, качество как у источника')}>
          <select value={p.dlKbps} onChange={(e) => setPrefs({ dlKbps: +e.target.value })}>
            <option value={0}>{t('Оригинал · быстро')}</option>
            {[128, 192, 256, 320].map((k) => <option key={k} value={k}>MP3 {k} kbps</option>)}
          </select>
        </Row>
      )}
      {isMobile && <VkRow />}
      {!isMobile && (
        <Row title={t('Аккаунт YouTube из браузера')} d={t('Необязательно. Cookies входа берутся из выбранного браузера (лучше всего Firefox; Chrome и Edge нужно закрыть)')}>
          <select value={p.ytBrowser} onChange={(e) => setPrefs({ ytBrowser: e.target.value })}>
            {BROWSERS.map(([k, l]) => <option key={k} value={k}>{k ? l : t('Без входа')}</option>)}
          </select>
        </Row>
      )}
    </>
  );
}

/** Developer mode, Android: the yt-dlp engine (YouTube / SoundCloud / links) — version and manual update. */
export function YtEngineRow() {
  const [eng, setEng] = useState<{ ready: boolean; updating: boolean; version: string; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call<typeof eng>('dl_engine').then(setEng).catch(() => setEng(null)); }, []);
  const update = async () => {
    setBusy(true);
    try { const r = await call<{ version: string }>('dl_update'); setEng((e) => (e ? { ...e, ready: true, version: r.version } : e)); toast(t('yt-dlp обновлён: {0}', r.version)); }
    catch (e) { toast(String((e as Error)?.message ?? e)); } finally { setBusy(false); }
  };
  return (
    <Row title={t('Движок yt-dlp')} d={!eng ? '…' : eng.error ? t('Не запустился: {0}', eng.error) : !eng.ready ? (eng.updating ? t('Обновляется…') : t('Запускается…')) : t('Версия {0} · обновляется сам раз в день', eng.version || '?')}>
      <button className="btn" disabled={busy || !eng?.ready} onClick={update}>{busy ? t('Обновляю…') : t('Обновить')}</button>
    </Row>
  );
}

const saveS = async (p: Partial<import('../../core/types').Settings>) => setState({ settings: await api.setSettings(p) });

/** Developer mode: interface animations. */
export function AnimRow() {
  const s = useStore((x) => x.settings);
  return <Row title={t('Анимации')}><div className="seg">{([['full', 'Все'], ['reduced', 'Меньше'], ['off', 'Выкл']] as const).map(([k, l]) => <button key={k} className={s.anim === k ? 'on' : ''} onClick={() => saveS({ anim: k })}>{t(l)}</button>)}</div></Row>;
}
/** Developer mode: genres from iTunes / Deezer for songs without tags. */
export function WebTagsRow() {
  const s = useStore((x) => x.settings);
  return <Row title={t('Тэги из интернета')} d={t('Для песен без тэгов — iTunes и Deezer; не нашлось — по звучанию. Пока приложение открыто')}><Toggle on={s.web_genres && !s.offline} onChange={(v) => saveS(v ? { web_genres: true, offline: false } : { web_genres: false })} /></Row>;
}
/** Developer mode: lyrics from LRCLIB (off = no network at all). */
export function LyricsNetRow() {
  const s = useStore((x) => x.settings);
  return <Row title={t('Искать тексты в интернете')} d={t('LRCLIB, синхронизированные строки')}><Toggle on={!s.offline} onChange={(v) => saveS({ offline: !v })} /></Row>;
}
export function LyricsCacheRow() {
  return <Row title={t('Кэш текстов')}><button className="btn" onClick={() => api.clearCache('lyrics').then(() => toast(t('Кэш очищен')))}><Icon n="trash" />{t('Очистить')}</button></Row>;
}

/** Phone: VK Music as an extra source for search, downloads and album track lists ("Hints"). Off by default. */
function VkRow() {
  const [st, setSt] = useState<{ connected: boolean; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call<{ connected: boolean; name: string }>('vk_status').then(setSt).catch(() => setSt(null)); }, []);
  const login = async () => {
    setBusy(true);
    try { const r = await call<{ connected: boolean; name: string }>('vk_login'); setSt(r); toast(t('ВК подключён')); }
    catch (e) { const m = String((e as Error)?.message ?? e); if (!/отмен/i.test(m)) toast(t('ВК: {0}', m)); } finally { setBusy(false); }
  };
  const logout = async () => { await call('vk_logout'); setSt({ connected: false, name: '' }); toast(t('ВК отключён')); };
  return (
    <Row title={t('ВК Музыка')} d={st?.connected
      ? t('Подключено{0}: ВК ищется вместе с YouTube и SoundCloud, скачивается без перекодирования и помогает находить треклисты альбомов', st.name ? ` · ${st.name}` : '')
      : t('Экспериментально. С сентября 2026 ВК закрыл сторонним приложениям доступ к музыке, поэтому вход может не сработать — тогда качайте с YouTube и SoundCloud. Вход через официальное окно ВК, пароль Teto не видит')}>
      {st?.connected ? <button className="btn" onClick={logout}>{t('Отключить')}</button>
        : <button className="btn" disabled={busy} onClick={login}>{busy ? t('Вход…') : t('Подключить')}</button>}
    </Row>
  );
}

/** The monthly report: opens from the last day of the month through the 3rd of the next one. */
export function ReportsRow() {
  const w = useReportWindow();
  const win = reportWindow();
  const day = (d: Date) => d.toLocaleDateString(isEn() ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long' });
  const next = nextWindow();
  return (
    <Row title={t('Итоги месяца')} d={w
      ? t('Итоги: {0} — можно открыть до {1}', (isEn() ? w.label : w.label.toLowerCase()), day(w.until))
      : win ? t('В этом месяце почти ничего не прослушано — итогов не будет')
        : t('Откроются {0} и будут доступны до 3 числа: время с музыкой, любимые песни и исполнители, привычки', day(next))}>
      <button className="btn pri" disabled={!w} onClick={() => w && showReport(w.month)}><Icon n="sparkle" />{t('Открыть')}</button>
    </Row>
  );
}

/** Developer mode: reports of earlier months. */
export function ReportArchiveRow() {
  const [months, setMonths] = useState<string[] | null>(null);
  useEffect(() => { reportMonths().then(setMonths).catch(() => setMonths([])); }, []);
  return (
    <Row title={t('Архив отчётов')} d={t('Отчёты прошлых месяцев')}>
      {months && months.length > 0 ? (
        <select value="" onChange={(e) => { const m = e.target.value; if (m) showReport(m, true).then((ok) => { if (!ok) toast(t('За этот месяц почти ничего не прослушано')); }); }}>
          <option value="">{t('Выбрать')}</option>
          {months.map((m) => <option key={m} value={m}>{monthName(m)} {m.slice(0, 4)}</option>)}
        </select>
      ) : <span className="muted">—</span>}
    </Row>
  );
}

export const AUTHOR = 'KinkyWonder';
export function AuthorRow() {
  return <Row title={t('Автор')} d={t('Разработка и дизайн')}><b className="author">{AUTHOR}</b></Row>;
}
