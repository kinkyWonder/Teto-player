import { startReports } from '../report/schedule';
import { useEffect, useRef, useState } from 'react';
import { ArtistLinks } from '../core/artists';
import { isIOS } from '../app/platform';
import { App as CapApp } from '@capacitor/app';
import { api, call, on } from '../app/api';
import { Icon } from '../ui/icons';
import { getState, goBack, navigate, setState, toast, useStore, type View } from '../app/store';
import type { PlayerState, ScanStatus } from '../core/types';
import { addToFavs, deleteTracks, playlistMenu, refreshLibrary, tetoCross, toggleFav, togglePlay, toggleViz, trackMenu } from '../app/actions';
import { srcTitle } from '../core/teto';
import { onPlayer, applyLook, watchHidden } from '../app/App';
import { Cover, trackCover } from '../ui/Cover';
import { Logo } from '../ui/Logo';
import { Overlays } from '../ui/Chrome';
import { QueuePanel } from '../ui/Popovers';
import { Progress } from '../ui/PlayerBar';
import { LyricsBlock } from '../ui/NowPlaying';
import { VizFull } from '../ui/VizFull';
import { ScrollCtx } from '../ui/TrackTable';
import { AlbumsView, AlbumView, ArtistsView, ArtistView, CatalogView, FavsView, GenresView, GenreView, HomeView, PlaylistView, SearchView, TracksView } from '../ui/views';
import { MobileSettings } from './MobileSettings';
import { native } from './native';
import { isLightTheme } from '../core/look';
import { t } from '../i18n';
import { usePrefsLite } from '../core/prefsHook';
import { clearPick, pickAll, pickSource } from '../core/pick';
import { askNet } from '../ui/views/SearchOnline';
import { useDlJobs } from '../core/download';

type Tab = 'home' | 'catalog' | 'genres' | 'favs';
/** Bottom tabs: Home (Teto + albums), Catalog (playlists, artists, all tracks), Genres, Favourites. */
const TABS: [Tab, string, string][] = [['home', 'home', 'Главная'], ['catalog', 'grid', 'Каталог'], ['genres', 'genre', 'Тэги'], ['favs', 'heart', 'Любимое']];
const ROOT: Record<Tab, View> = { home: { kind: 'home' }, catalog: { kind: 'catalog' }, genres: { kind: 'genres' }, favs: { kind: 'favs' } };
const tabOf = (v: View): Tab | null =>
  v.kind === 'home' ? 'home'
    : v.kind === 'catalog' || v.kind === 'playlists' || v.kind === 'playlist' || v.kind === 'artists' || v.kind === 'tracks' || v.kind === 'albums' ? 'catalog'
      : v.kind === 'genres' || v.kind === 'genre' ? 'genres'
        : v.kind === 'favs' ? 'favs' : null;

export const importFiles = () => call('import_files').catch((e) => toast(String(e)));

export function MobileApp() {
  const lang = usePrefsLite().lang;
  return <Shell key={lang} />; // the whole UI re-renders in the new language
}

