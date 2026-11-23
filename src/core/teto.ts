/**
 * Teto mode.
 *  - A "pick" is a song the user started by hand AND listened to for at least 15 seconds (skipping right away
 *    does not count). Picks rank the user's own favourites.
 *  - Teto order: the top 10 picks in random order, then picks 11–20 in random order, then everything else
 *    completely at random. Songs crossed out with ✕ in the player are never played by Teto; the next ranked
 *    songs take their places, so the blocks stay full.
 *  - The queue source ('teto' / 'tag:<key>') survives restarts, so the ✕ button stays in the player.
 */
import { getState, livePos, setState } from '../app/store';
import type { Track } from './types';
import { notePick, picksOf, tetoSkipped } from './extras';
import { FOREIGN, RUSSIAN, tagLabel } from './tags';

export const PICK_SECS = 15;
export const TOP_A = 10, TOP_B = 10;

/* ---------- queue source ---------- */
export function setSrc(src: string | null) {
  if (getState().src === src) return;
  setState({ src });
  try { if (src) localStorage.setItem('teto.src.v1', src); else localStorage.removeItem('teto.src.v1'); } catch { /* quota */ }
}
export const isTetoMode = () => getState().src === 'teto';

/* ---------- picks that last 15 s ---------- */
let armed: { id: number; best: number } | null = null;
let iv: number | undefined;
function check() {
  const a = armed;
  if (!a) { clearInterval(iv); iv = undefined; return; }
  const s = getState();
  if (s.player.track?.id !== a.id) { // another song is playing now: did the picked one last long enough?
    if (a.best >= PICK_SECS) notePick(a.id);
    armed = null;
    return;
  }
  a.best = Math.max(a.best, livePos(s));
  if (a.best >= PICK_SECS) { notePick(a.id); armed = null; }
}
/** The user started this song by hand; it becomes a pick once it has played for 15 seconds. */
export function armPick(id: number) {
  if (armed && armed.best >= PICK_SECS) notePick(armed.id);
  armed = { id, best: 0 };
  clearInterval(iv);
  iv = window.setInterval(check, 1000);
}

/* ---------- order ---------- */
const shuffled = <T,>(l: T[]) => { const a = l.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** Teto ranking: crossed-out songs are left out first, so the blocks stay full. Most picks first, favourites break ties. */
export function tetoRanked<T extends Pick<Track, 'id' | 'fav'>>(list: T[]): T[] {
  return list.filter((t) => !tetoSkipped(t.id))
    .map((t) => ({ t, p: picksOf(t.id), r: Math.random() }))
    .filter((x) => x.p > 0 || x.t.fav)
    .sort((a, b) => b.p - a.p || +b.t.fav - +a.t.fav || a.r - b.r)
    .map((x) => x.t);
}

/** Top 10 in random order, then 11–20 in random order, then everything else completely at random. */
export function tetoOrder<T extends Pick<Track, 'id' | 'fav'>>(list: T[]): T[] {
  const pool = list.filter((t) => !tetoSkipped(t.id));
  const ranked = tetoRanked(pool);
  const top = ranked.slice(0, TOP_A), next = ranked.slice(TOP_A, TOP_A + TOP_B);
  const used = new Set([...top, ...next]);
  return [...shuffled(top), ...shuffled(next), ...shuffled(pool.filter((t) => !used.has(t)))];
}

/** Player header: where the queue comes from ("Teto", a tag name) or '' for albums / lists. */
export function srcTitle(src: string | null): string {
  if (src === 'teto') return 'Teto';
  if (!src?.startsWith('tag:')) return '';
  const k = src.slice(4);
  const g = k === RUSSIAN.toLowerCase() ? RUSSIAN : k === FOREIGN.toLowerCase() ? FOREIGN : k.replace(/(^|[\s\-/&])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  return tagLabel(g);
}
