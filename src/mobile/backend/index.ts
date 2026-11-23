/**
 * Phone backend: implements the same command / event surface as the Rust core (see api.ts),
 * on top of an <audio> element, localStorage and the native Teto plugin.
 *
 * Battery notes
 *  - audio is decoded by the platform media stack; JS only reacts to events
 *  - nothing is emitted to the UI while it is hidden (position is re-sent on return)
 *  - the native media session is updated only on state changes; the system extrapolates progress
 *  - Web Audio (for the 3D visualizer) is created lazily, only once the visualizer is opened
 */
import type { Album, Artist, PlayerState, Playlist, Repeat, SearchResult, Settings, Track } from '../../core/types';
import { defaultSettings } from '../../app/store';
import { fmtFormat } from '../../core/util';
import { smartShuffle } from '../../core/mix';
import { native, type NativeTrack } from '../native';
import { isIOS as IOS } from '../../app/platform';
import { soundGenre, loudnessOf } from './soundgenre';
import { artistParts, splitArtists } from '../../core/artists';
import { sleep, webGenre, albumTracklist, forgetMissing } from './web';
import { netSearch, setVkAuth, vkAuth, vkMe, vkSearch } from './online';
import { cancelDl, startDownload } from './netdl';
import { prefs } from '../../core/prefs';
import { H } from './http';
import { lyricsFor, lrc, toLyrics, cacheLyr, clearLyrics, type LrcItem } from './lyrics';
import { listenFirst, listenLog, listenPos, listenReset, listenTrack } from './listen';
import { loadNamefix, namefixReady, nf, type NameOut, type Raw } from './namefix';

type Cb = (p: unknown) => void;
const listeners = new Map<string, Set<Cb>>();
const emit = (e: string, p: unknown) => listeners.get(e)?.forEach((cb) => cb(p));

/* ================= library ================= */
interface MTrack extends Track { size: number; added: number; plays: number; cover: string; album_artist: string; raw?: Raw }
interface Ov { title?: string; artist?: string; album?: string }
interface MPlaylist { id: number; name: string; items: number[]; created: number }
interface Lib {
  v: 1; seq: number; tracks: MTrack[]; playlists: MPlaylist[]; custom: Record<number, string>; emb: Record<number, string>; played: Record<number, number>;
  // names (namefix): manual fixes by path, global artist renames, "check this name" marks, artist photos
  ov?: Record<string, Ov>; alias?: Record<string, string>; review?: Record<string, 1 | 2>; photos?: Record<string, string>; nfv?: number;
  wg?: Record<number, { g: string; at: number }>;
  sg?: Record<number, string>; // genre guessed by the sound, when tags and the internet had none
  ld?: Record<string, number | null>; // measured loudness, LUFS, by file path (null = can't be decoded here)
  home?: string; // iOS: app container path (changes after every reinstall / re-sign) // genres from the internet by album id ('' = not found)
}

const LKEY = 'teto.lib.v1';
const lib: Lib = (() => {
  try { const x = JSON.parse(localStorage.getItem(LKEY) || 'null'); if (x && x.v === 1) return x as Lib; } catch { /* corrupted */ }
  return { v: 1, seq: 0, tracks: [], playlists: [], custom: {}, emb: {}, played: {} };
})();
lib.ov ??= {}; lib.alias ??= {}; lib.review ??= {}; lib.photos ??= {}; lib.wg ??= {}; lib.sg ??= {}; lib.ld ??= {};
const OV = lib.ov, ALIAS = lib.alias, REVIEW = lib.review, PHOTOS = lib.photos;
let saveT: number | undefined;
function save(now = false) {
  sIdx = null; // names / favourites may have changed
  clearTimeout(saveT);
  const f = () => { try { localStorage.setItem(LKEY, JSON.stringify(lib)); } catch (e) { console.warn('save', e); } };
  if (now) f(); else saveT = window.setTimeout(f, 400);
}
let byId = new Map<number, MTrack>();
let albumsC: Album[] | null = null;
let coverRev = Date.now();
function reindex() { byId = new Map(lib.tracks.map((t) => [t.id, t])); albumsC = null; sIdx = null; }

/* search index: lower-case names + transliteration keys, built once per library change (typing stays instant) */
type SI = { t: Track; l: [string, string, string]; k: string };
let sIdx: SI[] | null = null;
function searchIdx(): SI[] {
  if (!sIdx) sIdx = lib.tracks.map((t) => ({ t, l: [t.title.toLowerCase(), (t.artist || '').toLowerCase(), (t.album || '').toLowerCase()], k: nf.key(`${t.title} ${t.artist} ${t.album}`) }));
  return sIdx;
}
/** 0 best … 6 worst: title start, word start in the title, inside the title, artist, album, transliteration only. */
function rank(e: SI, q: string, qk: string): number {
  const [ti, ar, al] = e.l;
  if (ti.startsWith(q)) return 0;
  const p = ti.indexOf(q);
  if (p > 0 && !/[\p{L}\p{N}]/u.test(ti[p - 1])) return 1;
  if (p > 0) return 2;
  if (ar.startsWith(q)) return 3;
  if (ar.includes(q)) return 4;
  if (al.includes(q)) return 5;
  return qk.length > 1 && e.k.includes(qk) ? 6 : -1;
}
reindex();
function changed() { reindex(); save(); emit('library', null); }

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 1) || 1; }

const ID3 = 'Blues,Classic Rock,Country,Dance,Disco,Funk,Grunge,Hip-Hop,Jazz,Metal,New Age,Oldies,Other,Pop,R&B,Rap,Reggae,Rock,Techno,Industrial,Alternative,Ska,Death Metal,Pranks,Soundtrack,Euro-Techno,Ambient,Trip-Hop,Vocal,Jazz+Funk,Fusion,Trance,Classical,Instrumental,Acid,House,Game,Sound Clip,Gospel,Noise,AlternRock,Bass,Soul,Punk,Space,Meditative,Instrumental Pop,Instrumental Rock,Ethnic,Gothic,Darkwave,Techno-Industrial,Electronic,Pop-Folk,Eurodance,Dream,Southern Rock,Comedy,Cult,Gangsta,Top 40,Christian Rap,Pop/Funk,Jungle,Native American,Cabaret,New Wave,Psychadelic,Rave,Showtunes,Trailer,Lo-Fi,Tribal,Acid Punk,Acid Jazz,Polka,Retro,Musical,Rock & Roll,Hard Rock'.split(',');
function cleanGenre(g: string) {
  g = (g || '').trim();
  const m = /^\(?(\d{1,3})\)?$/.exec(g);
  if (m) return ID3[+m[1]] ?? '';
  return g.replace(/^\(\d+\)/, '').trim();
}

const UNKNOWN = 'Неизвестный исполнитель', SINGLES = 'Синглы';
const rawOf = (n: NativeTrack): Raw => ({ stem: n.name.replace(/\.[^.]+$/, ''), title: n.title.trim(), artist: n.artist.trim(), album: n.album.trim(), aa: n.albumArtist.trim() });
const albumIdOf = (aa: string, album: string) => hash(aa.toLowerCase() + '|' + album.toLowerCase());

