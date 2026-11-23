/** Phone multi-select: long-press a track, then tap others; the selection bar acts on all of them. */
import { getState, setState } from '../app/store';
import type { Track } from './types';

let source: Track[] = [];
/** The list the selection was started in ("select all"). */
export const pickSource = () => source;
export function startPick(t: Track, list?: Track[]) {
  try { navigator.vibrate?.(12); } catch { /* not allowed */ }
  if (list) source = list;
  setState({ pick: [t], menu: null });
}
export function togglePick(t: Track) {
  const cur = getState().pick ?? [];
  const next = cur.some((x) => x.id === t.id) ? cur.filter((x) => x.id !== t.id) : [...cur, t];
  setState({ pick: next.length ? next : null });
}
export const clearPick = () => { if (getState().pick) setState({ pick: null }); };
export const pickAll = (list: Track[]) => { source = list; setState({ pick: list.filter((t) => !t.missing) }); };
