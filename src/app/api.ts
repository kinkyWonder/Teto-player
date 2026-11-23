import type { Album, Artist, CoverRecipe, Lyrics, PlayerState, Playlist, ScanStatus, SearchResult, Settings, Stats, Track, Repeat } from '../core/types';

import { isMobile, isNativeMobile, isTauri } from './platform';
export { isMobile, isTauri };
// browser preview only: the mock backend is loaded lazily and never ships in the Tauri code path
let mockP: Promise<typeof import('./mock')> | null = null;
const mockMod = () => (mockP ??= import('./mock'));
let mockSync: (typeof import('./mock'))['mock'] | null = null;
if (!isTauri && !isNativeMobile) mockMod().then((m) => (mockSync = m.mock));
// phones: the whole backend (library, player, media session) lives in ./mobile
let mobP: Promise<typeof import('../mobile/backend/index')> | null = null;
const mobMod = () => (mobP ??= import('../mobile/backend/index'));
let mobSync: (typeof import('../mobile/backend/index'))['mobile'] | null = null;
if (isNativeMobile) mobMod().then((m) => (mobSync = m.mobile));

type Unlisten = () => void;

let coreP: Promise<typeof import('@tauri-apps/api/core')> | null = null;
const core = () => (coreP ??= import('@tauri-apps/api/core'));

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isNativeMobile) return (await mobMod()).mobile.call(cmd, args) as Promise<T>;
  if (!isTauri) return (await mockMod()).mock.call(cmd, args) as Promise<T>;
  const c = await core();
  return c.invoke<T>(cmd, args);
}

export async function on<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
  if (isNativeMobile) return (await mobMod()).mobile.on(event, cb as (p: unknown) => void);
  if (!isTauri) return (await mockMod()).mock.on(event, cb as (p: unknown) => void);
  const ev = await import('@tauri-apps/api/event');
  return ev.listen<T>(event, (e) => cb(e.payload));
}

/** Phones: whether an album has a real (embedded or user) picture. */
export const albumHasCover = (id: number) => mobSync?.hasCover(id) ?? false;

let coverBase = '';
/** Desktop: covers are cached by the webview for a year — a changed cover gets a new address. */
const coverRevs = new Map<number, number>();
export const bumpCover = (albumId: number) => { coverRevs.set(albumId, Date.now()); };
export function coverUrl(albumId: number, size: number): string {
  if (isNativeMobile) return mobSync?.coverUrl(albumId, size) ?? '';
  if (!isTauri) return mockSync?.coverUrl(albumId, size) ?? '';
  if (!coverBase) {
    // Tauri custom protocol: http://teto.localhost/ on Windows, teto://localhost/ elsewhere
    coverBase = navigator.userAgent.includes('Windows') ? 'http://teto.localhost/' : 'teto://localhost/';
  }
  const rev = coverRevs.get(albumId);
  return `${coverBase}cover/${albumId}/${size}` + (rev ? `?v=${rev}` : '');
}

/** URL of the user's artist photo, or '' (callers fall back to an album cover). */
export async function artistPhotoUrl(name: string): Promise<string> {
  const r = await call<string | null>('artist_photo', { name }).catch(() => null);
  if (!r) return '';
  if (isMobile || !isTauri) return r; // phone: file URL; preview: data URL
  coverUrl(0, 0); // sets coverBase
  return `${coverBase}artist/${r}`;
}