/** Final names + placeholders; keeps the album's picture when the album id changes after a rename. */
function setNames(t: MTrack, title: string, artist: string, album: string, aa: string) {
  t.title = title.trim() || t.raw?.stem || t.title;
  t.artist = artist.trim() || aa.trim() || UNKNOWN;
  t.album = album.trim() || SINGLES;
  t.album_artist = aa.trim() || t.artist;
  const old = t.album_id, id = albumIdOf(t.album_artist, t.album);
  t.album_id = id;
  if (old && old !== id) {
    if (!lib.emb[id] && lib.emb[old]) lib.emb[id] = lib.emb[old];
    if (!lib.custom[id] && lib.custom[old]) lib.custom[id] = lib.custom[old];
  }
  if (t.cover && !lib.emb[id]) lib.emb[id] = t.cover;
}

/** Old behaviour, used only if WebAssembly is unavailable. */
function legacyNames(t: MTrack) {
  const r = t.raw!;
  let title = r.title, artist = r.artist;
  if (!title) {
    const p = r.stem.split(/\s+[-–—]\s+/);
    if (p.length >= 2 && !artist) { artist = p[0].trim(); title = p.slice(1).join(' - ').trim(); } else title = r.stem;
  }
  setNames(t, title, artist, r.album, r.aa);
}

function applyOv(t: MTrack): boolean {
  const o = OV[t.path];
  if (!o || !(o.title || o.artist || o.album)) return false;
  const artist = o.artist || t.artist;
  setNames(t, o.title || t.title, artist, o.album || (t.album === SINGLES ? '' : t.album), o.artist && t.album_artist === t.artist ? artist : t.album_artist);
  return true;
}

/** Same algorithm as namefix_db::Ctx on the desktop: learn from tagged tracks first, then parse file names
 *  against the library (known artists and their tracks), re-check doubtful ones once the index has grown. */
function nameBatch(batch: MTrack[]) {
  if (!namefixReady()) { for (const t of batch) { legacyNames(t); applyOv(t); } return; }
  const inBatch = new Set(batch);
  nf.reset();
  for (const t of lib.tracks) if (!inBatch.has(t) && t.artist !== UNKNOWN) nf.addTrack(t.artist, t.title, t.album === SINGLES ? '' : t.album);
  for (const [k, n] of Object.entries(ALIAS)) nf.addAlias(k, n);
  const res = (t: MTrack) => nf.resolve(t.raw!)!;
  const out = new Map<MTrack, NameOut>();
  for (const t of batch) {
    if (t.raw!.title && t.raw!.artist && !OV[t.path]) { const o = res(t); nf.addTrack(o.artist, o.title, o.album); out.set(t, o); }
  }
  for (const [t, o] of out) if (!o.album) out.set(t, res(t)); // junk album (site name) — maybe a known copy has one
  const recheck: [MTrack, number][] = [];
  for (const t of batch) {
    if (out.has(t)) continue;
    const o = res(t);
    if (o.conf === 2 && o.artist) nf.addTrack(o.artist, o.title, o.album); // learn only from confident results
    if (o.conf < 2) recheck.push([t, nf.artists()]);
    out.set(t, o);
  }
  for (const [t, at] of recheck) if (at < nf.artists()) out.set(t, res(t));
  for (const [t, o] of out) {
    setNames(t, o.title, o.artist, o.album, o.albumArtist);
    if (!t.no && o.no) t.no = o.no;
    const user = applyOv(t);
    if (!user && (o.conf < 2 || o.swapped)) REVIEW[t.path] = o.swapped ? 2 : 1; else delete REVIEW[t.path];
  }
}

function fromNative(n: NativeTrack): MTrack {
  const codec = (n.mime.split('/')[1] || n.name.split('.').pop() || '').replace(/^x-/, '').replace('mpeg', 'mp3').replace('mp4a-latm', 'aac').toUpperCase();
  const lossless = /FLAC|WAV|ALAC|AIFF/.test(codec);
  return {
    id: ++lib.seq, path: n.path, title: '', artist: '', album: '', album_id: 0, album_artist: '', raw: rawOf(n),
    disc: n.disc || 1, no: n.no || 0, dur: n.dur, codec, bits: n.bits || 0, rate: n.rate || 44100, kbps: n.kbps || 0, lossless,
    genre: cleanGenre(n.genre), year: n.year || 0, fav: false, size: n.size, added: Date.now(), plays: 0, cover: n.cover || '',
  };
}

async function addNative(list: NativeTrack[]): Promise<number> {
  await loadNamefix();
  const known = new Set(lib.tracks.map((t) => t.path));
  const fresh: MTrack[] = [];
  for (const x of list) {
    if (known.has(x.path)) continue;
    known.add(x.path);
    fresh.push(fromNative(x));
  }
  if (!fresh.length) return 0;
  nameBatch(fresh);
  // downloaded from an album page: exactly that album (same album artist → same album id), its track number
  list.forEach((x) => {
    if (!x.force) return;
    const t = fresh.find((y) => y.path === x.path);
    if (!t) return;
    OV[t.path] = { title: x.title, artist: x.artist, album: x.album };
    if (t.raw) t.raw = { ...t.raw, title: x.title, artist: x.artist, album: x.album, aa: x.albumArtist }; // "Reprocess all" keeps it too
    setNames(t, x.title, x.artist, x.album, x.albumArtist);
    if (x.no) t.no = x.no;
    if (x.disc) t.disc = x.disc;
    if (x.year) t.year = x.year;
    delete REVIEW[t.path];
  });
  lib.tracks.push(...fresh);
  changed();
  return fresh.length;
}

/** One-time: tracks imported before namefix existed and whose names look dirty are re-read and re-parsed. */
async function migrateNames() {
  if (lib.nfv === 1) return;
  if (!(await loadNamefix())) return;
  const dirty = lib.tracks.filter((t) => !t.raw && (t.artist === UNKNOWN || nf.dirty(t.title, t.artist, t.album === SINGLES ? '' : t.album)));
  for (let i = 0; i < dirty.length; i += 40) {
    const part = dirty.slice(i, i + 40);
    const { tracks } = await native.plugin.probe({ paths: part.map((t) => t.path) }).catch(() => ({ tracks: [] as NativeTrack[] }));
    const by = new Map(tracks.map((n) => [n.path, n]));
    for (const t of part) { const n = by.get(t.path); if (n) t.raw = rawOf(n); }
  }
  const batch = dirty.filter((t) => t.raw);
  if (batch.length) nameBatch(batch);
  lib.nfv = 1;
  changed();
}

let reproc = false;
/** Settings → "Reprocess all files": every file is probed again (tags, embedded picture), its names are parsed
 *  again, internet / sound genres are looked up again. Manual renames, own covers and own tags stay. */
