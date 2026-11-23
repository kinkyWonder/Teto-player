import { startReports } from '../report/schedule';
import { useEffect, useRef } from 'react';
import { api, on, setZoom } from './api';
import { getState, livePos, setState, toast, useStore } from './store';
import type { Lyrics, PlayerState, ScanStatus } from '../core/types';
import { refreshLibrary, toggleViz } from './actions';
import { notePlayed } from '../core/mix';
import { VizFull } from '../ui/VizFull';
import { setCoverQuality, syncCoverLook } from '../cover/gen';
import { Ambient } from '../ui/Fx';
import type { Settings } from '../core/types';
import { applyLayout, themeKey } from '../core/look';
import { Overlays, Sidebar, TitleBar, TopBar } from '../ui/Chrome';
import { NowPlaying } from '../ui/NowPlaying';
import { PlayerBar, toggleLyrics } from '../ui/PlayerBar';
import { QueuePanel } from '../ui/Popovers';
import { ScrollCtx } from '../ui/TrackTable';
import { usePrefsLite } from '../core/prefsHook';
import { prefs } from '../core/prefs';
import { AlbumsView, AlbumView, ArtistsView, ArtistView, CatalogView, DownloadView, EmptyLibrary, FavsView, FoldersView, GenresView, GenreView, HomeView, PlaylistView, SearchView, SettingsView, TracksView } from '../ui/views';

let lastTrack = -1;
export async function onPlayer(p: PlayerState) {
  setState({ player: p, pos: p.pos, posAt: performance.now() });
  const id = p.track?.id ?? -1;
  if (id !== lastTrack) {
    lastTrack = id;
    if (p.track && p.playing) notePlayed(p.track.id);
    setState({ lyrics: null });
    if (p.track) {
      const [al, ly] = await Promise.all([
        getState().currentAlbum?.id === p.track.album_id ? Promise.resolve(getState().currentAlbum) : api.album(p.track.album_id),
        api.lyrics(p.track.id).catch((): Lyrics => ({ kind: 'error', lines: [], source: '' })),
      ]);
      if (getState().player.track?.id !== id) return;
      setState({ currentAlbum: al, lyrics: ly });
    } else setState({ currentAlbum: null });
  }
}