export const api = {
  stats: () => call<Stats>('stats'),
  albums: (sort: string) => call<Album[]>('albums', { sort }),
  album: (id: number) => call<Album | null>('album', { id }),
  albumTracks: (id: number) => call<Track[]>('album_tracks', { id }),
  artists: () => call<Artist[]>('artists'),
  artistAlbums: (name: string) => call<Album[]>('artist_albums', { name }),
  tracks: (sort: string) => call<Track[]>('tracks', { sort }),
  favorites: () => call<Track[]>('favorites'),
  recent: () => call<Album[]>('recent_albums'),
  search: (q: string) => call<SearchResult>('search', { q }),
  setFav: (id: number, fav: boolean) => call<void>('set_fav', { id, fav }),
  setAlbumFav: (id: number, fav: boolean) => call<void>('set_album_fav', { id, fav }),
  folders: () => call<string[]>('folders'),
  addFolder: (path: string) => call<void>('add_folder', { path }),
  removeFolder: (path: string) => call<void>('remove_folder', { path }),
  rescan: () => call<void>('rescan'),
  scanStatus: () => call<ScanStatus>('scan_status'),
  playlists: () => call<Playlist[]>('playlists'),
  createPlaylist: (name: string) => call<number>('create_playlist', { name }),
  deletePlaylist: (id: number) => call<void>('delete_playlist', { id }),
  renamePlaylist: (id: number, name: string) => call<void>('rename_playlist', { id, name }),
  playlistTracks: (id: number) => call<Track[]>('playlist_tracks', { id }),
  addToPlaylist: (id: number, trackIds: number[]) => call<void>('add_to_playlist', { id, trackIds }),
  removeFromPlaylist: (id: number, trackIds: number[]) => call<void>('remove_from_playlist', { id, trackIds }),
  // player
  playQueue: (trackIds: number[], index: number, shuffle?: boolean) => call<void>('play_queue', { trackIds, index, shuffle: !!shuffle }),
  playMix: (trackIds: number[], order: number[]) => call<void>('play_mix', { trackIds, order }),
  albumGenres: () => call<[number, string][]>('album_genres'),
  enqueue: (trackIds: number[], next: boolean) => call<void>('enqueue', { trackIds, next }),
  toggle: () => call<void>('toggle'),
  next: () => call<void>('next'),
  prev: () => call<void>('prev'),
  seek: (pos: number) => call<void>('seek', { pos }),
  setVolume: (v: number) => call<void>('set_volume', { v }),
  setMuted: (m: boolean) => call<void>('set_muted', { m }),
  setShuffle: (on: boolean) => call<void>('set_shuffle', { on }),
  setRepeat: (mode: Repeat) => call<void>('set_repeat', { mode }),
  jump: (index: number) => call<void>('jump', { index }),
  removeFromQueue: (index: number) => call<void>('remove_from_queue', { index }),
  playerState: () => call<PlayerState>('player_state'),
  queueTracks: () => call<Track[]>('queue_tracks'),
  devices: () => call<string[]>('devices'),
  // lyrics
  lyrics: (id: number) => call<Lyrics>('lyrics', { id }),
  lyricsCandidates: (id: number) => call<{ id: number; label: string; synced: boolean }[]>('lyrics_candidates', { id }),
  pickLyrics: (id: number, candidate: number) => call<Lyrics>('pick_lyrics', { id, candidate }),
  saveLrc: (id: number) => call<string>('save_lrc', { id }),
  // covers
  analyze: (albumId: number) => call<{ genre: string; energy: number; bpm: number; bright: number; valence: number }>('analyze_album', { albumId }),
  setRecipe: (albumId: number, recipe: CoverRecipe, history: CoverRecipe[]) => call<void>('set_recipe', { albumId, recipe, history }),
  useRealCover: (albumId: number) => call<void>('use_real_cover', { albumId }),
  embedCover: (albumId: number, png: number[]) => call<number>('embed_cover', { albumId, png }),
  saveGenCover: (albumId: number, png: number[]) => call<void>('save_gen_cover', { albumId, png }),
  // names (namefix): manual fixes win over the automatic cleanup and survive rescans
  renameTrack: (id: number, title?: string, artist?: string, album?: string) => call<void>('rename_track', { id, title, artist, album }),
  swapArtistTitle: (id: number) => call<void>('swap_artist_title', { id }),
  renameArtist: (old: string, name: string) => call<number>('rename_artist', { old, new: name }),
  setArtistPhoto: (name: string, jpeg: number[] | null) => call<void>('set_artist_photo', { name, jpeg }),
  artistPhoto: (name: string) => call<string | null>('artist_photo', { name }),
  namesToReview: () => call<[number, number, boolean][]>('names_to_review'),
  // settings
  settings: () => call<Settings>('settings'),
  setSettings: (s: Partial<Settings>) => call<Settings>('set_settings', { patch: s }),
  showWindow: () => call<void>('show_window'),
  hideToTray: () => call<void>('hide_to_tray'),
  restart: () => call<void>('restart_app'),
  discordStatus: () => call<string>('discord_status'),
  discordPreview: () => call<{ activity: Record<string, unknown> | null; playing: boolean; pos: number; dur: number } | null>('discord_preview'),
  clearCache: (what: 'covers' | 'lyrics') => call<void>('clear_cache', { what }),
  appInfo: () => call<{ version: string; data: string }>('app_info'),
  levels: () => call<number[]>('levels'),
  revealFile: (path: string) => call<void>('reveal_file', { path }),
};

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return (await mockMod()).mock.pickFolder();
  const d = await import('@tauri-apps/plugin-dialog');
  const r = await d.open({ directory: true, multiple: false, title: 'Добавить папку с музыкой' });
  return typeof r === 'string' ? r : null;
}

export async function windowCtl(action: 'min' | 'max' | 'close' | 'drag') {
  if (!isTauri) return;
  const w = await import('@tauri-apps/api/window');
  const win = w.getCurrentWindow();
  if (action === 'min') return win.minimize();
  if (action === 'max') return win.toggleMaximize();
  if (action === 'close') return win.close();
  if (action === 'drag') return win.startDragging();
}

let lastZoom = 1;
export async function setZoom(v: number) {
  if (!isTauri || v === lastZoom) return;
  lastZoom = v;
  const w = await import('@tauri-apps/api/webview');
  await w.getCurrentWebview().setZoom(v).catch(() => {});
}

/** Real fullscreen for the visualizer: the Tauri window, the phone's immersive mode, or the browser API. */
export async function setFullscreen(on: boolean) {
  if (isTauri) {
    const w = await import('@tauri-apps/api/window');
    await w.getCurrentWindow().setFullscreen(on).catch(() => {});
    return;
  }
  if (isNativeMobile) { (await import('../mobile/native')).native.immersive(on); return; }
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch { /* not allowed */ }
}
