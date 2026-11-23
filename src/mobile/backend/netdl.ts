/**
 * "Download" without yt-dlp (iPhone: Apple does not allow Python / FFmpeg inside apps).
 * Everything is plain HTTPS through the native layer (no CORS), the file is written in pieces by the Teto plugin:
 *  - SoundCloud: the public api-v2 → the plain MP3 stream (progressive or HLS) → ID3 with title, artist and cover;
 *  - YouTube / YouTube Music: the InnerTube player of the YouTube VR / iOS apps → the M4A (AAC) audio stream, in pieces;
 *  - VK Music: direct MP3 or HLS (AES-128 segments are decrypted, MPEG-TS is unpacked) → MP3 with ID3;
 *  - Spotify links: the name is read from the page and looked up in the chosen source.
 */
import { native, type NativeTrack } from '../native';
import { getBytes, H } from './http';
import { netSearch, relevance, scClientId, VK_UA, type NetItem, type NetSource } from './online';

export interface DlArgs { id: string; url: string; title: string; artist: string; source: string; thumb: string; songAlbum: string; album: string; albumArtist: string; no: number; disc: number; year: number; src: NetSource }
type Emit = (x: { id: string; state: string; progress: number; message: string; title?: string; artist?: string }) => void;

const json = (d: any) => (typeof d === 'string' ? (d ? JSON.parse(d) : null) : d);
const cancelled = new Set<string>();
export const cancelDl = (id: string) => { cancelled.add(id); };
const check = (id: string) => { if (cancelled.has(id)) throw new Error('Отменено'); };

/* ---------- bytes ---------- */
export const b64ToBytes = (b: string) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
export function bytesToB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000)));
  return btoa(s);
}
const concat = (parts: Uint8Array[]) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };

async function bytes(url: string, headers?: Record<string, string>, tries = 3): Promise<Uint8Array> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await getBytes(url, headers);
      if (r.status >= 400) throw new Error('HTTP ' + r.status);
      return b64ToBytes(r.b64);
    } catch (e) { last = e; await new Promise((f) => setTimeout(f, 400 * (i + 1))); }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** The file is written next to the library in pieces (no huge strings in memory). */
class Sink {
  private first = true;
  constructor(private name: string) {}
  path = '';
  async write(u: Uint8Array | string) {
    const data = typeof u === 'string' ? u : bytesToB64(u);
    const r = await native.plugin.writeChunk({ name: this.name, data, append: !this.first });
    this.first = false; this.path = r.path;
  }
}

