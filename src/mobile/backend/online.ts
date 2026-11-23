/**
 * Fast internet search for "Download" (phone): plain HTTPS requests instead of starting yt-dlp (Python) for every query.
 *  - YouTube Music "songs" (official tracks with artist / album / length) + ordinary YouTube videos (InnerTube API),
 *  - SoundCloud (public api-v2; the web client_id is read from soundcloud.com and remembered),
 *  - VK Music — only when the user connected VK (Settings → Download); the token stays on this device.
 * Every source is optional: what fails is skipped, if all fail the caller falls back to yt-dlp search.
 */
export interface NetItem { url: string; title: string; artist: string; dur: number; thumb?: string; source: 'youtube' | 'soundcloud' | 'vk'; song?: boolean; album?: string }
export interface Http {
  get(url: string, params?: Record<string, string>, headers?: Record<string, string>): Promise<{ status: number; data: any }>;
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; data: any }>;
}
const json = (d: any) => (typeof d === 'string' ? (d ? JSON.parse(d) : null) : d);
const dur = (s: string) => s.split(':').reduce((a, x) => a * 60 + (+x || 0), 0);

/* ---------------- YouTube (InnerTube) ---------------- */
const YTM_SONGS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D', YT_VIDEOS = 'EgIQAQ%3D%3D';
async function ytm(h: Http, q: string): Promise<NetItem[]> {
  const r = await h.post('https://music.youtube.com/youtubei/v1/search?prettyPrint=false',
    { context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250101.01.00', hl: 'ru', gl: 'RU' } }, query: q, params: YTM_SONGS },
    { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com' });
  const j = json(r.data);
  const out: NetItem[] = [];
  const secs = j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  for (const s of secs) for (const it of s?.musicShelfRenderer?.contents ?? []) {
    const m = it.musicResponsiveListItemRenderer;
    const id = m?.playlistItemData?.videoId;
    const cols = m?.flexColumns ?? [];
    const title = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
    if (!id || !title) continue;
    const runs: any[] = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
    const type = (x: any) => x?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType ?? '';
    const artists = runs.filter((x) => type(x) === 'MUSIC_PAGE_TYPE_ARTIST').map((x) => x.text);
    const album = runs.find((x) => type(x) === 'MUSIC_PAGE_TYPE_ALBUM')?.text;
    const len = [...runs].reverse().find((x) => /^\d+(:\d+)+$/.test(x.text ?? ''))?.text;
    const th: any[] = m?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
    out.push({ url: `https://music.youtube.com/watch?v=${id}`, title, artist: artists.join(', ') || runs[0]?.text || '', dur: len ? dur(len) : 0, thumb: String(th[th.length - 1]?.url ?? '').replace(/=w\d+-h\d+/, '=w300-h300'), source: 'youtube', song: true, album });
  }
  return out;
}
function* walk(o: any, key: string): Generator<any> {
  if (Array.isArray(o)) { for (const v of o) yield* walk(v, key); return; }
  if (o && typeof o === 'object') { if (o[key]) yield o[key]; for (const k in o) if (k !== key) yield* walk(o[k], key); }
}
async function ytVideos(h: Http, q: string): Promise<NetItem[]> {
  const r = await h.post('https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
    { context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'ru', gl: 'RU' } }, query: q, params: YT_VIDEOS },
    { 'Content-Type': 'application/json' });
  const out: NetItem[] = [];
  for (const v of walk(json(r.data), 'videoRenderer')) {
    const title: string = v.title?.runs?.[0]?.text ?? '';
    const d = dur(v.lengthText?.simpleText ?? '');
    if (!v.videoId || !title || !d || d > 20 * 60) continue; // live streams, mixes and hour-long videos are not songs
    const ch: string = (v.ownerText?.runs?.[0]?.text ?? '').replace(/\s*-\s*Topic$/, '');
    const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    out.push({ url: `https://www.youtube.com/watch?v=${v.videoId}`, title: m ? m[2] : title, artist: m ? m[1] : ch, dur: d, thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`, source: 'youtube' });
    if (out.length >= 15) break;
  }
  return out;
}

/* ---------------- SoundCloud ---------------- */
const SCKEY = 'teto.sc.cid';
async function scClientId(h: Http, fresh = false): Promise<string> {
  if (!fresh) { const c = localStorage.getItem(SCKEY); if (c) return c; }
  const page = String((await h.get('https://soundcloud.com/')).data ?? '');
  const scripts = [...String(page).matchAll(/<script crossorigin src="([^"]+)"/g)].map((m) => m[1]).reverse();
  for (const s of scripts) {
    const js = String((await h.get(s)).data);
    const m = js.match(/client_id\s*[:=]\s*"([0-9a-zA-Z]{32})"/);
    if (m) { localStorage.setItem(SCKEY, m[1]); return m[1]; }
  }
  throw new Error('soundcloud client_id');
}
async function soundcloud(h: Http, q: string, retry = true): Promise<NetItem[]> {
  const cid = await scClientId(h);
  const r = await h.get('https://api-v2.soundcloud.com/search/tracks', { q, client_id: cid, limit: '15' });
  if ((r.status === 401 || r.status === 403) && retry) { localStorage.removeItem(SCKEY); await scClientId(h, true); return soundcloud(h, q, false); }
  return (json(r.data)?.collection ?? []).filter((c: any) => c.permalink_url && c.policy !== 'BLOCK' && c.policy !== 'SNIP' && c.duration < 20 * 60e3
    // only DRM ("encrypted-hls") can't be downloaded: official tracks usually also have a plain MP3 stream — keep those
    && (c.media?.transcodings ?? []).some((t: any) => !/encrypted/.test(t?.format?.protocol ?? ''))).map((c: any) => {
    const m = String(c.title).match(/^(.+?)\s+[-–—]\s+(.+)$/);
    const artist = c.publisher_metadata?.artist || (m ? m[1] : c.user?.username) || '';
    return { url: c.permalink_url, title: m && !c.publisher_metadata?.artist ? m[2] : c.title, artist, dur: Math.round((c.full_duration || c.duration) / 1000), thumb: (c.artwork_url || c.user?.avatar_url || '').replace('-large', '-t300x300'), source: 'soundcloud' as const };
  });
}

/* ---------------- VK Music ---------------- */
export const VK_UA = 'KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)';
const VKKEY = 'teto.vk';
export interface VkAuth { token: string; user: string; name?: string }
export const vkAuth = (): VkAuth | null => { try { return JSON.parse(localStorage.getItem(VKKEY) || 'null'); } catch { return null; } };
export const setVkAuth = (a: VkAuth | null) => { if (a) localStorage.setItem(VKKEY, JSON.stringify(a)); else localStorage.removeItem(VKKEY); };
export class VkError extends Error { constructor(public code: number, msg: string) { super(msg); } }
export async function vk(h: Http, method: string, params: Record<string, string>): Promise<any> {
  const a = vkAuth();
  if (!a) throw new VkError(5, 'ВК не подключён');
  const r = await h.get(`https://api.vk.com/method/${method}`, { ...params, access_token: a.token, v: '5.131', lang: 'ru', https: '1' }, { 'User-Agent': VK_UA });
  const j = json(r.data);
  if (j?.error) {
    if (j.error.error_code === 5) setVkAuth(null); // the token was revoked: ask to connect again
    throw new VkError(j.error.error_code, j.error.error_msg || 'VK error');
  }
  return j?.response;
}
const vkThumb = (x: any) => x?.album?.thumb?.photo_600 || x?.album?.thumb?.photo_300 || x?.album?.thumb?.photo_270 || '';
export async function vkSearch(h: Http, q: string): Promise<NetItem[]> {
  const r = await vk(h, 'audio.search', { q, count: '30', sort: '0', auto_complete: '1' });
  return (r?.items ?? []).filter((x: any) => x.url && x.title).map((x: any) => ({
    url: String(x.url), title: String(x.subtitle ? `${x.title} (${x.subtitle})` : x.title), artist: String(x.artist || ''), dur: x.duration || 0,
    thumb: vkThumb(x), source: 'vk' as const, song: true, album: x.album?.title,
  }));
}
/** Album track list from VK Music (for "Hints"): best album by the same fuzzy rules as iTunes / Deezer. */
export async function vkAlbums(h: Http, q: string): Promise<{ id: number; owner_id: number; access_key: string; title: string; artist: string; count: number }[]> {
  const r = await vk(h, 'audio.searchAlbums', { q, count: '20' });
  return (r?.items ?? []).map((p: any) => ({ id: p.id, owner_id: p.owner_id, access_key: p.access_key || '', title: String(p.title || ''), artist: (p.main_artists ?? []).map((a: any) => a.name).join(', ') || String(p.artist || ''), count: p.count || 0 }));
}
export async function vkAlbumTracks(h: Http, a: { id: number; owner_id: number; access_key: string }) {
  const r = await vk(h, 'audio.get', { owner_id: String(a.owner_id), album_id: String(a.id), access_key: a.access_key, count: '300' });
  return (r?.items ?? []).map((x: any, i: number) => ({ no: i + 1, disc: 1, title: String(x.subtitle ? `${x.title} (${x.subtitle})` : x.title), dur: x.duration || 0 }));
}
export async function vkMe(h: Http): Promise<string> {
  const r = await vk(h, 'users.get', {});
  const u = r?.[0];
  return u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() : '';
}

/* ---------------- all together ---------------- */
export type NetSource = 'all' | 'youtube' | 'soundcloud' | 'vk';
const key = (x: NetItem) => (x.artist + x.title).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '') + Math.round(x.dur / 4);

/* relevance: the same words in Cyrillic and Latin ("кино группа крови" = "kino gruppa krovi"), ё = е */
const TR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'u', я: 'ya' };
/** Lower-case Latin words: Cyrillic is transliterated, similar Latin spellings are folded (kh→h, ts→c, yu→u, j→i). */
export function words(s: string): string[] {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[а-я]/g, (c) => TR[c] ?? c)
    .replace(/kh/g, 'h').replace(/ts/g, 'c').replace(/y[uo]/g, 'u').replace(/j/g, 'i').replace(/w/g, 'v')
    .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0 && !['the', 'feat', 'ft', 'official', 'video', 'audio', 'lyrics', 'music'].includes(w));
}
const JUNK = /remix|ремикс|cover|кавер|karaoke|караоке|минус|instrumental|nightcore|slowed|sped up|speed up|8d|reverb|bass boost|1 ?hour|час\b/i;
/** 0 … 1: how much of the query is in the result (artist + title), with a small bonus for official songs. */
export function relevance(q: string, it: { title: string; artist: string; song?: boolean }): number {
  const qw = words(q);
  if (!qw.length) return 0;
  const hay = words(`${it.artist} ${it.title}`);
  let hit = 0;
  for (const w of qw) if (hay.some((h) => h === w || (w.length >= 3 && (h.startsWith(w) || (h.length >= 4 && w.startsWith(h)))))) hit++;
  let s = hit / qw.length;
  if (JUNK.test(it.title) && !JUNK.test(q)) s -= 0.3;
  if (it.song) s += 0.05;
  return s;
}