async function reprocessAll(): Promise<number> {
  if (reproc) throw new Error('уже идёт');
  reproc = true;
  try {
    await loadNamefix();
    const all = lib.tracks.slice();
    let done = 0;
    emit('scan', { state: 'scanning', done, total: all.length, message: '' });
    for (let i = 0; i < all.length; i += 40) {
      const part = all.slice(i, i + 40);
      const { tracks } = await native.plugin.probe({ paths: part.map((t) => t.path) }).catch(() => ({ tracks: [] as NativeTrack[] }));
      const by = new Map(tracks.map((n) => [n.path, n]));
      for (const t of part) {
        const n = by.get(t.path); if (!n) continue;
        const f = fromNative(n);
        t.raw = f.raw; t.genre = f.genre; t.year = f.year; t.no = f.no || t.no; t.disc = f.disc || t.disc;
        t.dur = f.dur || t.dur; t.codec = f.codec; t.bits = f.bits; t.rate = f.rate; t.kbps = f.kbps; t.lossless = f.lossless;
        if (f.cover) t.cover = f.cover;
      }
      done += part.length;
      emit('scan', { state: 'scanning', done, total: all.length, message: '' });
    }
    const parsed = all.filter((t) => t.raw);
    if (namefixReady()) nameBatch(parsed); else parsed.forEach((t) => { legacyNames(t); applyOv(t); });
    unifyArtists();
    lib.wg = {}; lib.sg = {};
    coverRev = Date.now(); lastSess = '';
    changed(); push();
    setTimeout(webGenres, 500);
    return all.length;
  } finally {
    reproc = false;
    emit('scan', { state: 'idle', done: 0, total: 0, message: '' });
  }
}

