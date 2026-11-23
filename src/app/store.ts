import { isMobile } from './platform';
import { useSyncExternalStore } from 'react';
import type { CoverRecipe, Album, Lyrics, PlayerState, Playlist, ScanStatus, Settings, Stats, Track } from '../core/types';

export type View =
  | { kind: 'home' }
  | { kind: 'albums' }
  | { kind: 'album'; id: number }
  | { kind: 'artists' }
  | { kind: 'artist'; name: string }
  | { kind: 'tracks' }
  | { kind: 'favs' }
  | { kind: 'folders' }
  | { kind: 'playlist'; id: number }
  | { kind: 'search'; q: string; net?: boolean; meta?: import('../core/download').DlMeta }
  | { kind: 'genres' }
  | { kind: 'playlists' }
  | { kind: 'catalog' }
  | { kind: 'genre'; name: string }
  | { kind: 'download'; q?: string; meta?: import('../core/download').DlMeta }
  | { kind: 'settings' };

export interface AppState {
  view: View;
  back: View[];
  fwd: View[];
  stats: Stats;
  scan: ScanStatus;
  playlists: Playlist[];
  player: PlayerState;
  pos: number;
  posAt: number; // performance.now() when pos was received
  settings: Settings;
  lyrics: Lyrics | null;
  lyricsFor: number;
  panel: 'none' | 'queue';
  npTab: 'np' | 'lyrics';
  sort: string;
  albumsCache: Album[] | null;
  libVersion: number; // bumps when the library changed
  toast: string | null;
  menu: { x: number; y: number; items: MenuItem[] } | null;
  dialog: Dialog | null;
  review: Record<number, 1 | 2>; // tracks whose names were guessed (1) or swapped (2) by namefix
  photoRev: number;
  coverRev: number;
  lastTrackChange: number;
  currentAlbum: Album | null;
  rov: Record<number, CoverRecipe | null>; // per-album cover overrides made in this session
  hov: Record<number, CoverRecipe[]>; // per-album variant history made in this session
  genBusy: number[]; // albums whose cover is being regenerated in the background
  hidden: boolean;
  showLyrics: boolean;
  viz: boolean; // fullscreen 3D visualizer
  pick: Track[] | null; // phone: tracks selected with a long press
  genreEdit: Track[] | null; // "Edit -> Genres" dialog for these tracks
  /** what the current queue was started from: 'teto' (Teto mode), 'tag:<key>' (a tag tile) or null */
  src: string | null;
}

export interface MenuItem { label: string; onClick?: () => void; danger?: boolean; sep?: boolean; disabled?: boolean; sub?: MenuItem[]; back?: boolean }
export interface DialogField { label: string; value: string; placeholder?: string }
export interface Dialog { title: string; text: string; ok: string; onOk: () => void; input?: string; fields?: DialogField[]; note?: string; danger?: boolean }

export function defaultSettings(): Settings {
  return {
    offline: false, replaygain: 'track', eq_on: false, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eq_preset: 'Flat', device: '', show_np: true,
    theme: 'tide', anim: 'full', anim_speed: 1, glow: true, blur: true, ui_scale: 1, lyrics_size: 1, visualizer: true, cover_quality: 'high', gpu: true,
    close_to_tray: true, start_minimized: false, autostart: false, low_power_tray: true, resume_on_start: false, remember_pos: true,
    xf_mode: 0, xf_ms: 6000, xf_keep_album: true, fade_ms: 150, skip_fade: true, auto_gen: true, bg_analysis: false, web_genres: true, write_protect: false,
    discord: { enabled: false, client_id: '', details: '{title}', state: '{artist}', large_text: '{album} · {year}', large_image: 'itunes', asset_key: 'logo', small: 'state', play_key: 'play', pause_key: 'pause', timestamps: 'progress', paused: 'show', status_display: 1, buttons: [], idle_min: 10 },
  };
}

const emptyPlayer: PlayerState = { track: null, playing: false, pos: 0, dur: 0, volume: 0.8, muted: false, shuffle: false, repeat: 'off', queue: [], index: -1, output: '', error: null };

let state: AppState = {
  view: { kind: 'albums' },
  back: [],
  fwd: [],
  stats: { albums: 0, artists: 0, tracks: 0, favs: 0 },
  scan: { state: 'idle', done: 0, total: 0, message: '' },
  playlists: [],
  player: emptyPlayer,
  pos: 0,
  posAt: 0,
  settings: defaultSettings(),
  lyrics: null,
  lyricsFor: 0,
  panel: 'none',
  npTab: 'np',
  sort: 'artist',
  albumsCache: null,
  libVersion: 0,
  toast: null,
  menu: null,
  dialog: null,
  review: {},
  photoRev: 0,
  coverRev: 0,
  lastTrackChange: 0,
  currentAlbum: null,
  rov: {},
  hov: {},
  genBusy: [],
  hidden: false,
  showLyrics: true,
  viz: false,
  pick: null,
  genreEdit: null,
  src: (() => { try { return localStorage.getItem('teto.src.v1'); } catch { return null; } })(),
};

const subs = new Set<() => void>();
export const getState = () => state;
export function setState(p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const patch = typeof p === 'function' ? p(state) : p;
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

export function navigate(v: View) {
  // phone: downloading lives in the ordinary search (Enter = internet), there is no separate screen
  if (isMobile && v.kind === 'download') v = { kind: 'search', q: v.q ?? '', net: !!v.q, meta: v.meta };
  setState((s) => (JSON.stringify(s.view) === JSON.stringify(v) ? {} : { view: v, back: [...s.back.slice(-50), s.view], fwd: [] }));
}
export function goBack() {
  setState((s) => (s.back.length ? { view: s.back[s.back.length - 1], back: s.back.slice(0, -1), fwd: [s.view, ...s.fwd] } : {}));
}
export function goFwd() {
  setState((s) => (s.fwd.length ? { view: s.fwd[0], fwd: s.fwd.slice(1), back: [...s.back, s.view] } : {}));
}

let toastT: number | undefined;
export function toast(msg: string) {
  setState({ toast: msg });
  clearTimeout(toastT);
  toastT = window.setTimeout(() => setState({ toast: null }), 3200);
}

export function openMenu(e: { clientX: number; clientY: number }, items: MenuItem[]) {
  setState({ menu: { x: e.clientX, y: e.clientY, items } });
}

/** Live (interpolated) playback position. */
export function livePos(s: AppState): number {
  if (!s.player.playing) return s.pos;
  return Math.min(s.player.dur || Infinity, s.pos + (performance.now() - s.posAt) / 1000);
}

export type { Track };
