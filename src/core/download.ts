/**
 * "Download" — works like Dot Player:
 *  - one field: a link (YouTube, SoundCloud, Spotify track, anything yt-dlp knows) downloads at once,
 *    words ("artist — title") search YouTube + SoundCloud; a tap on a result downloads it;
 *  - downloads run in the background with progress (phone: yt-dlp + FFmpeg inside the app → MP3 with cover and tags,
 *    a notification keeps them alive; desktop: the same fast search as the phone + yt-dlp, progress, ✕, tags and cover);
 *  - links shared to Teto ("Share" → Teto) open this screen and start;
 *  - album hints ("Download" next to a missing song) pick the best match by themselves, otherwise show the results.
 */
import { useSyncExternalStore } from 'react';
import { call, isMobile, isTauri, on } from '../app/api';
import { deskBest, deskSearch, spotifyName } from './netdesk';
import { getState, navigate, toast } from '../app/store';
import { titleKey } from './hints';
import { prefs } from './prefs';
import { t } from '../i18n';

export type DlSource = 'youtube' | 'soundcloud' | 'vk' | 'spotify' | 'link';
export interface DlItem { url: string; title: string; artist: string; dur: number; thumb?: string; source: DlSource; song?: boolean; album?: string }
export type DlState = 'queued' | 'running' | 'done' | 'failed';
/** Album context: a song downloaded from an album page goes into that album. */
export interface DlMeta { album: string; albumArtist: string; no?: number; disc?: number; year?: number }
export interface DlJob { id: string; url: string; title: string; artist: string; progress: number; state: DlState; message: string }

export const SOURCE_LABEL: Record<DlSource, string> = { youtube: 'YouTube', soundcloud: 'SoundCloud', vk: 'ВК', spotify: 'Spotify', link: 'Ссылка' };
/** Sources the phone can search (Settings → Download → "Where from"). */
export const NET_SOURCES = [['all', 'Везде'], ['youtube', 'YouTube'], ['soundcloud', 'SoundCloud'], ['vk', 'ВК']] as const;

const URL_RE = /https?:\/\/\S+/i;
export const extractUrl = (s: string) => s.match(URL_RE)?.[0].replace(/[).,;]+$/, '') ?? null;
export function sourceOf(url: string): DlSource {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('soundcloud.com')) return 'soundcloud';
  if (u.includes('vkuseraudio.') || u.includes('vk-cdn.') || (u.includes('.m3u8') && u.includes('vk'))) return 'vk';
  if (u.includes('spotify.com') || u.startsWith('spotify:')) return 'spotify';
  return 'link';
}

/* ---------- jobs (newest first) ---------- */
let jobs: DlJob[] = [];
const subs = new Set<() => void>();
const set = (l: DlJob[]) => { jobs = l; subs.forEach((f) => f()); };
const patch = (id: string, p: Partial<DlJob>) => set(jobs.map((j) => (j.id === id ? { ...j, ...p } : j)));
export const useDlJobs = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => jobs);
export const clearFinished = () => set(jobs.filter((j) => j.state === 'queued' || j.state === 'running'));

on<{ id: string; state: DlState; progress: number; message: string; title?: string; artist?: string }>('dl', (x) => {
  if (!jobs.some((j) => j.id === x.id)) return;
  patch(x.id, { state: x.state, progress: x.progress, message: x.message, ...(x.title ? { title: x.title } : {}), ...(x.artist ? { artist: x.artist } : {}) });
  if (x.state === 'done') toast(t('Скачано: {0}', x.title || jobs.find((j) => j.id === x.id)?.title || ''));
}).catch(() => {});

/* ---------- shared links / text → this screen ---------- */
let pendingShare: string | null = null;
const shareSubs = new Set<(s: string) => void>();
on<{ text: string }>('shared_text', ({ text }) => {
  if (isMobile) {
    // phone: a shared link downloads at once, shared words are searched on the internet (search screen)
    const url = extractUrl(text);
    if (url) { enqueue({ url, title: '', artist: '' }); navigate({ kind: 'search', q: '' }); toast(t('Скачиваю по ссылке…')); }
    else navigate({ kind: 'search', q: text.trim(), net: true });
    return;
  }
  pendingShare = text;
  navigate({ kind: 'download' });
  shareSubs.forEach((f) => f(text));
}).catch(() => {});
/** The Download screen takes the shared text (once). */
export function takeShare(): string | null { const s = pendingShare; pendingShare = null; return s; }
export function onShare(f: (s: string) => void) { shareSubs.add(f); return () => { shareSubs.delete(f); }; }

/* ---------- engine (phone) ---------- */
export interface Engine { ready: boolean; updating: boolean; version: string; error: string }
export const engine = () => (isMobile ? call<Engine>('dl_engine') : Promise.resolve<Engine>({ ready: true, updating: false, version: '', error: '' }));
export const updateEngine = () => call<{ version: string }>('dl_update');