function Shell() {
  const view = useStore((s) => s.view);
  const empty = useStore((s) => s.stats.tracks === 0);
  const settings = useStore((s) => s.settings);
  const viz = useStore((s) => s.viz);
  const picking = useStore((s) => !!s.pick);
  const layout = usePrefsLite().layout;
  const [full, setFull] = useState(false);
  const [queue, setQueue] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const st = useRef({ full, queue, viz });
  st.current = { full, queue, viz };
  const lastTab = useRef<Tab>('home');

  useEffect(() => {
    (async () => {
      const [s, p] = await Promise.all([api.settings(), api.playerState()]);
      setState({ settings: s, view: getState().view.kind === 'albums' ? { kind: 'home' } : getState().view });
      await refreshLibrary();
      startReports();
      onPlayer(p);
    })();
    const un = [
      on<PlayerState>('player:state', onPlayer),
      on<{ pos: number }>('player:pos', (e) => setState({ pos: e.pos, posAt: performance.now() })),
      on<ScanStatus>('scan', (scan) => setState({ scan })),
      on<null>('library', () => refreshLibrary()),
      on<string>('player:error', (m) => toast(m)),
      on<string>('toast', (m) => toast(m)),
    ];
    const back = CapApp.addListener('backButton', () => {
      const s = getState(), c = st.current;
      if (s.menu) return setState({ menu: null });
      if (s.genreEdit) return setState({ genreEdit: null });
      if (s.dialog) return setState({ dialog: null });
      if (s.pick) return clearPick();
      if (c.viz) return toggleViz(false);
      if (c.queue) return setQueue(false);
      if (c.full) return setFull(false);
      if (s.back.length) return goBack();
      if (tabOf(s.view) !== 'home') return setState({ view: ROOT.home, back: [], fwd: [] });
      CapApp.minimizeApp();
    });
    return () => { un.forEach((p) => p.then((f) => f())); back.then((b) => b.remove()); };
  }, []);
  useEffect(watchHidden, []);
  useEffect(() => { applyLook(settings); native.barsFor(isLightTheme(settings.theme)); }, [settings.theme, settings.anim, settings.anim_speed, settings.glow, settings.blur, settings.lyrics_size, layout]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); clearPick(); setFull(false); }, [view]);

  const tab = tabOf(view) ?? (view.kind === 'settings' || view.kind === 'search' ? null : lastTab.current);
  if (tab) lastTab.current = tab;
  const go = (x: Tab) => {
    setFull(false);
    if (x === tab && view.kind === ROOT[x].kind) scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    else setState({ view: ROOT[x], back: [], fwd: [] });
  };

  let body: React.ReactNode;
  if (empty && !['settings', 'search', 'catalog', 'genres'].includes(view.kind)) body = <MobileEmpty />;
  else switch (view.kind) {
    case 'home': body = <HomeView />; break;
    case 'catalog': case 'playlists': body = <CatalogView />; break;
    case 'albums': body = <AlbumsView />; break;
    case 'album': body = <AlbumView id={view.id} />; break;
    case 'artists': body = <ArtistsView />; break;
    case 'artist': body = <ArtistView name={view.name} />; break;
    case 'tracks': body = <TracksView />; break;
    case 'favs': body = <FavsView />; break;
    case 'playlist': body = <PlaylistView id={view.id} />; break;
    case 'search': body = <SearchView q={view.q} net={view.net} meta={view.meta} />; break;
    case 'genres': body = <GenresView />; break;
    case 'genre': body = <GenreView name={view.name} />; break;
    case 'settings': body = <MobileSettings />; break;
    default: body = null;
  }

  return (
    <div className={'m-app win' + (picking ? ' picking' : '')}>
      {picking ? <PickHead /> : <Header />}
      <ScrollCtx.Provider value={scrollRef}>
        <div className="m-content" ref={scrollRef}><div className="page" key={JSON.stringify(view)}>{body}</div></div>
      </ScrollCtx.Provider>
      {picking ? <PickBar /> : <>
        <Mini onOpen={() => setFull(true)} />
        <nav className="m-tabs">
          {TABS.map(([x, ic, l]) => (
            <button key={x} className={tab === x ? 'on' : ''} onClick={() => go(x)}>
              {x === 'home' ? <span className="m-tlogo"><Logo s={22} /></span> : <Icon n={x === 'favs' && tab === x ? 'heartf' : ic} s={22} />}
              <span>{t(l)}</span>
            </button>
          ))}
        </nav>
      </>}
      {full && <FullPlayer onClose={() => setFull(false)} onQueue={() => setQueue(true)} />}
      {queue && <div className="m-scrim" onClick={(e) => e.target === e.currentTarget && setQueue(false)}><QueuePanel /></div>}
      <Overlays />
      <VizFull />
    </div>
  );
}