/* ---------- ID3v2.3 (title, artist, album, cover) ---------- */
function frame(id: string, body: Uint8Array): Uint8Array {
  const n = body.length, o = new Uint8Array(10 + n);
  for (let i = 0; i < 4; i++) o[i] = id.charCodeAt(i);
  o[4] = (n >>> 24) & 255; o[5] = (n >>> 16) & 255; o[6] = (n >>> 8) & 255; o[7] = n & 255;
  o.set(body, 10);
  return o;
}
function text(id: string, v: string): Uint8Array | null {
  if (!v) return null;
  const b = new Uint8Array(1 + 2 + v.length * 2 + 2);
  b[0] = 1; b[1] = 0xff; b[2] = 0xfe; // UTF-16 with BOM (little endian)
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); b[3 + i * 2] = c & 255; b[4 + i * 2] = c >> 8; }
  return frame(id, b);
}
export function id3(title: string, artist: string, album: string, pic: Uint8Array | null): Uint8Array {
  const fr: Uint8Array[] = [];
  for (const f of [text('TIT2', title), text('TPE1', artist), text('TALB', album)]) if (f) fr.push(f);
  if (pic && pic.length) {
    const png = pic[0] === 0x89 && pic[1] === 0x50;
    const mime = png ? 'image/png' : 'image/jpeg';
    const head = new Uint8Array(1 + mime.length + 1 + 1 + 1);
    for (let i = 0; i < mime.length; i++) head[1 + i] = mime.charCodeAt(i);
    head[mime.length + 2] = 3; // front cover; encoding latin1, empty description
    fr.push(frame('APIC', concat([head, pic])));
  }
  const body = concat(fr), n = body.length;
  const h = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, (n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
  return concat([h, body]);
}

/* ---------- HLS (VK, SoundCloud): segments 4 at a time, AES-128, MPEG-TS → elementary stream ---------- */
/** MPEG-TS → the payload of the first audio PES stream; anything that is not TS is returned as is. */
export function demux(ts: Uint8Array): Uint8Array {
  if (ts.length < 188 || ts[0] !== 0x47) return ts;
  const out: Uint8Array[] = [];
  let audioPid = -1;
  for (let o = 0; o + 188 <= ts.length; o += 188) {
    if (ts[o] !== 0x47) { let n = o + 1; while (n + 188 <= ts.length && !(ts[n] === 0x47 && (n + 188 >= ts.length || ts[n + 188] === 0x47))) n++; o = n - 188; continue; }
    const pid = ((ts[o + 1] & 0x1f) << 8) | ts[o + 2];
    const start = (ts[o + 1] & 0x40) !== 0;
    const afc = (ts[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc & 2) p += 1 + ts[p];
    if ((afc & 1) === 0 || p >= o + 188) continue;
    if (start && p + 9 <= o + 188 && ts[p] === 0 && ts[p + 1] === 0 && ts[p + 2] === 1) {
      const sid = ts[p + 3];
      if (audioPid < 0 && sid >= 0xc0 && sid <= 0xdf) audioPid = pid;
      if (pid !== audioPid) continue;
      p += 9 + ts[p + 8];
    } else if (pid !== audioPid) continue;
    if (p < o + 188) out.push(ts.subarray(p, o + 188));
  }
  return audioPid < 0 ? ts : concat(out);
}
const resolveUrl = (base: string, rel: string) => { try { return new URL(rel, base).toString(); } catch { return rel; } };
const hex = (s: string) => { s = s.replace(/^0x/i, ''); const b = new Uint8Array(16); for (let i = 0; i < 16 && i * 2 + 1 < s.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return b; };
async function getText(url: string, headers?: Record<string, string>) { const r = await H.get(url, undefined, headers); if (r.status >= 400) throw new Error('HTTP ' + r.status); return String(r.data ?? ''); }

export async function hls(id: string, url: string, headers: Record<string, string> | undefined, onP: (p: number) => void): Promise<Uint8Array> {
  let pl = await getText(url, headers);
  if (pl.includes('#EXT-X-STREAM-INF')) {
    const v = pl.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (v) { url = resolveUrl(url, v); pl = await getText(url, headers); }
  }
  const segs: { url: string; key: string | null; iv: Uint8Array | null }[] = [];
  let key: string | null = null, iv: Uint8Array | null = null, seq = 0;
  for (let l of pl.split('\n')) {
    l = l.trim();
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = +l.slice(22) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a: Record<string, string> = {};
      for (const m of l.slice(11).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) a[m[1]] = m[2].replace(/"/g, '');
      if (a.METHOD === 'AES-128') { key = resolveUrl(url, a.URI); iv = a.IV ? hex(a.IV) : null; } else { key = null; iv = null; }
    } else if (l && !l.startsWith('#')) {
      let siv = iv;
      if (key && !siv) { siv = new Uint8Array(16); let n = seq; for (let i = 15; i >= 12; i--) { siv[i] = n & 255; n = Math.floor(n / 256); } }
      segs.push({ url: resolveUrl(url, l), key, iv: siv });
      seq++;
    }
  }
  if (!segs.length) throw new Error('Пустой плейлист');
  const keys = new Map<string, Promise<CryptoKey>>();
  const keyOf = (u: string) => { if (!keys.has(u)) keys.set(u, bytes(u, headers).then((raw) => crypto.subtle.importKey('raw', raw as unknown as ArrayBuffer, 'AES-CBC', false, ['decrypt']))); return keys.get(u)!; };
  const parts: Uint8Array[] = new Array(segs.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < segs.length) {
      const k = next++;
      check(id);
      const s = segs[k];
      let b = await bytes(s.url, headers);
      if (s.key && s.iv) b = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: s.iv as unknown as ArrayBuffer }, await keyOf(s.key), b as unknown as ArrayBuffer));
      parts[k] = demux(b);
      onP(++done / segs.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return concat(parts);
}
const isAdts = (b: Uint8Array) => !(b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) && b.length > 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0;

/* ---------- YouTube ---------- */
const CLIENTS = [
  { name: 'ANDROID_VR', id: '28', ver: '1.65.10', ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip', extra: { deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' } },
  { name: 'IOS', id: '5', ver: '20.10.4', ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)', extra: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' } },
];
export const ytId = (url: string) => url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)?.[1] ?? null;
async function ytStream(vid: string): Promise<{ url: string; len: number; ua: string; title: string; author: string }> {
  let why = '';
  for (const c of CLIENTS) {
    try {
      const r = await H.post('https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        { context: { client: { clientName: c.name, clientVersion: c.ver, hl: 'ru', gl: 'RU', ...c.extra } }, videoId: vid, contentCheckOk: true, racyCheckOk: true },
        { 'Content-Type': 'application/json', 'User-Agent': c.ua, 'X-YouTube-Client-Name': c.id, 'X-YouTube-Client-Version': c.ver });
      const j = json(r.data);
      if (j?.playabilityStatus?.status !== 'OK') { why = j?.playabilityStatus?.reason || j?.playabilityStatus?.status || ''; continue; }
      const af: any[] = (j.streamingData?.adaptiveFormats ?? []).filter((f: any) => f.url && /^audio\/mp4/.test(f.mimeType ?? ''));
      const f = af.find((x) => x.itag === 140) ?? af.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!f) { why = 'нет аудиопотока'; continue; }
      return { url: f.url, len: +f.contentLength || 0, ua: c.ua, title: j.videoDetails?.title ?? '', author: String(j.videoDetails?.author ?? '').replace(/\s*-\s*Topic$/, '') };
    } catch (e) { why = String((e as Error)?.message ?? e); }
  }
  throw new Error(why ? `YouTube не отдал трек (${why}). Попробуйте SoundCloud` : 'YouTube не отдал трек. Попробуйте SoundCloud');
}