/* ---------- search ---------- */
export async function search(q: string, src = prefs().dlSrc ?? 'all'): Promise<DlItem[]> {
  if (getState().settings.offline) throw new Error(t('Офлайн-режим: сеть выключена в настройках'));
  if (!isMobile && isTauri) {
    // desktop (from the phone): YouTube Music + YouTube + SoundCloud over plain HTTPS; yt-dlp only as a fallback
    try {
      const r = await deskSearch(q, src);
      if (r.items.length || r.ok >= 2) return r.items.map((x) => ({ ...x, source: x.source as DlSource }));
    } catch (e) { if (src === 'soundcloud') throw e; }
    if (src === 'soundcloud') return [];
  }
  const raw = await call<(Omit<DlItem, 'source'> & { source?: string })[]>('yt_search', { q, src, browser: prefs().ytBrowser });
  return raw.map((x) => normalize({ ...x, source: (x.source as DlSource) || 'youtube' }));
}

/** Desktop results from YouTube are often "Artist - Title (Official Video)": split them. */
function normalize(it: DlItem): DlItem {
  if (it.song || it.source !== 'youtube' || isMobile) return it; // the phone splits names natively
  const m = it.title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { ...it, artist: m[1], title: m[2] } : it;
}

/* ---------- download ---------- */
let seq = 0;
export function enqueue(it: Pick<DlItem, 'url' | 'title' | 'artist'> & Partial<Pick<DlItem, 'source' | 'thumb' | 'album'>>, meta?: DlMeta) {
  if (getState().settings.offline) { toast(t('Офлайн-режим: сеть выключена в настройках')); return; }
  const src = sourceOf(it.url);
  if (!isMobile && src !== 'youtube' && src !== 'soundcloud' && src !== 'spotify') { toast(t('На компьютере скачиваются ссылки YouTube, SoundCloud и Spotify')); return; }
  if (jobs.some((j) => j.url === it.url && (j.state === 'queued' || j.state === 'running'))) return;
  const id = `dl${Date.now().toString(36)}${seq++}`;
  set([{ id, url: it.url, title: it.title || it.url, artist: it.artist, progress: 0, state: 'queued', message: t('В очереди') }, ...jobs]);
  if (isMobile) {
    call('yt_download', { id, url: it.url, artist: meta ? meta.albumArtist || it.artist : it.artist, title: it.title, kbps: prefs().dlKbps, source: it.source ?? '', thumb: it.thumb ?? '', songAlbum: it.album ?? '', album: meta?.album ?? '', albumArtist: meta?.albumArtist ?? '', no: meta?.no ?? 0, disc: meta?.disc ?? 0, year: meta?.year ?? 0 }).catch((e) => patch(id, { state: 'failed', message: String(e?.message ?? e) }));
    return;
  }
  // desktop: yt-dlp with progress ("dl" events), at most 2 at a time (an album batch must not start ten processes)
  deskQ.push(async () => {
    if (jobs.find((j) => j.id === id)?.state !== 'queued') return; // cancelled while waiting
    patch(id, { state: 'running', message: t('Скачиваю…') });
    try {
      let job = { url: it.url, artist: it.artist, title: it.title, thumb: it.thumb ?? '', songAlbum: it.album ?? '' };
      if (src === 'spotify') {
        // Spotify (from the phone): the name from the page → the best match in the chosen source
        patch(id, { message: t('Spotify: узнаю название…') });
        const n = await spotifyName(it.url);
        patch(id, { title: n.title, artist: n.artist, message: t('Ищу «{0}»…', n.title) });
        const best = await deskBest(n.artist, n.title, prefs().dlSrc ?? 'all');
        if (!best) throw new Error(t('Не нашлось: {0} — {1}', n.artist, n.title));
        job = { url: best.url, artist: n.artist, title: n.title, thumb: best.thumb ?? '', songAlbum: best.album ?? '' };
      }
      if (jobs.find((j) => j.id === id)?.state !== 'running') return;
      const r = await call<{ title?: string; artist?: string }>('yt_download', {
        id, url: job.url, artist: meta ? meta.albumArtist || job.artist : job.artist, title: job.title, browser: prefs().ytBrowser, thumb: job.thumb, songAlbum: job.songAlbum,
        album: meta?.album ?? '', albumArtist: meta?.albumArtist ?? '', no: meta?.no ?? 0, disc: meta?.disc ?? 0, year: meta?.year ?? 0,
      });
      const title = r?.title || job.title || it.url;
      patch(id, { state: 'done', progress: 1, message: t('Готово · в медиатеке'), title, artist: r?.artist || job.artist });
      toast(t('Скачано: {0}', title));
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).split('\n').filter(Boolean).pop()?.slice(0, 140) || t('Ошибка скачивания');
      patch(id, { state: 'failed', message: msg === 'Отменено' ? t('Отменено') : msg });
    }
  });
  pumpDesk();
}
const deskQ: (() => Promise<unknown>)[] = [];
let deskRun = 0;
function pumpDesk() {
  while (deskRun < 2 && deskQ.length) {
    const f = deskQ.shift()!;
    deskRun++;
    f().finally(() => { deskRun--; pumpDesk(); });
  }
}
export const cancel = (id: string) => {
  // desktop: a job still waiting in the queue simply never starts
  if (!isMobile && jobs.find((j) => j.id === id)?.state === 'queued') { patch(id, { state: 'failed', message: t('Отменено') }); return; }
  call('dl_cancel', { id }).catch(() => {});
};

