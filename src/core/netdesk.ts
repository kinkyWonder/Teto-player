/**
 * Desktop: the phone's fast internet search (../mobile/backend/online.ts — YouTube Music, YouTube, SoundCloud) and
 * Spotify links, without starting yt-dlp for every query. The webview can't call those sites itself (CORS), so the
 * requests go through the Rust command `net_http` (HTTPS to a short list of allowed hosts only).
 */
import { call } from '../app/api';
import { netSearch, relevance, type Http, type NetItem, type NetSource } from '../mobile/backend/online';

const withQuery = (url: string, params?: Record<string, string>) => {
  if (!params) return url;
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return qs ? url + (url.includes('?') ? '&' : '?') + qs : url;
};

export const DESK_H: Http = {
  get: (url, params, headers) => call('net_http', { method: 'GET', url: withQuery(url, params), headers: headers ?? null, body: null }),
  post: (url, body, headers) => call('net_http', {
    method: 'POST', url, body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(headers ?? {}) },
  }),
};

/** VK needs the phone's login window: on the desktop "VK" means "everywhere". */
const deskSrc = (s: string): NetSource => (s === 'youtube' || s === 'soundcloud' ? s : 'all');

export async function deskSearch(q: string, src: string): Promise<{ items: NetItem[]; ok: number }> {
  return netSearch(DESK_H, q, deskSrc(src));
}

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
/** Spotify track link → "artist", "title" (from the page's Open Graph tags, like the phone). */
export async function spotifyName(url: string): Promise<{ artist: string; title: string }> {
  const r = await DESK_H.get(url.replace(/^spotify:track:/, 'https://open.spotify.com/track/'), undefined, { 'User-Agent': IPHONE_UA });
  const page = String(r.data ?? '');
  const og = (p: string) => page.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`))?.[1]?.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"') ?? '';
  const title = og('title');
  const artist = og('description').split(' · ')[0] || '';
  if (!title) throw new Error('Spotify: не удалось узнать название');
  return { artist, title };
}

/** The best result for "artist title" (Spotify links), or null. */
export async function deskBest(artist: string, title: string, src: string): Promise<NetItem | null> {
  const { items } = await deskSearch(`${artist} ${title}`, src);
  let best: NetItem | null = null, score = 0;
  for (const it of items) {
    if (it.source === 'vk') continue;
    const s = relevance(`${artist} ${title}`, it) + (it.song ? 0.1 : 0);
    if (s > score) { score = s; best = it; }
  }
  return score >= 0.6 ? best : null;
}