function albumsAll(): Album[] {
  if (albumsC) return albumsC;
  const m = new Map<number, Album & { _t: MTrack[] }>();
  for (const t of lib.tracks) {
    let a = m.get(t.album_id);
    if (!a) m.set(t.album_id, (a = { id: t.album_id, title: t.album, artist: t.album_artist, year: t.year, genre: '', tracks: 0, dur: 0, cover: null, cover_name: '', recipe: null, history: [], added: 0, _t: [] }));
    a._t.push(t); a.tracks++; a.dur += t.dur; a.added = Math.max(a.added, t.added);
    if (!a.year && t.year) a.year = t.year;
    if (!a.genre && t.genre) a.genre = t.genre;
  }
  for (const a of m.values()) if (!a.genre) a.genre = lib.wg![a.id]?.g || lib.sg![a.id] || '';
  albumsC = [...m.values()].map(({ _t, ...a }) => ({ ...a, cover: lib.custom[a.id] || lib.emb[a.id] ? 'file' : null }));
  return albumsC;
}
const tracksOf = (albumId: number) => lib.tracks.filter((t) => t.album_id === albumId).sort((a, b) => a.disc - b.disc || a.no - b.no || a.title.localeCompare(b.title));
const cmp = (a: string, b: string) => a.localeCompare(b, 'ru', { sensitivity: 'base' });
function sortTracks(list: MTrack[], sort: string) {
  const l = list.slice();
  if (sort === 'title') l.sort((a, b) => cmp(a.title, b.title));
  else if (sort === 'added') l.sort((a, b) => b.added - a.added);
  else if (sort === 'year') l.sort((a, b) => b.year - a.year || cmp(a.artist, b.artist));
  else l.sort((a, b) => cmp(a.artist, b.artist) || cmp(a.album, b.album) || a.no - b.no);
  return l;
}
function sortAlbums(list: Album[], sort: string) {
  const l = list.slice();
  if (sort === 'title') l.sort((a, b) => cmp(a.title, b.title));
  else if (sort === 'added') l.sort((a, b) => b.added - a.added);
  else if (sort === 'year') l.sort((a, b) => b.year - a.year);
  else l.sort((a, b) => cmp(a.artist, b.artist) || cmp(a.title, b.title));
  return l;
}
/** Every artist on its own: «Баста, Скриптонит» counts for both (album artist + featured artists). */
function artistsAll(): Artist[] {
  const m = new Map<string, Artist & { _a: Set<number> }>();
  for (const t of lib.tracks) {
    const seen = new Set<string>();
    const own = splitArtists(t.album_artist), feat = splitArtists(t.artist);
    for (const [name, isOwn] of [...own.map((x) => [x, true] as const), ...feat.map((x) => [x, false] as const)]) {
      const k = nf.key(name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      let a = m.get(k);
      if (!a) m.set(k, (a = { name, albums: 0, tracks: 0, album_id: t.album_id, album_title: t.album, cover: null, recipe: null, genre: t.genre, _a: new Set() }));
      a.tracks++; if (isOwn) a._a.add(t.album_id);
      if (!a.cover && (lib.custom[t.album_id] || lib.emb[t.album_id])) { a.cover = 'file'; a.album_id = t.album_id; a.album_title = t.album; }
    }
  }
  return [...m.values()].map(({ _a, ...a }) => ({ ...a, albums: _a.size })).sort((a, b) => cmp(a.name, b.name));
}
const hasPart = (s: string, k: string) => splitArtists(s).some((p) => nf.key(p) === k);

/** One spelling per artist: case, ё/е and translit («Kino» → «Кино» if the Russian name is already there),
 *  each part of «A, B» separately. Global renames win; manual per-track names are kept. */
function unifyArtists() {
  if (!namefixReady()) return;
  const votes = new Map<string, Map<string, number>>();
  for (const t of lib.tracks) for (const p of [...splitArtists(t.artist), ...splitArtists(t.album_artist)]) {
    if (p === UNKNOWN) continue;
    const k = nf.key(p); if (!k) continue;
    const v = votes.get(k) ?? new Map<string, number>(); votes.set(k, v); v.set(p, (v.get(p) ?? 0) + 1);
  }
  const pinned = new Map<string, string>();
  for (const [k, n] of Object.entries(ALIAS)) { pinned.set(k, n); pinned.set(nf.key(n), n); }
  const cyr = (s: string) => /[\u0400-\u04FF]/.test(s);
  const nice = (s: string) => { const l = s.replace(/[^\p{L}]/gu, ''); return l.length <= 3 || (l !== l.toLowerCase() && l !== l.toUpperCase()); };
  const canon = new Map<string, string>();
  for (const [k, v] of votes) {
    const best = pinned.get(k) ?? [...v].sort((a, b) => +cyr(b[0]) - +cyr(a[0]) || +nice(b[0]) - +nice(a[0]) || b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    canon.set(k, best);
  }
  // Latin name one letter away from a Russian one (6+ letters): the same artist
  const lev1 = (a: string, b: string) => {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
  };
  const ru = [...canon].filter(([, v]) => cyr(v));
  for (const [k, v] of [...canon]) {
    if (cyr(v) || pinned.has(k) || [...k].length < 6) continue;
    const hits = ru.filter(([ck]) => lev1(k, ck));
    if (hits.length === 1) canon.set(k, hits[0][1]);
  }
  const rw = (s: string) => artistParts(s).map((p) => (canon.get(nf.key(p.name)) ?? p.name) + p.sep).join('').trim();
  let n = 0;
  for (const t of lib.tracks) {
    const a = OV[t.path]?.artist ? t.artist : rw(t.artist), aa = rw(t.album_artist);
    if (a === t.artist && aa === t.album_artist) continue;
    setNames(t, t.title, a, t.album === SINGLES ? '' : t.album, aa === a ? '' : aa);
    n++;
  }
  if (n) changed();
}
const pub = (t: MTrack): Track => t; // Track is a structural subset

/* ================= settings ================= */
const SKEY = 'teto.settings.v1';
const settings: Settings = (() => {
  const d = defaultSettings();
  // phones: calmer defaults (no small spectrum, reduced motion, fast covers)
  Object.assign(d, { visualizer: false, anim: 'reduced', cover_quality: 'fast', auto_gen: false, show_np: true });
  try { return { ...d, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { return d; }
})();

/* ================= player ================= */
const el = new Audio();
el.preload = 'auto';
(el as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
const P = { queue: [] as number[], orig: null as number[] | null, index: -1, repeat: 'off' as Repeat, volume: 1, muted: false, error: null as string | null, errors: 0 };
let resumeOnGain = false;
let ducked = false;

function cur(): MTrack | null { return byId.get(P.queue[P.index]) ?? null; }
function state(): PlayerState {
  const t = cur();
  return { track: t ? pub(t) : null, playing: !el.paused && !!t, pos: el.currentTime || 0, dur: t?.dur || el.duration || 0, volume: P.volume, muted: P.muted,
    shuffle: !!P.orig, repeat: P.repeat, queue: P.queue.slice(), index: P.index, output: t ? fmtFormat(t) : '', error: P.error };
}
function push() { if (!document.hidden) emit('player:state', state()); syncSession(); }

function artFor(t: MTrack) { return lib.custom[t.album_id] || lib.emb[t.album_id] || ''; }
let lastSess = '';
function syncSession() {
  const t = cur();
  if (!t) { if (lastSess) { native.plugin.stopSession().catch(() => {}); lastSess = ''; } return; }
  const s = { title: t.title, artist: t.artist, album: t.album, art: artFor(t), playing: !el.paused, pos: el.currentTime || 0, dur: t.dur || el.duration || 0 };
  const key = `${t.id}|${s.playing}|${Math.round(s.pos)}|${s.art}|${s.dur}`;
  if (key === lastSess) return;
  lastSess = key;
  if (IOS) return iosSession(t, s);
  native.plugin.session(s).catch(() => {});
}
/* iOS: lock screen / Control Center / headphones go through the Media Session API of WKWebView */
const ms = IOS && 'mediaSession' in navigator ? navigator.mediaSession : null;
let msMeta = '';
function iosSession(t: MTrack, s: { title: string; artist: string; album: string; art: string; playing: boolean; pos: number; dur: number }) {
  if (!ms) return;
  const mk = `${t.id}|${s.title}|${s.artist}|${s.art}`;
  if (mk !== msMeta) {
    msMeta = mk;
    try { ms.metadata = new MediaMetadata({ title: s.title, artist: s.artist, album: s.album, artwork: s.art ? [{ src: native.fileUrl(s.art), sizes: '720x720', type: 'image/jpeg' }] : [] }); } catch { /* old WebKit */ }
  }
  ms.playbackState = s.playing ? 'playing' : 'paused';
  try { if (s.dur > 0) ms.setPositionState({ duration: s.dur, position: Math.min(s.pos, s.dur), playbackRate: 1 }); } catch { /* ignore */ }
}

function load(idx: number, pos = 0, play = true) {
  P.index = idx;
  const t = cur();
  if (!t) { el.removeAttribute('src'); el.load(); push(); return; }
  P.error = null;
  el.src = native.fileUrl(t.path);
  applyVolume();
  if (lib.ld![t.path] === undefined) setTimeout(levelAll, 300);
  const start = () => {
    if (pos > 0) { try { el.currentTime = pos; } catch { /* not seekable yet */ } }
    if (play) el.play().catch((e) => { if (e?.name !== 'AbortError') onErr(String(e?.message || e)); });
  };
  if (pos > 0) el.addEventListener('loadedmetadata', start, { once: true }); else start();
  t.plays++; lib.played[t.album_id] = Date.now(); save();
  listenTrack(t);
  push();
  saveSession();
}
function advance(auto: boolean) {
  const n = P.queue.length;
  if (!n) return;
  if (auto && P.repeat === 'one') return load(P.index);
  if (P.index + 1 < n) return load(P.index + 1);
  if (P.repeat !== 'off' || !auto) return load(0, 0, auto || !el.paused);
  pauseNow();
  push();
}
function onErr(msg: string) {
  const t = cur();
  P.error = t ? `Не удалось воспроизвести «${t.title}»` : msg;
  emit('player:error', P.error);
  if (++P.errors < Math.min(5, P.queue.length)) setTimeout(() => advance(true), 600); else { P.errors = 0; push(); }
}
el.addEventListener('ended', () => advance(true));
el.addEventListener('playing', () => { P.errors = 0; setTimeout(() => { if (!el.paused) retried = 0; }, 2500); push(); });
// Safety net: some Android builds pause the WebView's <audio> right after start (audio focus juggling).
// If a pause we did not ask for comes within 2 s of play, resume once.
let wantPause = false, playAt = 0, retried = 0;
function pauseNow() { wantPause = true; el.pause(); }
el.addEventListener('play', () => { wantPause = false; playAt = performance.now(); });
el.addEventListener('pause', () => {
  if (!wantPause && !el.ended && retried < 1 && el.getAttribute('src') && performance.now() - playAt < 2000) {
    retried++;
    setTimeout(() => { if (el.paused && !wantPause) el.play().catch(() => {}); }, 150);
    return;
  }
  push(); saveSession();
});
el.addEventListener('error', () => { if (el.getAttribute('src')) onErr('error'); });
el.addEventListener('durationchange', () => { const t = cur(); if (t && !t.dur && isFinite(el.duration)) { t.dur = el.duration; save(); push(); } });
let lastPos = 0;
el.addEventListener('timeupdate', () => {
  listenPos(el.currentTime, !el.paused);
  const now = performance.now();
  if (document.hidden || now - lastPos < 1000) return; // UI interpolates between updates
  lastPos = now;
  emit('player:pos', { pos: el.currentTime });
});
el.addEventListener('seeked', () => { emit('player:pos', { pos: el.currentTime }); syncSession(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { emit('player:state', state()); if (IOS && performance.now() - lastRec > 15000) { lastRec = performance.now(); setTimeout(reconcile, 400); } }
  else saveSession();
});
setInterval(() => { if (!el.paused && !document.hidden) saveSession(); }, 15000);

const QKEY = 'teto.session.v1';
function saveSession() {
  try { localStorage.setItem(QKEY, JSON.stringify({ q: P.queue, o: P.orig, i: P.index, p: el.currentTime || 0, r: P.repeat })); } catch { /* quota */ }
}
function restoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem(QKEY) || 'null');
    if (!s || !Array.isArray(s.q)) return;
    P.queue = s.q.filter((id: number) => byId.has(id));
    P.orig = s.o ? s.o.filter((id: number) => byId.has(id)) : null;
    P.repeat = s.r || 'off';
    if (!P.queue.length) return;
    P.index = Math.min(Math.max(0, P.queue.indexOf(s.q[s.i])), P.queue.length - 1);
    if (P.index < 0) P.index = 0;
    const t = cur();
    if (!t) return;
    el.src = native.fileUrl(t.path);
    const p = +s.p || 0;
    if (p > 0) el.addEventListener('loadedmetadata', () => { try { el.currentTime = p; } catch { /* ignore */ } }, { once: true });
  } catch { /* ignore */ }
}
/* ---- volume leveling: the measured loudness of every song (no ReplayGain tags on the phone).
   The player can only turn down (volume ≤ 1), so loud songs are brought down towards TARGET. ---- */
const TARGET = -15, MIN_GAIN = Math.pow(10, -9 / 20);
function levelGain(t: MTrack | null): number {
  if (!t || settings.replaygain === 'off') return 1;
  let L = lib.ld![t.path];
  if (settings.replaygain === 'album') {
    const v = tracksOf(t.album_id).map((x) => lib.ld![x.path]).filter((x): x is number => typeof x === 'number');
    if (v.length) L = 10 * Math.log10(v.reduce((a, x) => a + Math.pow(10, x / 10), 0) / v.length);
  }
  if (typeof L !== 'number' || !isFinite(L)) return 1;
  return Math.max(MIN_GAIN, Math.min(1, Math.pow(10, (TARGET - L) / 20)));
}
function applyVolume() { el.volume = Math.max(0, Math.min(1, P.volume * (ducked ? 0.25 : 1) * levelGain(cur()))); el.muted = P.muted; }
async function measure(t: MTrack) {
  let L: number | null;
  try { L = await loudnessOf(native.fileUrl(t.path), t.size, t.codec); } catch { L = NaN; }
  lib.ld![t.path] = L !== null && isFinite(L) ? L : null;
}
/** Measures songs without loudness one by one while the app is open (≈ one per 1.5 s). */
let ldRunning = false;
async function levelAll() {
  if (ldRunning) return;
  ldRunning = true;
  let n = 0;
  try {
    for (;;) {
      if (settings.replaygain === 'off') break;
      if (document.hidden) { await sleep(5000); continue; }
      const c = cur();
      const t = c && lib.ld![c.path] === undefined ? c : lib.tracks.find((x) => lib.ld![x.path] === undefined && x.size > 0);
      if (!t) break;
      await measure(t);
      if (t === cur() && (el.currentTime || 0) < 3) applyVolume(); // not mid-song: a sudden jump would be noticeable
      if (++n % 20 === 0) save();
      await sleep(1500);
    }
  } finally { ldRunning = false; if (n) save(); }
}

/* ---- native media controls, audio focus, headphones ---- */
function onMedia({ action, pos }: { action: string; pos?: number }) {
  if (action === 'play') { if (!cur() && P.queue.length) load(Math.max(0, P.index)); else el.play().catch(() => {}); }
  else if (action === 'pause' || action === 'stop') pauseNow();
  else if (action === 'toggle') { if (el.paused) el.play().catch(() => {}); else pauseNow(); }
  else if (action === 'next') advance(false);
  else if (action === 'prev') cmds.prev({});
  else if (action === 'seek' && pos !== undefined) el.currentTime = pos;
}
native.plugin.addListener('media', onMedia);
if (ms) {
  const h = (action: string, pos?: number) => () => onMedia({ action, pos });
  const set = (a: MediaSessionAction, f: MediaSessionActionHandler) => { try { ms.setActionHandler(a, f); } catch { /* unsupported */ } };
  set('play', h('play')); set('pause', h('pause')); set('stop', h('stop'));
  set('nexttrack', h('next')); set('previoustrack', h('prev'));
  set('seekto', (d) => { if (d.seekTime !== undefined) onMedia({ action: 'seek', pos: d.seekTime }); });
}
native.plugin.addListener('focus', ({ type }) => {
  if (type === 'loss' || type === 'noisy') { resumeOnGain = false; pauseNow(); }
  else if (type === 'transient') { if (!el.paused) { resumeOnGain = true; pauseNow(); } }
  else if (type === 'duck') { ducked = true; applyVolume(); }
  else if (type === 'gain') { ducked = false; applyVolume(); if (resumeOnGain) { resumeOnGain = false; el.play().catch(() => {}); } }
});
native.plugin.addListener('imported', ({ tracks, failed }) => onImported(tracks, failed));
/** New files in the app (picker, "Share", downloads): into the library, then genres / loudness in the background. */
async function onImported(tracks: NativeTrack[], failed: number) {
  const n = await addNative(tracks);
  try { unifyArtists(); } catch (e) { console.warn('unify', e); }
  setTimeout(webGenres, 2000);
  setTimeout(levelAll, 1000);
  emit('toast', n ? `Добавлено: ${n} ${n === 1 ? 'трек' : n < 5 ? 'трека' : 'треков'}` + (failed ? ` · не удалось: ${failed}` : '') : failed ? 'Не удалось импортировать файлы' : 'Эти треки уже в медиатеке');
}
native.plugin.addListener('dl', (x) => emit('dl', x));
let sharedPending: unknown = null; // a link shared before the UI subscribed (cold start from "Share")
native.plugin.addListener('sharedText', (x) => { if (listeners.get('shared_text')?.size) emit('shared_text', x); else sharedPending = x; });
native.plugin.addListener('importing', ({ done, total }) => emit('scan', { state: done < total ? 'scanning' : 'idle', done, total, message: 'Импорт' }));

/** Files present in storage but missing from the library (e.g. app was killed during an import) and vice versa. */
let lastRec = 0; // iOS: pick up songs dropped into Files → On My iPhone → Teto
async function reconcile() {
  try {
    const { files } = await native.plugin.listMusic();
    const have = new Set(files.map((f) => f.path));
    // iOS: the container path changes after a reinstall — re-attach tracks by their path inside Documents
    const rel = (p: string) => { const i = p.lastIndexOf('/Documents/'); return i >= 0 ? p.slice(i) : ''; };
    const byRel = new Map(files.map((f) => [rel(f.path), f.path] as const).filter(([r]) => r));
    let moved = false;
    for (const t of lib.tracks) if (!have.has(t.path)) { const n = byRel.get(rel(t.path)); if (n && rel(t.path)) { t.path = n; moved = true; } }
    if (moved) changed();
    const before = lib.tracks.length;
    lib.tracks = lib.tracks.filter((t) => have.has(t.path));
    const known = new Set(lib.tracks.map((t) => t.path));
    const fresh = files.filter((f) => !known.has(f.path)).map((f) => f.path);
    if (fresh.length) { const { tracks } = await native.plugin.probe({ paths: fresh }); await addNative(tracks); }
    else if (lib.tracks.length !== before) changed();
  } catch (e) { console.warn('reconcile', e); }
  await migrateNames().catch((e) => console.warn('names', e));
  try { unifyArtists(); } catch (e) { console.warn('unify', e); }
  setTimeout(webGenres, 3000);
}

/* ================= visualizer levels (lazy Web Audio) ================= */
let actx: AudioContext | null = null, an: AnalyserNode | null = null, fbuf: Uint8Array | null = null, edges: number[] = [];
function levels(): number[] {
  // iOS stops Web-Audio-routed playback in the background/lock screen, so there we never touch the element's
  // audio graph and draw a calm synthetic spectrum instead.
  if (IOS) {
    if (el.paused) return [];
    const t = el.currentTime;
    return Array.from({ length: 24 }, (_, b) => Math.max(0, Math.min(1, (0.62 - b * 0.012) * (0.55 + 0.25 * Math.sin(t * (2.1 + b * 0.37) + b * 1.7) + 0.2 * Math.sin(t * (5.3 + b * 0.11) + b)))));
  }
  if (!actx) {
    try {
      actx = new AudioContext();
      const src = actx.createMediaElementSource(el);
      an = actx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.55;
      an.minDecibels = -90; an.maxDecibels = -20;
      src.connect(an); an.connect(actx.destination);
      fbuf = new Uint8Array(an.frequencyBinCount);
      const hz = actx.sampleRate / an.fftSize;
      edges = Array.from({ length: 25 }, (_, i) => Math.max(1, Math.round((40 * Math.pow(16000 / 40, i / 24)) / hz)));
      // the element now plays through this context: never let it stay suspended while music plays
      actx.onstatechange = () => { if (actx && actx.state === 'suspended' && !el.paused) actx.resume().catch(() => {}); };
    } catch { actx = null; return []; }
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  if (el.paused || !an || !fbuf) return [];
  an.getByteFrequencyData(fbuf as never);
  const out: number[] = [];
  for (let b = 0; b < 24; b++) {
    let m = 0;
    for (let i = edges[b]; i < Math.max(edges[b] + 1, edges[b + 1]); i++) m = Math.max(m, fbuf[i] ?? 0);
    out.push(Math.max(0, Math.min(1, (m / 255 - 0.12) / 0.8)));
  }
  return out;
}

/* ================= genres from the internet (iTunes → Deezer) ================= */
let wgRunning = false;
/** Genres for albums without a genre tag: the internet first (iTunes → Deezer), then a guess by the sound.
 *  One album at a time and only while the app is open (battery). */
async function webGenres() {
  if (wgRunning) return;
  wgRunning = true;
  let found = 0, fails = 0;
  const bump = () => { albumsC = null; if (++found % 10 === 0) { save(); emit('library', null); } };
  const bySound = async (id: number) => {
    const t = tracksOf(id).find((x) => x.size > 0) ?? tracksOf(id)[0];
    let g = '';
    if (t) { try { g = await soundGenre(native.fileUrl(t.path), t.size, t.codec); } catch { g = ''; } }
    lib.sg![id] = g;
    if (g) bump(); else save();
    await sleep(2500);
  };
  try {
    for (;;) {
      if (document.hidden) { await sleep(5000); continue; } // save battery: only while the app is open
      const web = settings.web_genres && !settings.offline && fails < 3;
      const now = Date.now();
      const none = albumsAll().filter((x) => !x.genre);
      const a = web ? none.find((x) => x.artist && x.artist !== UNKNOWN && (!lib.wg![x.id] || (!lib.wg![x.id].g && now - lib.wg![x.id].at > 30 * 864e5))) : undefined;
      if (a) {
        const t = tracksOf(a.id)[0];
        try {
          const g = await webGenre(a.artist, a.title, t?.title || '');
          lib.wg![a.id] = { g, at: Date.now() }; fails = 0;
          if (g) bump(); else if (lib.sg![a.id] === undefined) await bySound(a.id); else save();
        } catch { fails++; await sleep(3000); }
        await sleep(1200);
        continue;
      }
      const b = none.find((x) => lib.sg![x.id] === undefined);
      if (!b) break;
      await bySound(b.id);
    }
  } finally {
    wgRunning = false;
    if (found) { albumsC = null; save(); emit('library', null); }
  }
}

/* ================= commands ================= */
const pls = (): Playlist[] => lib.playlists.map((p) => ({ id: p.id, name: p.name, tracks: p.items.filter((i) => byId.has(i)).length, album_id: byId.get(p.items[0])?.album_id ?? 0 }));

const cmds: Record<string, (a: any) => unknown> = {
  stats: () => ({ albums: albumsAll().length, artists: artistsAll().length, tracks: lib.tracks.length, favs: lib.tracks.filter((t) => t.fav).length }),
  albums: (a) => sortAlbums(albumsAll(), a.sort),
  album: (a) => albumsAll().find((x) => x.id === a.id) ?? null,
  album_tracks: (a) => tracksOf(a.id),
  artists: () => artistsAll(),
  artist_albums: (a) => { const k = nf.key(String(a.name)); return sortAlbums(albumsAll().filter((x) => hasPart(x.artist, k)), 'year'); },
  tracks: (a) => sortTracks(lib.tracks, a.sort),
  favorites: () => sortTracks(lib.tracks.filter((t) => t.fav), 'artist'),
  recent_albums: () => albumsAll().filter((a) => lib.played[a.id]).sort((a, b) => lib.played[b.id] - lib.played[a.id]).slice(0, 12),
  search: (a): SearchResult => {
    const q = String(a.q).toLowerCase().trim();
    if (!q) return { tracks: [], albums: [], artists: [] };
    const qk = nf.key(q); // «kino» finds «Кино», case/ё don't matter
    const m = (s: string) => s.toLowerCase().includes(q) || (qk.length > 1 && nf.key(s).includes(qk));
    // best matches first (title start → word → artist → album → transliteration); favourites lead inside each rank
    const hits: [Track, number][] = [];
    for (const e of searchIdx()) { const r = rank(e, q, qk); if (r >= 0) hits.push([e.t, r * 2 + (e.t.fav ? 0 : 1)]); }
    hits.sort((a, b) => a[1] - b[1]);
    return { tracks: hits.slice(0, 150).map((h) => h[0]), albums: albumsAll().filter((x) => m(x.title) || m(x.artist)).slice(0, 24), artists: artistsAll().filter((x) => m(x.name)).slice(0, 12) };
  },
  set_fav: (a) => { const t = byId.get(a.id); if (t) { t.fav = a.fav; save(); } },
  set_album_fav: (a) => { lib.tracks.forEach((t) => { if (t.album_id === a.id) t.fav = a.fav; }); save(); },
  album_genres: () => Object.entries(lib.wg!).filter(([, v]) => v.g).map(([k, v]) => [+k, v.g] as [number, string]),
  folders: () => [], scan_status: () => ({ state: 'idle', done: 0, total: 0, message: '' }),
  playlists: () => pls(),
  create_playlist: (a) => { const id = Math.max(0, ...lib.playlists.map((p) => p.id)) + 1; lib.playlists.push({ id, name: a.name, items: [], created: Date.now() }); save(); return id; },
  delete_playlist: (a) => { lib.playlists = lib.playlists.filter((p) => p.id !== a.id); save(); },
  rename_playlist: (a) => { const p = lib.playlists.find((x) => x.id === a.id); if (p) { p.name = a.name; save(); } },
  playlist_tracks: (a) => (lib.playlists.find((p) => p.id === a.id)?.items ?? []).map((i) => byId.get(i)).filter(Boolean),
  add_to_playlist: (a) => { const p = lib.playlists.find((x) => x.id === a.id); if (p) { p.items.push(...(a.trackIds as number[]).filter((i) => !p.items.includes(i))); save(); } },
  remove_from_playlist: (a) => { const p = lib.playlists.find((x) => x.id === a.id); if (p) { p.items = p.items.filter((i) => !(a.trackIds as number[]).includes(i)); save(); } },
  play_queue: (a) => {
    const ids = (a.trackIds as number[]).filter((i) => byId.has(i));
    if (!ids.length) return;
    P.queue = ids; P.orig = null;
    if (a.shuffle) { const first = byId.get(ids[a.index])!; P.orig = ids.slice(); P.queue = smartShuffle(ids.map((i) => byId.get(i)!), first).map((t) => t.id); load(0); }
    else load(Math.min(a.index, ids.length - 1));
  },
  play_mix: (a) => { P.orig = (a.trackIds as number[]).filter((i) => byId.has(i)); P.queue = (a.order as number[]).filter((i) => byId.has(i)); load(0); },
  enqueue: (a) => {
    const ids = (a.trackIds as number[]).filter((i) => byId.has(i));
    if (!P.queue.length) { P.queue = ids; load(0); return; }
    if (a.next) P.queue.splice(P.index + 1, 0, ...ids); else P.queue.push(...ids);
    P.orig?.push(...ids);
    push(); saveSession();
  },
  toggle: () => { if (!cur()) { if (P.queue.length) load(Math.max(0, P.index)); return; } if (el.paused) el.play().catch((e) => onErr(String(e))); else pauseNow(); },
  next: () => advance(false),
  prev: () => { if (el.currentTime > 3) { el.currentTime = 0; return; } load(P.index > 0 ? P.index - 1 : P.repeat === 'all' ? P.queue.length - 1 : 0, 0, true); },
  seek: (a) => { if (cur()) el.currentTime = Math.max(0, a.pos); },
  jump: (a) => load(a.index),
  remove_from_queue: (a) => { if (a.index === P.index) return; P.queue.splice(a.index, 1); if (a.index < P.index) P.index--; push(); saveSession(); },
  set_volume: (a) => { P.volume = a.v; applyVolume(); push(); },
  set_muted: (a) => { P.muted = a.m; applyVolume(); push(); },
  set_shuffle: (a) => {
    const t = cur();
    if (!t) return;
    if (a.on && !P.orig) {
      P.orig = P.queue.slice();
      const rest = P.queue.filter((_, i) => i !== P.index).map((i) => byId.get(i)!).filter(Boolean);
      P.queue = [t.id, ...smartShuffle(rest).map((x) => x.id)]; P.index = 0;
    } else if (!a.on && P.orig) { P.queue = P.orig; P.orig = null; P.index = Math.max(0, P.queue.indexOf(t.id)); }
    push(); saveSession();
  },
  set_repeat: (a) => { P.repeat = a.mode; push(); saveSession(); },
  player_state: () => state(),
  queue_tracks: () => P.queue.map((i) => byId.get(i)).filter(Boolean),
  devices: () => [],
  levels: () => levels(),
  lyrics: (a) => lyricsFor(a.id, byId.get(a.id), settings.offline),
  lyrics_candidates: async (a) => {
    const t = byId.get(a.id); if (!t || settings.offline) return [];
    const list: LrcItem[] = (await lrc('/api/search', { q: `${t.artist} ${t.title}` })) ?? [];
    return list.slice(0, 12).map((x) => ({ id: x.id, label: `${x.artistName} — ${x.trackName} (${Math.floor(x.duration / 60)}:${String(Math.round(x.duration % 60)).padStart(2, '0')})`, synced: !!x.syncedLyrics }));
  },
  pick_lyrics: async (a) => { const r = await lrc('/api/get/' + a.candidate, {}); const l = toLyrics(r); cacheLyr(a.id, l); return l; },
  save_lrc: () => { throw new Error('На телефоне тексты хранятся внутри приложения'); },
  analyze_album: () => { throw new Error('нет анализа на телефоне'); },
  set_recipe: () => undefined, use_real_cover: () => undefined, save_gen_cover: () => undefined,
  embed_cover: () => { throw new Error('недоступно на телефоне'); },
  settings: () => ({ ...settings }),
  level_stats: () => ({ done: lib.tracks.filter((x) => lib.ld![x.path] !== undefined).length, total: lib.tracks.length }),
  set_settings: (a) => { Object.assign(settings, a.patch); try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch { /* quota */ } setTimeout(webGenres, 500); applyVolume(); setTimeout(levelAll, 800); return { ...settings }; },
  show_window: () => undefined, reveal_file: () => undefined, hide_to_tray: () => undefined, restart_app: () => location.reload(),
  discord_status: () => '', discord_preview: () => null,
  clear_cache: (a) => { if (a.what === 'lyrics') clearLyrics(); },
  app_info: async () => { const i = await native.plugin.info().catch(() => ({ version: '1.9.0', storage: '', free: 0 })); return { version: i.version, data: i.storage }; },
  // names (namefix): same commands as the desktop
  rename_track: (a) => {
    const t = byId.get(a.id); if (!t) return;
    const o = (OV[t.path] ??= {});
    if (a.title?.trim()) o.title = a.title.trim();
    if (a.artist?.trim()) o.artist = a.artist.trim();
    if (a.album?.trim()) o.album = a.album.trim();
    applyOv(t); delete REVIEW[t.path];
    changed(); push();
  },
  swap_artist_title: (a) => { const t = byId.get(a.id); if (t) cmds.rename_track({ id: t.id, title: t.artist, artist: t.title }); },
  rename_artist: async (a) => {
    const nn = String(a.new).trim(), old = String(a.old).trim().toLowerCase();
    if (!nn) throw new Error('пустое имя');
    await loadNamefix();
    let n = 0;
    for (const t of lib.tracks) {
      const hitA = t.artist.toLowerCase() === old, hitAA = t.album_artist.toLowerCase() === old;
      if (!hitA && !hitAA) continue;
      if (hitA && OV[t.path]?.artist) OV[t.path].artist = nn;
      setNames(t, t.title, hitA ? nn : t.artist, t.album === SINGLES ? '' : t.album, hitAA ? nn : t.album_artist);
      delete REVIEW[t.path];
      n++;
    }
    ALIAS[nf.key(a.old)] = nn;
    for (const k of Object.keys(ALIAS)) if (ALIAS[k].toLowerCase() === old) ALIAS[k] = nn;
    const ok = nf.key(a.old), nk = nf.key(nn);
    if (ok !== nk && PHOTOS[ok] && !PHOTOS[nk]) { PHOTOS[nk] = PHOTOS[ok]; delete PHOTOS[ok]; }
    changed(); push();
    return n;
  },
  set_artist_photo: async (a) => {
    await loadNamefix();
    const k = nf.key(a.name), old = PHOTOS[k];
    if (a.jpeg?.length) {
      let bin = ''; const b = a.jpeg as number[];
      for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.slice(i, i + 0x8000));
      const { path } = await native.plugin.saveImage({ name: `artist_${hash(k)}_${Date.now()}.jpg`, data: btoa(bin) });
      PHOTOS[k] = path;
    } else delete PHOTOS[k];
    if (old && old !== PHOTOS[k]) native.plugin.deleteFile({ path: old }).catch(() => {});
    save(); emit('library', null);
  },
  artist_photo: async (a) => { await loadNamefix(); const p = PHOTOS[nf.key(a.name)]; return p ? native.fileUrl(p) : null; },
  names_to_review: () => lib.tracks.filter((t) => REVIEW[t.path]).map((t) => [t.id, 1, REVIEW[t.path] === 2]),
  // phone-only
  import_files: () => native.plugin.pickAudio(),
  delete_tracks: async (a) => {
    const ids = new Set(a.trackIds as number[]);
    const gone = lib.tracks.filter((t) => ids.has(t.id));
    for (const t of gone) await native.plugin.deleteFile({ path: t.path }).catch(() => {});
    if (cur() && ids.has(cur()!.id)) { pauseNow(); }
    for (const t of gone) { delete REVIEW[t.path]; delete OV[t.path]; }
    lib.tracks = lib.tracks.filter((t) => !ids.has(t.id));
    const curId = P.queue[P.index];
    P.queue = P.queue.filter((i) => !ids.has(i));
    P.orig = P.orig?.filter((i) => !ids.has(i)) ?? null;
    P.index = Math.max(0, P.queue.indexOf(curId));
    for (const p of lib.playlists) p.items = p.items.filter((i) => !ids.has(i));
    changed(); push();
  },
  set_custom_cover: async (a) => {
    const { path } = await native.plugin.saveImage({ name: `custom_${a.albumId}_${Date.now()}.jpg`, data: a.data });
    const old = lib.custom[a.albumId];
    if (old) native.plugin.deleteFile({ path: old }).catch(() => {});
    lib.custom[a.albumId] = path;
    coverRev = Date.now(); lastSess = '';
    changed(); push();
  },
  reset_cover: (a) => {
    const old = lib.custom[a.albumId];
    if (old) native.plugin.deleteFile({ path: old }).catch(() => {});
    delete lib.custom[a.albumId];
    coverRev = Date.now(); lastSess = '';
    changed(); push();
  },
  has_custom_cover: (a) => !!lib.custom[a.albumId],
  /** Settings → Scan: audio files on the phone that are not in the library yet (and are long enough). */
  scan_device: async (a) => {
    if (IOS) { await reconcile(); return { items: [], unsupported: true }; }
    const { items } = await native.plugin.scanDevice({ minMs: Math.max(0, +a.minSec || 0) * 1000 });
    const sizes = new Set(lib.tracks.map((t) => t.size));
    const names = new Set(lib.tracks.map((t) => baseName(t.path)));
    return { items: items.filter((f) => !(sizes.has(f.size) && names.has(baseName(f.name)))), unsupported: false };
  },
  /** Copies the chosen files into the app (same pipeline as "Share → Teto"). */
  import_uris: (a) => native.plugin.importUris({ uris: a.uris }),
  open_url: (a) => native.plugin.openUrl({ url: String(a.url) }).catch(() => { window.open(String(a.url), '_blank'); }),
  /** "Hints": the album's full track list from the iTunes Search API (cached for a week). */
  album_tracklist: async (a) => albumTracklist(String(a.artist || ''), String(a.album || '')),
  reprocess: () => reprocessAll(),
  /** Internet search: plain HTTPS to the chosen source(s) (Settings → Download); Android falls back to yt-dlp search. */
  yt_search: async (a) => {
    const q = String(a.q);
    const src = (String(a.src || '') || prefs().dlSrc || 'all') as 'all' | 'youtube' | 'soundcloud' | 'vk';
    if (IOS || src === 'vk') return (await netSearch(H, q, src)).items;
    try { const r = await netSearch(H, q, src); if (r.items.length || r.ok >= 2) return r.items; } catch (e) { if (src !== 'all') throw e; }
    const items = (await native.plugin.ytSearch({ q })).items;
    return src === 'all' ? items : items.filter((x) => x.source === src);
  },
  vk_status: () => { const v = vkAuth(); return v ? { connected: true, name: v.name || '' } : { connected: false, name: '' }; },
  vk_login: async () => {
    const r = await native.plugin.vkLogin();
    setVkAuth({ token: r.token, user: r.user });
    // check that VK Music answers to this token right away (and learn the name to show)
    try { await vkSearch(H, 'Кино'); } catch (e) { setVkAuth(null); throw new Error(String((e as Error)?.message ?? e)); }
    const name = await vkMe(H).catch(() => '');
    setVkAuth({ token: r.token, user: r.user, name });
    forgetMissing();
    return { connected: true, name };
  },
  vk_logout: () => { setVkAuth(null); },
  /** Starts a download (MP3 / M4A + cover + tags); progress arrives as "dl" events, the file as "imported". */
  yt_download: (a) => {
    const o = { id: String(a.id || ''), url: String(a.url), artist: String(a.artist || ''), title: String(a.title || ''), source: String(a.source || ''), thumb: String(a.thumb || ''), songAlbum: String(a.songAlbum || ''),
      album: String(a.album || ''), albumArtist: String(a.albumArtist || ''), no: Number(a.no) || 0, disc: Number(a.disc) || 0, year: Number(a.year) || 0 };
    // iPhone: no yt-dlp — plain HTTPS downloads in the web layer (./netdl.ts)
    if (IOS) { startDownload({ ...o, src: prefs().dlSrc ?? 'all' }, (x) => emit('dl', x), (t) => onImported(t, 0)); return; }
    return native.plugin.ytDownload({ ...o, kbps: a.kbps == null ? 0 : Number(a.kbps) });
  },
  dl_cancel: (a) => (IOS ? cancelDl(String(a.id)) : native.plugin.dlCancel({ id: String(a.id) })),
  dl_engine: () => (IOS ? { ready: true, updating: false, version: 'iOS', error: '' } : native.plugin.dlEngine()),
  dl_update: () => native.plugin.dlUpdate(),
  listen_log: (a) => listenLog(String(a.from), String(a.to), (id) => byId.get(id)),
  listen_first: () => listenFirst(),
  listen_reset: () => listenReset(),
};

const baseName = (p: string) => (p.split('/').pop() || p).replace(/ \(\d+\)(?=\.[^.]+$)/, '').toLowerCase();

async function rebase() {
  const i = (await native.plugin.info().catch(() => null)) as { home?: string } | null;
  const home = i?.home; if (!home) return;
  const old = lib.home; lib.home = home;
  if (!old || old === home) { save(); return; }
  const re = (v: string) => (typeof v === 'string' && v.startsWith(old + '/') ? home + v.slice(old.length) : v);
  for (const t of lib.tracks) { t.path = re(t.path); t.cover = re(t.cover); }
  for (const o of [lib.custom, lib.emb, PHOTOS] as Record<string, string>[]) for (const k of Object.keys(o)) o[k] = re(o[k]);
  for (const o of [OV, REVIEW] as Record<string, unknown>[]) for (const k of Object.keys(o)) { const n = re(k); if (n !== k) { o[n] = o[k]; delete o[k]; } }
  coverRev = Date.now();
  changed();
}
if (IOS) rebase().finally(() => { restoreSession(); push(); });
else restoreSession();
applyVolume();
setTimeout(levelAll, 8000);
setTimeout(reconcile, 1500);
addEventListener('pagehide', () => { save(true); saveSession(); });

export const mobile = {
  call: async (cmd: string, args?: Record<string, unknown>) => {
    const h = cmds[cmd];
    if (!h) throw new Error('нет команды ' + cmd);
    return await h(args ?? {});
  },
  on: async (event: string, cb: Cb) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb);
    if (event === 'shared_text' && sharedPending) { const x = sharedPending; sharedPending = null; setTimeout(() => cb(x), 0); }
    return () => { listeners.get(event)!.delete(cb); };
  },
  hasCover: (albumId: number) => !!(lib.custom[albumId] || lib.emb[albumId]),
  coverUrl: (albumId: number, _size: number) => {
    const p = lib.custom[albumId] || lib.emb[albumId];
    return p ? native.fileUrl(p) + '?v=' + coverRev : '';
  },
};