/** Search on top of every tab: the library on every letter; Enter (the keyboard's search key) — the internet too. */
function Header() {
  const view = useStore((s) => s.view);
  const back = useStore((s) => s.back.length);
  const scan = useStore((s) => s.scan);
  const jobs = useDlJobs();
  const active = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
  const [q, setQ] = useState(view.kind === 'search' ? view.q : '');
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { if (view.kind !== 'search') setQ(''); else if (view.q !== q) setQ(view.q); }, [view]);
  const onQ = (v: string) => {
    setQ(v);
    const s = getState();
    if (s.view.kind === 'search') setState({ view: { kind: 'search', q: v, meta: s.view.meta } });
    else navigate({ kind: 'search', q: v });
  };
  // a form: the keyboard's Enter / "search" key submits it on every phone keyboard (also mid-word in Russian),
  // and the value is read from the field itself, not from a possibly stale state
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = inp.current?.value ?? q;
    inp.current?.blur();
    if (v !== q) onQ(v);
    if (v.trim()) askNet(v);
  };
  const searching = view.kind === 'search';
  const atRoot = Object.values(ROOT).some((r) => r.kind === view.kind);
  return (
    <header className="m-head">
      {!atRoot ? <button className="m-ib" onClick={() => { if (searching) { setQ(''); inp.current?.blur(); } if (back) goBack(); else setState({ view: ROOT.home }); }}><Icon n="left" s={22} /></button>
        : <div className="m-brand"><Logo s={20} /></div>}
      <form className={'m-srch' + (searching ? ' on' : '')} onSubmit={submit} action="#">
        <Icon n="search" s={17} />
        <input ref={inp} type="search" value={q} placeholder={t('Поиск и скачивание')} enterKeyHint="search" onFocus={() => { if (!searching) navigate({ kind: 'search', q }); }}
          onChange={(e) => onQ(e.target.value)} spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off" />
        {q && <button type="button" onClick={() => { setQ(''); setState({ view: { kind: 'search', q: '' } }); inp.current?.focus(); }}><Icon n="x" s={16} /></button>}
      </form>
      {scan.state === 'scanning' && <span className="m-busy">{scan.done}/{scan.total}</span>}
      {!searching && <div className="m-hr">
        {active.length > 0 && <button className="m-ib m-dlb" title={t('Загрузки')} onClick={() => navigate({ kind: 'search', q: '' })}><Icon n="download" s={20} /><i>{active.length}</i></button>}
        <button className="m-ib" title={t('Добавить файлы')} onClick={importFiles}><Icon n="plus" s={22} /></button>
        <button className={'m-ib' + (view.kind === 'settings' ? ' on' : '')} title={t('Настройки')} onClick={() => navigate({ kind: 'settings' })}><Icon n="gear" s={20} /></button>
      </div>}
    </header>
  );
}

/** Multi-select (long press): header with the count and "select all". */
function PickHead() {
  const sel = useStore((s) => s.pick) ?? [];
  const src = pickSource().filter((x) => !x.missing);
  const all = src.length > 0 && src.every((x) => sel.some((y) => y.id === x.id));
  return (
    <header className="m-head m-pickh">
      <button className="m-ib" onClick={clearPick}><Icon n="x" s={22} /></button>
      <b>{t('Выбрано: {0}', sel.length)}</b>
      {src.length > 1 && <button className="m-txt" onClick={() => (all ? clearPick() : pickAll(src))}>{all ? t('Снять все') : t('Выбрать все')}</button>}
    </header>
  );
}