/* ---------- links from other programs (local API: POST /v1/control/download, docs/API.md) ---------- */
if (isTauri) {
  on<{ url: string }>('api_download', ({ url }) => {
    enqueue({ url, title: '', artist: '' });
    toast(t('Скачиваю по ссылке…'));
  }).catch(() => {});
}

/* ---------- album hints: pick the best match by itself ---------- */
const akey = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\b(official|vevo|topic|music)\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const JUNK = /remix|ремикс|cover|кавер|karaoke|караоке|минус|instrumental|nightcore|slowed|sped up|8d|reverb|1 ?hour/i;

/** The best match for "artist — title" (and the length when known), or null. */
export function pickBest(items: DlItem[], artist: string, title: string, dur = 0): DlItem | null {
  const tk = titleKey(title), ak = akey(artist);
  let best: DlItem | null = null, score = 0;
  for (const it of items) {
    const ik = titleKey(it.title), iak = akey(it.artist);
    let s = 0;
    if (ik === tk) s += 6; else if (tk.length > 2 && ik.length > 2 && (ik.includes(tk) || tk.includes(ik))) s += 3; else continue;
    if (ak && iak) { if (iak === ak) s += 5; else if (iak.includes(ak) || ak.includes(iak)) s += 3; else s -= it.song ? 2 : 4; }
    if (dur && it.dur) s += Math.abs(it.dur - dur) <= 5 ? 2 : Math.abs(it.dur - dur) > 30 ? -3 : 0;
    if (JUNK.test(it.title) && !JUNK.test(title)) s -= 3;
    if (it.song) s += 1;
    if (it.source === 'youtube') s += 0.5; // YouTube Music usually has the album version
    if (s > score) { score = s; best = it; }
  }
  return score >= 6 ? best : null;
}

/** "Download" next to a missing album song: best match → download into this album; otherwise the Download screen. */
export async function quickDownload(artist: string, title: string, dur = 0, meta?: DlMeta, silent = false): Promise<boolean> {
  const q = `${artist} - ${title}`.replace(/^ - /, '');
  try {
    if (!silent) toast(t('Ищу «{0}»…', title));
    let items = await search(q);
    let hit = pickBest(items, artist, title, dur);
    if (!hit && meta?.album) { items = await search(`${artist} ${title} ${meta.album}`); hit = pickBest(items, artist, title, dur); }
    // the album page knows the real names: keep them, not the video title (VK: its cover goes into the file)
    if (hit) { enqueue({ url: hit.url, artist, title, source: hit.source, thumb: hit.thumb }, meta); if (!silent) toast(t('Скачиваю «{0}»…', title)); return true; }
  } catch (e) { console.warn('dl', e); }
  if (!silent) navigate(isMobile ? { kind: 'search', q, net: true, meta } : { kind: 'download', q, meta });
  return false;
}

/* ---------- "Download all missing" on an album page ---------- */
export interface AlbumBatch { key: string; done: number; total: number; queued: number; missed: string[]; running: boolean }
let batches: Record<string, AlbumBatch> = {};
const bsubs = new Set<() => void>();
const bset = (b: AlbumBatch) => { batches = { ...batches, [b.key]: b }; bsubs.forEach((f) => f()); };
export const useAlbumBatch = (key: string) => useSyncExternalStore((f) => { bsubs.add(f); return () => { bsubs.delete(f); }; }, () => batches[key]);
/** Finds every missing song (2 searches at a time) and queues the downloads straight into the album. */
export async function downloadAlbum(key: string, artist: string, songs: { title: string; dur: number; meta: DlMeta }[]) {
  if (batches[key]?.running) return;
  if (getState().settings.offline) { toast(t('Офлайн-режим: сеть выключена в настройках')); return; }
  const todo = songs.filter((s) => !jobs.some((j) => j.title === s.title && j.artist === (s.meta.albumArtist || artist) && j.state !== 'failed'));
  let b: AlbumBatch = { key, done: 0, total: todo.length, queued: 0, missed: [], running: true };
  bset(b);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const s = todo[next++];
      const ok = await quickDownload(artist, s.title, s.dur, s.meta, true);
      b = { ...b, done: b.done + 1, queued: b.queued + (ok ? 1 : 0), missed: ok ? b.missed : [...b.missed, s.title] };
      bset(b);
    }
  };
  await Promise.all([worker(), worker()]);
  bset({ ...b, running: false });
  toast(b.missed.length ? t('В очереди: {0} · не нашлось: {1}', b.queued, b.missed.length) : t('Все {0} песен в очереди', b.queued));
}
