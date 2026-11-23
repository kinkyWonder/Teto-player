import type { Track } from './types';
import { splitGenres } from './tags';
import { customGenres, genresOf, tagOrder } from './extras';

/* ------------------------------------------------------------------
 * Smart shuffle ("умная перемешка")
 *  - recently played tracks drift to the end (penalty decays over ~3 days)
 *  - the same artist never plays twice in a row and the same album
 *    is kept at least a few tracks apart whenever the pool allows it
 *  - favourites get a small boost
 * History is a tiny ring buffer in localStorage (ids + timestamps).
 * ------------------------------------------------------------------ */

const HKEY = 'teto.history.v1';
const HMAX = 400;
type Hist = [number, number][]; // [trackId, playedAt ms]

let hist: Hist | null = null;
function load(): Hist {
  if (hist) return hist;
  try { hist = JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch { hist = []; }
  return hist!;
}
let saveT: number | undefined;
export function notePlayed(id: number) {
  const h = load();
  if (h.length && h[h.length - 1][0] === id) return;
  h.push([id, Date.now()]);
  if (h.length > HMAX) h.splice(0, h.length - HMAX);
  clearTimeout(saveT);
  saveT = window.setTimeout(() => { try { localStorage.setItem(HKEY, JSON.stringify(h)); } catch { /* quota */ } }, 2000);
}

/** Developer mode: the play history ([trackId, playedAt ms], oldest first). */
export const playHistory = (): Hist => load().slice();
/** Developer mode → reset: forget the play history (smart shuffle starts from scratch). */
export function clearHistory() {
  hist = [];
  clearTimeout(saveT);
  try { localStorage.removeItem(HKEY); } catch { /* ignore */ }
}

/** id -> how "fresh" it is in memory, 1 = just played, 0 = long ago / never */
function recency(): Map<number, number> {
  const now = Date.now(), m = new Map<number, number>();
  const h = load();
  for (let i = 0; i < h.length; i++) {
    const [id, at] = h[i];
    const days = (now - at) / 864e5;
    const pos = (h.length - i) / h.length; // recent plays in the ring count more
    const v = Math.max(Math.exp(-days / 1.2), pos > 0.85 ? 0.9 : 0);
    if (v > (m.get(id) ?? 0)) m.set(id, v);
  }
  return m;
}

export function smartShuffle<T extends Pick<Track, 'id' | 'artist' | 'album_id' | 'fav'>>(list: T[], first?: T): T[] {
  if (list.length < 3) return first ? [first, ...list.filter((t) => t !== first)] : list.slice();
  const rec = recency();
  // weighted random order (Efraimidis–Spirakis): key = u^(1/w)
  const keyed = list.filter((t) => t !== first).map((t) => {
    const r = rec.get(t.id) ?? 0;
    const w = Math.max(0.02, (1 - 0.95 * r) * (t.fav ? 1.35 : 1));
    return { t, k: Math.pow(Math.random(), 1 / w) };
  });
  keyed.sort((a, b) => b.k - a.k);
  const pool = keyed.map((x) => x.t);
  // greedy spacing pass: look ahead for a track that does not clash with the last picks
  const out: T[] = first ? [first] : [];
  const artistGap = Math.min(3, Math.max(1, new Set(list.map((t) => t.artist)).size - 1));
  const albumGap = Math.min(5, Math.max(1, new Set(list.map((t) => t.album_id)).size - 1));
  while (pool.length) {
    let pick = 0;
    const look = Math.min(pool.length, 40);
    for (let j = 0; j < look; j++) {
      const c = pool[j];
      let ok = true;
      for (let b = 1; b <= Math.max(artistGap, albumGap) && b <= out.length; b++) {
        const p = out[out.length - b];
        if ((b <= artistGap && p.artist && p.artist === c.artist) || (b <= albumGap && p.album_id === c.album_id)) { ok = false; break; }
      }
      if (ok) { pick = j; break; }
    }
    out.push(pool.splice(pick, 1)[0]);
  }
  return out;
}

/* ---------------- genres ---------------- */

export interface Genre { key: string; name: string; tracks: Track[]; artists: number; custom?: boolean }

/** Canonical display name for a raw tag ("indie rock; shoegaze" -> "Indie Rock"). */
export function genreName(raw: string): string {
  return splitGenres(raw)[0] ?? '';
}

/**
 * Groups the library by genre (always English names). A song can be in several genres: the user's own choice,
 * else all genres of its tag, else the album's genre (internet / audio analysis).
 */
export function groupGenres(tracks: Track[], albumGenre?: Map<number, string>): { list: Genre[]; untagged: Track[] } {
  const by = new Map<string, Genre>();
  const untagged: Track[] = [];
  for (const t of tracks) {
    if (t.missing) continue;
    const gs = genresOf(t, albumGenre?.get(t.album_id));
    if (!gs.length) { untagged.push(t); continue; }
    for (const name of gs) {
      const key = name.toLowerCase();
      let g = by.get(key);
      if (!g) by.set(key, (g = { key, name, tracks: [], artists: 0 }));
      g.tracks.push(t);
    }
  }
  for (const c of customGenres()) {
    const key = c.toLowerCase();
    const g = by.get(key);
    if (g) g.custom = true; else by.set(key, { key, name: c, tracks: [], artists: 0, custom: true });
  }
  const list = [...by.values()];
  for (const g of list) g.artists = new Set(g.tracks.map((t) => t.artist)).size;
  // the user's own order (dragged on the Tags tab) first, the rest by size
  const pos = new Map(tagOrder().map((k, i) => [k, i]));
  list.sort((a, b) => (pos.get(a.key) ?? 1e6) - (pos.get(b.key) ?? 1e6) || b.tracks.length - a.tracks.length || a.name.localeCompare(b.name));
  return { list, untagged };
}