/** Multi-select actions: add to a playlist, play next, favourites, genres, delete. */
function PickBar() {
  const sel = useStore((s) => s.pick) ?? [];
  const ids = sel.map((x) => x.id);
  const acts: [string, string, (e: React.MouseEvent) => void, boolean?][] = [
    ['plus', 'В плейлист', (e) => playlistMenu(e, ids)],
    ['next1', 'Следующими', () => api.enqueue(ids, true).then(() => { toast(t('Будет играть следующим')); clearPick(); })],
    ['heart', 'В любимое', () => addToFavs(sel).then(clearPick)],
    ['genre', 'Тэги', () => setState({ genreEdit: sel })],
    ['trash', 'Удалить', () => deleteTracks(sel, clearPick), true],
  ];
  return (
    <nav className="m-tabs m-pickbar">
      {acts.map(([ic, l, f, danger]) => (
        <button key={l} className={danger ? 'danger' : ''} disabled={!sel.length} onClick={f}><Icon n={ic} s={21} /><span>{t(l)}</span></button>
      ))}
    </nav>
  );
}

function MiniProgress() {
  const dur = useStore((s) => s.player.dur);
  const playing = useStore((s) => s.player.playing);
  const pos0 = useStore((s) => s.pos);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const f = () => { const s = getState(); const p = s.pos + (s.player.playing ? (performance.now() - s.posAt) / 1000 : 0); if (ref.current) ref.current.style.transform = `scaleX(${dur ? Math.min(1, p / dur) : 0})`; };
    f();
    if (!playing) return;
    const iv = setInterval(() => { if (!document.hidden) f(); }, 1000);
    return () => clearInterval(iv);
  }, [playing, pos0, dur]);
  return <div className="m-mp"><div ref={ref} /></div>;
}

function Mini({ onOpen }: { onOpen: () => void }) {
  const p = useStore((s) => s.player);
  const album = useStore((s) => s.currentAlbum);
  const tr = p.track;
  if (!tr) return null;
  return (
    <div className="m-mini" onClick={onOpen}>
      <MiniProgress />
      <Cover a={trackCover(tr, album)} size={44} eager />
      <div className="m-mt"><b>{tr.title}</b><span>{tr.artist}</span></div>
      <button className="m-ib" onClick={(e) => { e.stopPropagation(); api.toggle(); }}><Icon n={p.playing ? 'pause' : 'play'} s={22} /></button>
      <button className="m-ib" onClick={(e) => { e.stopPropagation(); api.next(); }}><Icon n="next" s={20} /></button>
    </div>
  );
}