/* ---------- SoundCloud ---------- */
async function scTrack(url: string): Promise<any> {
  const cid = await scClientId(H);
  let r = await H.get('https://api-v2.soundcloud.com/resolve', { url, client_id: cid });
  if (r.status === 401 || r.status === 403) { localStorage.removeItem('teto.sc.cid'); r = await H.get('https://api-v2.soundcloud.com/resolve', { url, client_id: await scClientId(H, true) }); }
  const j = json(r.data);
  if (!j?.media) throw new Error('SoundCloud: трек не найден');
  return j;
}

/* ---------- download queue (2 at a time) ---------- */
let running = 0;
const q: (() => Promise<void>)[] = [];
const pump = () => { while (running < 2 && q.length) { const f = q.shift()!; running++; f().finally(() => { running--; pump(); }); } };

const clean = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'track';
const split = (s: string) => { const m = s.match(/^(.+?)\s+[-–—]\s+(.+)$/); return m ? { artist: m[1].trim(), title: m[2].replace(/\s*[([](official|lyric|audio|video|клип|премьера)[^)\]]*[)\]]/gi, '').trim() } : null; };

export function startDownload(a: DlArgs, emit: Emit, imported: (t: NativeTrack[]) => Promise<void>) {
  cancelled.delete(a.id);
  emit({ id: a.id, state: 'queued', progress: 0, message: 'В очереди' });
  q.push(async () => {
    const say = (progress: number, message: string) => emit({ id: a.id, state: 'running', progress, message });
    try {
      check(a.id);
      say(0, 'Подготовка…');
      const r = await fetchOne(a, say);
      check(a.id);
      say(1, 'Сохраняю в медиатеку…');
      const { path } = await native.plugin.finishFile({ tmp: r.tmp, name: clean((r.artist ? r.artist + ' - ' : '') + (r.title || 'track')) + r.ext });
      const t = (await native.plugin.probe({ paths: [path] })).tracks[0];
      if (!t) throw new Error('Файл не похож на музыку');
      if (r.title) t.title = r.title;
      if (r.artist) t.artist = r.artist;
      if (a.album) { t.album = a.album; t.albumArtist = a.albumArtist || r.artist; if (a.no) t.no = a.no; if (a.disc) t.disc = a.disc; if (a.year) t.year = a.year; t.force = true; }
      else if (r.album && !t.album) t.album = r.album;
      await imported([t]);
      emit({ id: a.id, state: 'done', progress: 1, message: 'Готово · в медиатеке', title: r.title, artist: r.artist });
    } catch (e) {
      emit({ id: a.id, state: 'failed', progress: 0, message: String((e as Error)?.message ?? e).slice(0, 160) || 'Ошибка скачивания' });
    } finally { cancelled.delete(a.id); }
  });
  pump();
}

interface Got { tmp: string; ext: string; title: string; artist: string; album: string }