export function App() {
  const view = useStore((s) => s.view);
  const empty = useStore((s) => s.stats.tracks === 0);
  const panel = useStore((s) => s.panel);
  const showNp = useStore((s) => s.settings.show_np);
  const searchRef = useRef<HTMLInputElement>(null);
  const { lang, layout } = usePrefsLite(); // language / layout switch re-renders everything
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const [settings, scan, p] = await Promise.all([api.settings(), api.scanStatus(), api.playerState()]);
      setState({ settings, scan });
      await refreshLibrary();
      startReports();
      onPlayer(p);
      requestAnimationFrame(() => api.showWindow());
      const st = getState().stats;
      if (st.albums && getState().view.kind === 'albums' && !new URLSearchParams(location.search).has('albums')) {
        // open the album that is playing (or the first one) like the design does
        const id = p.track?.album_id;
        if (id) setState({ view: { kind: 'album', id } });
      }
    })();
    const un = [
      on<PlayerState>('player:state', onPlayer),
      on<{ pos: number }>('player:pos', (e) => setState({ pos: e.pos, posAt: performance.now() })),
      on<ScanStatus>('scan', (scan) => setState({ scan })),
      on<null>('library', () => refreshLibrary()),
      on<string>('player:error', (m) => toast(m)),
      on<null>('app:shown', async () => { onPlayer(await api.playerState()); }),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.ctrlKey && e.code === 'KeyK') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if (e.ctrlKey && e.code === 'KeyL') { e.preventDefault(); toggleLyrics(); return; }
      if (e.code === 'F5' || (e.ctrlKey && e.code === 'KeyR')) { e.preventDefault(); return; }
      if (typing) return;
      const s = getState();
      if (e.code === 'Space') { e.preventDefault(); api.toggle(); }
      else if (e.code === 'KeyV' && !e.ctrlKey && !e.altKey) { if (s.player.track) toggleViz(); }
      else if (e.ctrlKey && e.code === 'ArrowRight') { e.preventDefault(); api.next(); }
      else if (e.ctrlKey && e.code === 'ArrowLeft') { e.preventDefault(); api.prev(); }
      else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        e.preventDefault();
        const p = Math.max(0, livePos(s) + (e.code === 'ArrowRight' ? 5 : -5));
        setState({ pos: p, posAt: performance.now() });
        api.seek(p);
      } else if (e.altKey && e.code === 'ArrowLeft') history.back();
    };
    const ctx = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('input')) e.preventDefault(); };
    addEventListener('keydown', key);
    addEventListener('contextmenu', ctx);
    return () => { removeEventListener('keydown', key); removeEventListener('contextmenu', ctx); };
  }, []);

  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [view]);
  useEffect(watchHidden, []);

  // look & feel settings -> <html> attributes / CSS variables
  const settings = useStore((s) => s.settings);
  useEffect(() => applyLook(settings), [settings.theme, settings.anim, settings.anim_speed, settings.glow, settings.blur, settings.ui_scale, settings.lyrics_size, settings.cover_quality, layout, lang]);

  // 3D tilt on album cards (pure transform, GPU-composited)
  useEffect(() => {
    if (settings.anim !== 'full') return;
    let cur: HTMLElement | null = null;
    const move = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest?.('.card .cw') as HTMLElement | null;
      if (cur && cur !== el) { cur.style.transform = ''; cur = null; }
      if (!el) return;
      cur = el;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(600px) rotateY(${x * 10}deg) rotateX(${-y * 10}deg) translateZ(6px)`;
      el.style.setProperty('--gx', `${(x + 0.5) * 100}%`);
      el.style.setProperty('--gy', `${(y + 0.5) * 100}%`);
    };
    const leave = () => { if (cur) { cur.style.transform = ''; cur = null; } };
    addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    return () => { removeEventListener('pointermove', move); document.removeEventListener('pointerleave', leave); leave(); };
  }, [settings.anim]);

  const libraryView = !['folders', 'settings', 'catalog', 'genres', 'download'].includes(view.kind);
  let body: React.ReactNode;
  if (empty && libraryView) body = <EmptyLibrary />;
  else switch (view.kind) {
    case 'home': body = <HomeView />; break;
    case 'catalog': case 'playlists': body = <CatalogView />; break;
    case 'albums': body = <AlbumsView />; break;
    case 'album': body = <AlbumView id={view.id} />; break;
    case 'artists': body = <ArtistsView />; break;
    case 'artist': body = <ArtistView name={view.name} />; break;
    case 'tracks': body = <TracksView />; break;
    case 'favs': body = <FavsView />; break;
    case 'folders': body = <FoldersView />; break;
    case 'playlist': body = <PlaylistView id={view.id} />; break;
    case 'search': body = <SearchView q={view.q} />; break;
    case 'genres': body = <GenresView />; break;
    case 'genre': body = <GenreView name={view.name} />; break;
    case 'download': body = <DownloadView q={view.q} meta={view.meta} />; break;
    case 'settings': body = <SettingsView />; break;
  }

  return (
    <div className="win" key={lang}>
      <Ambient />
      <TitleBar />
      <div className="body">
        <Sidebar />
        <div className="main">
          <TopBar searchRef={searchRef} />
          <ScrollCtx.Provider value={scrollRef}>
            <div className="content" ref={scrollRef}><div className="page" key={JSON.stringify(view)}>{body}</div></div>
          </ScrollCtx.Provider>
        </div>
        {showNp && <NowPlaying />}
      </div>
      <PlayerBar />
      {panel === 'queue' && <QueuePanel />}
      <Overlays />
      <VizFull />
    </div>
  );
}

// battery: freeze every CSS animation while the window is hidden / minimised
export function watchHidden() {
  const f = () => { document.documentElement.dataset.hidden = document.hidden ? '1' : '0'; setState({ hidden: document.hidden }); };
  document.addEventListener('visibilitychange', f);
  f();
}

let lastTheme = '';
export function applyLook(s: Settings) {
  const h = document.documentElement;
  if (lastTheme && lastTheme !== s.theme) {
    // smooth colour morph when switching themes
    h.classList.add('theming');
    setTimeout(() => h.classList.remove('theming'), 600);
  }
  lastTheme = s.theme;
  h.dataset.theme = themeKey(s.theme);
  applyLayout();
  h.dataset.anim = s.anim || 'full';
  h.dataset.glow = s.glow ? '1' : '0';
  h.dataset.blur = s.blur ? '1' : '0';
  h.style.setProperty('--spd', String(s.anim === 'off' ? 0.001 : 1 / Math.max(0.25, s.anim_speed || 1)));
  h.style.setProperty('--lyr', String(s.lyrics_size || 1));
  setZoom(s.ui_scale || 1);
  setCoverQuality(s.cover_quality);
  syncCoverLook(themeKey(s.theme), prefs().coverStyle);
}