function FullPlayer({ onClose, onQueue }: { onClose: () => void; onQueue: () => void }) {
  const p = useStore((s) => s.player);
  const album = useStore((s) => s.currentAlbum);
  const coverRev = useStore((s) => s.coverRev);
  const src = useStore((s) => s.src);
  const [lyr, setLyr] = useState(false);
  const [dy, setDy] = useState(0);
  const touch = useRef<{ y: number; t: number } | null>(null);
  const tr = p.track;
  useEffect(() => { if (!tr) onClose(); }, [tr]);
  // "⋯" → "Go to album" & co: show the page, not the player on top of it
  const view = useStore((s) => s.view);
  const view0 = useRef(view);
  useEffect(() => { if (view !== view0.current) onClose(); }, [view]);
  if (!tr) return null;
  const a = trackCover(tr, album);
  const nextRepeat = { off: 'all', all: 'one', one: 'off' } as const;
  const teto = src === 'teto';
  // header: where the music comes from — Teto mode, a tag, or the album
  const from = srcTitle(src);
  const head = teto ? t('Режим') : from ? t('Тэг') : tr.album && tr.album !== 'Синглы' ? t('Альбом') : t('Сейчас играет');
  const name = from || (tr.album && tr.album !== 'Синглы' ? tr.album : '');
  // the same menu as in the library (cover photo lives in "Edit")
  const menu = (e: React.MouseEvent) => trackMenu(e, [tr]);
  const start = (e: React.TouchEvent) => { touch.current = { y: e.touches[0].clientY, t: performance.now() }; };
  const move = (e: React.TouchEvent) => { if (touch.current) setDy(Math.max(0, e.touches[0].clientY - touch.current.y)); };
  const end = () => {
    const tc = touch.current; touch.current = null;
    if (tc && (dy > 140 || (dy > 50 && performance.now() - tc.t < 220))) onClose();
    setDy(0);
  };
  return (
    <div className={'m-full' + (p.playing ? '' : ' paused')} style={dy ? { transform: `translateY(${dy}px)`, transition: 'none' } : undefined}>
      <div className="m-fbg"><Cover key={coverRev} a={a} size={64} eager className="amb" /></div>
      <div className="m-fh" onTouchStart={start} onTouchMove={move} onTouchEnd={end}>
        <button className="m-ib" onClick={onClose}><Icon n="chevd" s={24} /></button>
        <div className={'m-fsrc' + (teto ? ' teto' : '')}>
          <small>{head}</small>
          {name && <b>{teto ? <><Logo s={13} />{name}</> : name}</b>}
        </div>
        <button className="m-ib" onClick={menu}><Icon n="more" s={22} /></button>
      </div>
      <div className="m-stage" onTouchStart={lyr ? undefined : start} onTouchMove={lyr ? undefined : move} onTouchEnd={lyr ? undefined : end}>
        {lyr ? <div className="m-lyr"><LyricsBlock /></div> : (
          <div className="m-art" onDoubleClick={() => toggleViz(true)}><Cover key={coverRev} a={a} size={340} eager /></div>
        )}
      </div>
      <div className="m-ti">
        <div><b>{tr.title}</b><span><ArtistLinks name={tr.artist} before={onClose} /></span></div>
        <button className={'m-ib m-fav' + (tr.fav ? ' on' : '')} onClick={() => toggleFav(tr)}><Icon n={tr.fav ? 'heartf' : 'heart'} s={24} /></button>
      </div>
      <Progress />
      <div className={'m-ctl' + (teto ? ' six' : '')}>
        {teto && <button className="m-cross" title={t('Больше не играть в режиме Teto')} onClick={() => tetoCross(tr)}><Icon n="x" s={22} /></button>}
        <button className={p.shuffle ? 'on' : ''} onClick={() => api.setShuffle(!p.shuffle)}><Icon n="shuffle" s={22} /></button>
        <button onClick={() => api.prev()}><Icon n="prev" s={28} /></button>
        <button className="pp" onClick={togglePlay}><Icon n={p.playing ? 'pause' : 'play'} s={30} /></button>
        <button onClick={() => api.next()}><Icon n="next" s={28} /></button>
        <button className={p.repeat !== 'off' ? 'on' : ''} onClick={() => api.setRepeat(nextRepeat[p.repeat])}><Icon n={p.repeat === 'one' ? 'repeat1' : 'repeat'} s={22} /></button>
      </div>
      <div className="m-fx">
        <button className={lyr ? 'on' : ''} onClick={() => setLyr(!lyr)}><Icon n="lyrics" s={20} /><span>{t('Текст')}</span></button>
        <button onClick={() => toggleViz(true)}><Icon n="orbit" s={20} /><span>3D</span></button>
        <button onClick={onQueue}><Icon n="queue" s={20} /><span>{t('Очередь')}</span></button>
      </div>
    </div>
  );
}

function MobileEmpty() {
  return (
    <div className="empty-lib m-empty">
      <div className="big"><Logo s={44} /></div>
      <h2>{t('Пока тихо')}</h2>
      {isIOS
        ? <p>{t('Нажмите «Выбрать файлы», или в Telegram откройте песню → «Поделиться» → Teto. Ещё можно положить песни в приложение «Файлы» → «На iPhone» → «Teto» — они появятся здесь сами.')}</p>
        : <p>{t('Откройте песню в любом приложении — Telegram, файлы, браузер — нажмите «Поделиться» и выберите Teto. Файл сохранится внутри приложения и появится здесь.')}</p>}
      <button className="play" onClick={importFiles}><Icon n="import" s={17} />{t('Выбрать файлы')}</button>
      {!isIOS && <button className="btn" style={{ marginTop: 10 }} onClick={() => navigate({ kind: 'settings' })}><Icon n="search" />{t('Найти музыку на телефоне')}</button>}
    </div>
  );
}