/**
 * Chosen sources in parallel (Settings → Download → "Where from"). The best matches for the query come first
 * (Cyrillic and Latin spellings count the same), official songs before videos, no duplicates.
 */
export async function netSearch(h: Http, q: string, src: NetSource = 'all'): Promise<{ items: NetItem[]; ok: number }> {
  const none = Promise.resolve<NetItem[]>([]);
  const want = (x: NetSource) => src === 'all' || src === x;
  const useVk = want('vk') && !!vkAuth();
  const srcs: Promise<NetItem[]>[] = [want('youtube') ? ytm(h, q) : none, useVk ? vkSearch(h, q) : none, want('soundcloud') ? soundcloud(h, q) : none, want('youtube') ? ytVideos(h, q) : none];
  const res = await Promise.allSettled(srcs.map((p) => withTimeout(p, 9000)));
  if (src === 'vk' && !useVk) throw new Error('ВК не подключён: Настройки → Скачивание → ВК Музыка');
  const lists = res.map((r) => (r.status === 'fulfilled' ? r.value : []));
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  if (lists.every((l) => !l.length)) {
    const err = res.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (err && src !== 'all') throw err.reason instanceof Error ? err.reason : new Error(String(err.reason));
  }
  const [songs, vkl, sc, vids] = lists;
  const order: NetItem[] = [];
  const rest = [songs, vkl, sc, vids];
  for (let i = 0; rest.some((l) => i < l.length); i++) for (const l of rest) if (i < l.length) order.push(l[i]);
  const seen = new Set<string>();
  const uniq = order.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
  // stable: within the same relevance step the interleaved order (songs · VK · SoundCloud · videos) stays
  const step = (x: NetItem) => { const r = relevance(q, x); return r >= 0.99 ? 3 : r >= 0.66 ? 2 : r >= 0.34 ? 1 : 0; };
  const ranked = uniq.map((x, i) => ({ x, i, s: step(x) })).sort((a, b) => b.s - a.s || a.i - b.i).map((o) => o.x);
  return { items: ranked, ok };
}
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
}
export { scClientId };
