/** Lyrics for the phone: LRCLIB (free, no key), cached in localStorage. */
import { CapacitorHttp } from '@capacitor/core';
import type { Lyrics, Track } from '../../core/types';

const LYKEY = 'teto.lyrics.v1';
const lyrCache: Record<number, Lyrics> = (() => { try { return JSON.parse(localStorage.getItem(LYKEY) || '{}'); } catch { return {}; } })();
export function cacheLyr(id: number, l: Lyrics) {
  lyrCache[id] = l;
  const keys = Object.keys(lyrCache);
  if (keys.length > 400) delete lyrCache[+keys[0]];
  try { localStorage.setItem(LYKEY, JSON.stringify(lyrCache)); } catch { /* quota */ }
}
export function parseLrc(s: string) {
  const out: { t: number; text: string }[] = [];
  for (const line of s.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push({ t: +m[1] * 60 + +m[2], text });
  }
  return out.sort((a, b) => a.t - b.t);
}
export type LrcItem = { id: number; trackName: string; artistName: string; albumName: string; duration: number; syncedLyrics: string | null; plainLyrics: string | null; instrumental: boolean };
export function toLyrics(r: LrcItem | null): Lyrics {
  if (!r) return { kind: 'none', lines: [], source: '' };
  if (r.syncedLyrics) return { kind: 'synced', lines: parseLrc(r.syncedLyrics), source: 'LRCLIB' };
  if (r.plainLyrics) return { kind: 'plain', lines: r.plainLyrics.split(/\r?\n/).map((text) => ({ t: 0, text })), source: 'LRCLIB' };
  return { kind: 'none', lines: [], source: '' };
}
export async function lrc(path: string, params: Record<string, string>) {
  const r = await CapacitorHttp.get({ url: 'https://lrclib.net' + path, params, headers: { 'User-Agent': 'Teto Player (Android)' }, connectTimeout: 8000, readTimeout: 10000 });
  if (r.status === 404) return null;
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
}
export async function lyricsFor(id: number, t: Track | undefined, offline: boolean, force = false): Promise<Lyrics> {
  if (!force && lyrCache[id]) return lyrCache[id];
  if (!t) return { kind: 'none', lines: [], source: '' };
  if (offline) return { kind: 'none', lines: [], source: '' };
  try {
    let r: LrcItem | null = await lrc('/api/get', { track_name: t.title, artist_name: t.artist, album_name: t.album === 'Синглы' ? '' : t.album, duration: String(Math.round(t.dur)) }).catch(() => null);
    if (!r) {
      const list: LrcItem[] = (await lrc('/api/search', { track_name: t.title, artist_name: t.artist })) ?? [];
      r = list.find((x) => x.syncedLyrics && Math.abs(x.duration - t.dur) < 4) ?? list.find((x) => Math.abs(x.duration - t.dur) < 4) ?? null;
    }
    const l = toLyrics(r);
    cacheLyr(id, l);
    return l;
  } catch (e) { return { kind: 'error', lines: [], source: '', message: String(e) }; }
}

export function clearLyrics() { for (const k of Object.keys(lyrCache)) delete lyrCache[+k]; localStorage.removeItem(LYKEY); }
