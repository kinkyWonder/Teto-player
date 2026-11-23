/**
 * "Hints": album pages can show the songs of the album that are not on this device yet.
 * The full track list comes from the iTunes Search API (free, no key). "Download" looks the song up on YouTube + SoundCloud
 * (./download.ts) and downloads it, or shows the results on the Download screen; once the file is in Teto the hint disappears.
 */
import { useEffect, useState } from 'react';
import { call } from '../app/api';
import { usePrefsLite } from './prefsHook';
import type { Track } from './types';

export interface HintItem { no: number; disc: number; title: string; dur: number }

/** Title key: lower case, no brackets / feat. / punctuation, ё → е. */
export function titleKey(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е')
    .replace(/\s[-–—]\s.*(remaster|version|edit|mix|live|mono|stereo).*$/i, '')
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\b(feat|ft|featuring)\.?\s.*$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const memo = new Map<string, Promise<{ album: string; tracks: HintItem[] } | null>>();
const fetchList = (artist: string, album: string) => {
  const k = artist + '\u0001' + album;
  if (!memo.has(k)) memo.set(k, call<{ album: string; tracks: HintItem[] } | null>('album_tracklist', { artist, album }).catch(() => { memo.delete(k); return null; }));
  return memo.get(k)!;
};

/** Songs of the album that are missing here (empty while loading / when hints are off). */
export function useMissing(artist: string | undefined, album: string | undefined, have: Track[] | null): HintItem[] {
  const on = usePrefsLite().hints;
  const [list, setList] = useState<HintItem[] | null>(null);
  useEffect(() => {
    setList(null);
    if (!on || !artist || !album || album === 'Синглы' || /^(unknown|неизвестн)/i.test(album)) return;
    let live = true;
    fetchList(artist, album).then((r) => live && setList(r?.tracks ?? []));
    return () => { live = false; };
  }, [on, artist, album]);
  if (!on || !list || !have) return [];
  const own = new Set(have.map((x) => titleKey(x.title)));
  const ownArr = [...own];
  return list.filter((h) => {
    const k = titleKey(h.title);
    return k && !own.has(k) && !ownArr.some((o) => o.length > 3 && (o.includes(k) || k.includes(o)));
  });
}

export const openUrl = (url: string) => call('open_url', { url }).catch(() => { window.open(url, '_blank'); });

/** "Download": find the song (YouTube + SoundCloud) and download it, otherwise show the results on the Download screen. */
export function downloadHint(artist: string, title: string, dur = 0, meta?: import('./download').DlMeta) {
  import('./download').then((m) => m.quickDownload(artist, title, dur, meta));
}
