/**
 * Hidden listening statistics on the phone (same model as src-tauri/src/listen.rs): seconds actually played,
 * plays (≥30 s or half the song) and skips per local day / hour / track, plus a snapshot of the names.
 * Read only by the monthly report (src/report) — never shown for the current month.
 */
import type { Track } from '../../core/types';

type Cell = [number, number, number]; // secs, plays, skips
interface Meta { title: string; artist: string; album: string; album_id: number; genre: string; dur: number }
interface Store { v: 1; rows: Record<string, Cell>; meta: Record<number, Meta> }
const KEY = 'teto.listen.v1';
const st: Store = (() => {
  try { const x = JSON.parse(localStorage.getItem(KEY) || 'null'); if (x && x.v === 1) return x as Store; } catch { /* corrupted */ }
  return { v: 1, rows: {}, meta: {} };
})();
const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
let dirty = false;
function save() {
  if (!dirty) return;
  dirty = false;
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { prune(6); try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* quota */ } }
}
/** Keep the last `months` months (the report needs only the previous one; the archive keeps more). */
function prune(months: number) {
  const d = new Date(); d.setMonth(d.getMonth() - months);
  const lim = dayOf(new Date(d.getFullYear(), d.getMonth(), 1));
  for (const k of Object.keys(st.rows)) if (k.slice(0, 10) < lim) delete st.rows[k];
}
prune(14);
setInterval(save, 30000);
addEventListener('pagehide', save);

function cell(id: number): Cell {
  const d = new Date();
  const k = `${dayOf(d)}|${d.getHours()}|${id}`;
  dirty = true;
  return (st.rows[k] ??= [0, 0, 0]);
}

let cur: { id: number; dur: number; last: number; secs: number; counted: boolean } | null = null;
/** A song started. */
export function listenTrack(t: Track) {
  const o = cur;
  if (o && !o.counted && o.secs < 30 && o.dur > 60 && o.dur - o.last > 5) cell(o.id)[2]++;
  cur = { id: t.id, dur: t.dur, last: -1, secs: 0, counted: false };
  st.meta[t.id] = { title: t.title, artist: t.artist, album: t.album, album_id: t.album_id, genre: t.genre, dur: t.dur };
  dirty = true;
}
/** Playback position while playing; seeks are not listening time. */
export function listenPos(p: number, playing: boolean) {
  const c = cur;
  if (!c) return;
  const d = p - c.last;
  if (playing && c.last >= 0 && d > 0 && d < 2.5) {
    c.secs += d;
    const x = cell(c.id);
    x[0] += d;
    if (!c.counted && (c.secs >= 30 || (c.dur > 0 && c.secs >= c.dur * 0.5))) { c.counted = true; x[1]++; }
  }
  c.last = p;
}
/** Rows of [from, to) — same shape as the desktop command `listen_log`. */
export function listenLog(from: string, to: string, live: (id: number) => Track | undefined) {
  save();
  const out = [];
  for (const [k, [s, p, kk]] of Object.entries(st.rows)) {
    const [d, h, id] = k.split('|');
    if (d < from || d >= to) continue;
    const t = live(+id), m = st.meta[+id];
    const src = t ?? m;
    out.push({ d, h: +h, id: +id, s, p, k: kk, title: src?.title ?? '', artist: src?.artist ?? '', album: src?.album ?? '', album_id: src?.album_id ?? 0, genre: src?.genre ?? '', dur: src?.dur ?? 0 });
  }
  return out;
}
export const listenFirst = () => Object.keys(st.rows).reduce<string | null>((m, k) => (!m || k.slice(0, 10) < m ? k.slice(0, 10) : m), null);
/** Developer mode → reset: forget every listening statistic on this device. */
export function listenReset() {
  st.rows = {};
  st.meta = {};
  cur = null;
  dirty = false;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