async function fetchOne(a: DlArgs, say: (p: number, m: string) => void): Promise<Got> {
  const u = a.url.toLowerCase();
  const sink = new Sink(`${a.id}.part`);
  const pct = (p: number) => say(p, `Скачиваю ${Math.round(p * 100)}%`);

  /* VK Music */
  if (a.source === 'vk' || u.includes('vkuseraudio.') || u.includes('vk-cdn.') || (u.includes('.m3u8') && u.includes('vk'))) {
    say(0, 'ВК: получаю трек…');
    const hd = { 'User-Agent': VK_UA };
    const audio = u.includes('.m3u8') ? await hls(a.id, a.url, hd, pct) : await bytes(a.url, hd);
    const aac = isAdts(audio);
    if (!aac) await sink.write(id3(a.title, a.artist, a.album || a.songAlbum, a.thumb ? await bytes(a.thumb, undefined, 1).catch(() => null) : null));
    await sink.write(audio);
    return { tmp: sink.path, ext: aac ? '.aac' : '.mp3', title: a.title, artist: a.artist, album: a.songAlbum };
  }

  /* SoundCloud */
  if (u.includes('soundcloud.com')) {
    say(0, 'SoundCloud: получаю трек…');
    const tr = await scTrack(a.url.split('?')[0]);
    const tcs: any[] = tr.media?.transcodings ?? [];
    const plain = tcs.filter((x) => !/encrypted/.test(x?.format?.protocol ?? ''));
    const pick = plain.find((x) => x.format?.protocol === 'progressive' && /mpeg/.test(x.format?.mime_type ?? ''))
      ?? plain.find((x) => x.format?.protocol === 'hls' && /mpeg/.test(x.format?.mime_type ?? ''))
      ?? plain.find((x) => x.format?.protocol === 'progressive');
    if (!pick) throw new Error('SoundCloud: этот трек защищён от скачивания');
    const cid = await scClientId(H);
    const s = json((await H.get(pick.url, { client_id: cid, ...(tr.track_authorization ? { track_authorization: tr.track_authorization } : {}) })).data);
    if (!s?.url) throw new Error('SoundCloud: нет ссылки на поток');
    const m = String(tr.title || '').match(/^(.+?)\s+[-–—]\s+(.+)$/);
    const artist = a.artist || tr.publisher_metadata?.artist || (m ? m[1] : tr.user?.username) || '';
    const title = a.title || (m && !tr.publisher_metadata?.artist ? m[2] : tr.title) || '';
    const art = String(tr.artwork_url || a.thumb || '').replace(/-(large|t300x300)\./, '-t500x500.');
    const pic = art ? await bytes(art, undefined, 1).catch(() => null) : null;
    await sink.write(id3(title, artist, a.album || tr.publisher_metadata?.album_title || '', pic));
    if (pick.format.protocol === 'hls') await sink.write(await hls(a.id, s.url, undefined, pct));
    else {
      pct(0.05);
      const r = await getBytes(s.url, undefined, 60000);
      if (r.status >= 400) throw new Error('SoundCloud: HTTP ' + r.status);
      await sink.write(r.b64);
      pct(1);
    }
    return { tmp: sink.path, ext: '.mp3', title, artist, album: tr.publisher_metadata?.album_title || '' };
  }

  /* YouTube / YouTube Music */
  const vid = ytId(a.url);
  if (vid) {
    say(0, 'YouTube: получаю трек…');
    const st = await ytStream(vid);
    const sp = split(st.title);
    const title = a.title || sp?.title || st.title, artist = a.artist || sp?.artist || st.author;
    const CH = 1 << 20; // 1 MB pieces: YouTube slows down long single requests
    const len = st.len;
    if (len) {
      for (let p = 0; p < len; p += CH) {
        check(a.id);
        const r = await getBytes(`${st.url}&range=${p}-${Math.min(len, p + CH) - 1}`, { 'User-Agent': st.ua }, 30000);
        if (r.status >= 400) throw new Error('YouTube: HTTP ' + r.status);
        await sink.write(r.b64);
        pct(Math.min(1, (p + CH) / len));
      }
    } else {
      const r = await getBytes(st.url, { 'User-Agent': st.ua }, 90000);
      if (r.status >= 400) throw new Error('YouTube: HTTP ' + r.status);
      await sink.write(r.b64);
    }
    return { tmp: sink.path, ext: '.m4a', title, artist, album: a.songAlbum };
  }

  /* Spotify: the name from the page → the chosen source */
  if (u.includes('spotify.com') || u.startsWith('spotify:')) {
    say(0, 'Spotify: узнаю название…');
    const page = await getText(a.url.replace(/^spotify:track:/, 'https://open.spotify.com/track/'), { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    const og = (p: string) => page.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`))?.[1]?.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"') ?? '';
    const title = og('title');
    const artist = og('description').split(' · ')[0] || '';
    if (!title) throw new Error('Spotify: не удалось узнать название');
    const best = await bestMatch(`${artist} ${title}`, artist, title, a.src === 'vk' ? 'all' : a.src);
    if (!best) throw new Error(`Не нашлось: ${artist} — ${title}`);
    return fetchOne({ ...a, url: best.url, source: best.source, thumb: best.thumb ?? '', title, artist, songAlbum: best.album ?? '' }, say);
  }
  throw new Error('На iPhone скачиваются ссылки YouTube, SoundCloud, Spotify и ВК');
}

/** The best search result for "artist title" (Spotify links). */
async function bestMatch(q: string, artist: string, title: string, src: NetSource): Promise<NetItem | null> {
  const { items } = await netSearch(H, q, src);
  let best: NetItem | null = null, score = 0;
  for (const it of items) {
    const s = relevance(`${artist} ${title}`, it) + (it.song ? 0.1 : 0);
    if (s > score) { score = s; best = it; }
  }
  return score >= 0.6 ? best : null;
}
