/**
 * Things the user adds on top of the library, kept on this device (localStorage) and shared by the phone and
 * the desktop UI: own genres for songs (several per song), user-created genres, how often a song was chosen by
 * hand (for the Teto mix), playlist covers and the order of playlists.
 */
import { useSyncExternalStore } from 'react';
import type { Track } from './types';
import { splitGenres, canonGenre, isRussian, isForeign, RUSSIAN, FOREIGN } from './tags';

interface Extras {
  v: 1;
  genres: Record<number, string[]>; // track id -> genres chosen by the user (overrides the tags)
  custom: string[]; // genres created by the user
  picks: Record<number, number>; // track id -> times the user started this very song
  plCover: Record<number, string>; // playlist id -> data: URL (desktop) or a file path inside the app (phone)
  plOrder: number[]; // playlist ids in the user's order
  tagOrder: string[]; // tag keys (lower case) in the order the user dragged them to on the Tags tab
  tetoSkip: number[]; // tracks the user crossed out in Teto mode (never played by Teto)
}
const KEY = 'teto.extras.v1';
const x: Extras = (() => {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && v.v === 1) return v as Extras; } catch { /* corrupted */ }
  return { v: 1, genres: {}, custom: [], picks: {}, plCover: {}, plOrder: [], tagOrder: [], tetoSkip: [] };
})();
x.genres ??= {}; x.custom ??= []; x.picks ??= {}; x.plCover ??= {}; x.plOrder ??= []; x.tagOrder ??= []; x.tetoSkip ??= [];

let ver = 0;
const subs = new Set<() => void>();
let saveT: number | undefined;
function changed() {
  ver++;
  clearTimeout(saveT);
  saveT = window.setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(x)); } catch (e) { console.warn('extras', e); } }, 300);
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** Re-render when extras change (returns a version number usable as a dependency). */
export const useExtrasVersion = () => useSyncExternalStore(subscribe, () => ver);
export const extrasVersion = () => ver;

/* ---------- genres ---------- */
/** Genres of a track: the user's choice, else the tags, else the album's genre (internet / sound analysis). */
/** Tags of a track: the user's choice, else the file tags (else the album's genre from the internet / sound analysis)
 *  plus the automatic "Russian" tag. */
export function genresOf(t: Pick<Track, 'id' | 'genre'> & Partial<Pick<Track, 'title' | 'artist'>>, albumGenre?: string): string[] {
  const own = x.genres[t.id];
  if (own) return own;
  let g = splitGenres(t.genre);
  if (!g.length) g = splitGenres(albumGenre ?? '');
  if (isRussian(t)) { if (!g.includes(RUSSIAN)) g = [...g, RUSSIAN]; }
  else if (isForeign(t) && !g.includes(FOREIGN)) g = [...g, FOREIGN];
  return g;
}
export const hasOwnGenres = (id: number) => !!x.genres[id];
export function setGenres(ids: number[], genres: string[] | null) {
  const list = genres ? dedup(genres.map(canonOrKeep).filter(Boolean)) : null;
  for (const id of ids) { if (list) x.genres[id] = list; else delete x.genres[id]; }
  changed();
}
const canonOrKeep = (g: string) => canonGenre(g) || g.trim();
const dedup = (l: string[]) => l.filter((g, i) => l.findIndex((y) => y.toLowerCase() === g.toLowerCase()) === i);
export const customGenres = () => x.custom.slice();
export function addCustomGenre(name: string): string {
  const g = canonOrKeep(name);
  if (g && !x.custom.some((c) => c.toLowerCase() === g.toLowerCase())) { x.custom.push(g); changed(); }
  return g;
}
export function removeCustomGenre(name: string) {
  x.custom = x.custom.filter((c) => c.toLowerCase() !== name.toLowerCase());
  for (const k of Object.keys(x.genres)) x.genres[+k] = x.genres[+k].filter((g) => g.toLowerCase() !== name.toLowerCase());
  changed();
}

/* ---------- picks: songs the user starts by hand (and listens to for at least 15 s) ---------- */
export function notePick(id: number) { x.picks[id] = (x.picks[id] ?? 0) + 1; changed(); }
export const picksOf = (id: number) => x.picks[id] ?? 0;
export const allPicks = () => ({ ...x.picks });

/* ---------- Teto mode: crossed-out songs ---------- */
export const tetoSkipped = (id: number) => x.tetoSkip.includes(id);
export const tetoSkipList = () => x.tetoSkip.slice();
export function setTetoSkip(id: number, on: boolean) {
  const has = x.tetoSkip.includes(id);
  if (on && !has) x.tetoSkip.push(id); else if (!on && has) x.tetoSkip = x.tetoSkip.filter((i) => i !== id); else return;
  changed();
}

/* ---------- order of tags on the Tags tab ---------- */
export const tagOrder = () => x.tagOrder.slice();
export function setTagOrder(keys: string[]) { x.tagOrder = keys.map((k) => k.toLowerCase()); changed(); }

/** Developer mode: everything the app learned about the user's taste (Teto picks, crossed-out songs). */
export function resetTaste() { x.picks = {}; x.tetoSkip = []; changed(); }

/* ---------- playlists ---------- */
export const playlistCover = (id: number) => x.plCover[id] ?? '';
export function setPlaylistCover(id: number, src: string | null) { if (src) x.plCover[id] = src; else delete x.plCover[id]; changed(); }
export function orderPlaylists<T extends { id: number }>(list: T[]): T[] {
  const pos = new Map(x.plOrder.map((id, i) => [id, i]));
  return list.slice().sort((a, b) => (pos.get(a.id) ?? 1e9 + a.id) - (pos.get(b.id) ?? 1e9 + b.id));
}
/** Move a playlist by `delta` places (negative = earlier). */
export function movePlaylist(all: { id: number }[], id: number, delta: number) {
  const ids = orderPlaylists(all).map((p) => p.id);
  const i = ids.indexOf(id), j = Math.max(0, Math.min(ids.length - 1, i + delta));
  if (i < 0 || i === j) return;
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  x.plOrder = ids;
  changed();
}
