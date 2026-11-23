/** Free web lookups for the phone: genres (iTunes → Deezer) and album track lists (iTunes → Deezer). */
import { CapacitorHttp } from '@capacitor/core';
import { H } from './http';
import { vkAlbums, vkAlbumTracks, vkAuth } from './online';

const SINGLES = 'Синглы';
export const gnorm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
export function sameArtist(a: string, b: string) { const x = gnorm(a), y = gnorm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); }
export const useful = (g?: string) => { g = (g || '').trim(); return g && !/^(music|музыка)$/i.test(g) ? g : ''; };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function jget(url: string, params: Record<string, string> = {}) {
  const r = await CapacitorHttp.get({ url, params, connectTimeout: 8000, readTimeout: 10000 });
  if (r.status === 404) return null;
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
}
export async function itunesG(term: string, entity: string, artist: string, want?: string) {
  const v = await jget('https://itunes.apple.com/search', { term, entity, limit: '10', media: 'music' });
  let fb = '';
  for (const r of v?.results || []) {
    if (!sameArtist(r.artistName || '', artist)) continue;
    const g = useful(r.primaryGenreName); if (!g) continue;
    const n = gnorm(r.collectionName || r.trackName || '');
    if (want && !n.includes(gnorm(want)) && !gnorm(want).includes(n)) { fb ||= g; continue; }
    return g;
  }
  return fb;
}
export async function deezerG(artist: string, album: string, title: string) {
  const q = album ? `artist:"${artist}" album:"${album}"` : `artist:"${artist}" track:"${title}"`;
  const v = await jget('https://api.deezer.com/search', { q, limit: '5' });
  for (const r of v?.data || []) {
    if (!sameArtist(r.artist?.name || '', artist) || !r.album?.id) continue;
    await sleep(250);
    const a = await jget('https://api.deezer.com/album/' + r.album.id);
    const g = useful(a?.genres?.data?.[0]?.name); if (g) return g;
  }
  return '';
}
export async function webGenre(artist: string, album: string, title: string) {
  const single = !album || album === SINGLES || album === 'Без альбома';
  let g = '';
  if (!single) { g = await itunesG(`${artist} ${album}`, 'album', artist, album); if (g) return g; await sleep(300); }
  if (title) { g = await itunesG(`${artist} ${title}`, 'song', artist); if (g) return g; await sleep(300); }
  g = await deezerG(artist, single ? '' : album, title); if (g) return g;
  await sleep(300);
  return itunesG(artist, 'musicArtist', artist);
}

export interface TLItem { no: number; disc: number; title: string; dur: number }
type TL = { album: string; tracks: TLItem[] };
const TLKEY = 'teto.tracklists.v2';
const tlCache: Record<string, { at: number; v: TL | null }> = (() => { try { return JSON.parse(localStorage.getItem(TLKEY) || '{}'); } catch { return {}; } })();

/* ---------- fuzzy names: Cyrillic ↔ Latin, "(Deluxe)", "- EP", "feat." ---------- */
const CYR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const lat = (s: string) => [...s].map((c) => CYR[c] ?? c).join('')
  .replace(/kh/g, 'h').replace(/ts/g, 'c').replace(/(y|j)(a|u|o|e)/g, '$2').replace(/[jy]/g, 'i').replace(/w/g, 'v').replace(/x/g, 'ks').replace(/q/g, 'k').replace(/(.)\1/g, '$1');
const EXTRA = /\s*[([](?:[^)\]]*?)(deluxe|remaster|edition|version|expanded|bonus|anniversary|explicit|clean|special|reissue|делюкс|издание|версия)[^)\]]*[)\]]/gi;
const strip = (s: string) => s.replace(EXTRA, '').replace(/\s+[-–—]\s+(single|ep|сингл)$/i, '').replace(/\s*\((single|ep)\)$/i, '').trim();
const akey = (s: string) => lat(gnorm(strip(s)));
/** 3 = same album, 2 = one name starts / contains the other, 0 = different. */
function albumScore(cand: string, want: string): number {
  const a = akey(cand), b = akey(want);
  if (!a || !b) return 0;
  if (a === b || gnorm(cand) === gnorm(want)) return 3;
  if (Math.min(a.length, b.length) > 2 && (a.startsWith(b) || b.startsWith(a))) return 2;
  if (Math.min(a.length, b.length) > 4 && (a.includes(b) || b.includes(a))) return 2;
  return 0;
}
const parts = (s: string) => s.split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|\/| и | and )\s*/i).map((x) => x.trim()).filter(Boolean);
function artistOk(cand: string, want: string): boolean {
  if (sameArtist(cand, want)) return true;
  const A = parts(cand).map((x) => lat(gnorm(x))), B = parts(want).map((x) => lat(gnorm(x)));
  return A.some((x) => x.length > 1 && B.some((y) => y.length > 1 && (x === y || (Math.min(x.length, y.length) > 3 && (x.includes(y) || y.includes(x))))));
}
const hasCyr = (s: string) => /[а-яё]/i.test(s);
/** "Gruppa krovi" → "Группа крови": Russian albums tagged in Latin letters are searched in Cyrillic too. */
const LC: [RegExp, string][] = [[/shch|sch/g, 'щ'], [/zh/g, 'ж'], [/ch/g, 'ч'], [/sh/g, 'ш'], [/kh/g, 'х'], [/ts/g, 'ц'], [/ya|ja/g, 'я'], [/yu|ju/g, 'ю'], [/yo|jo/g, 'ё'], [/y\b/g, 'й'], [/iy\b/g, 'ий']];
const L1: Record<string, string> = { a: 'а', b: 'б', v: 'в', w: 'в', g: 'г', d: 'д', e: 'е', z: 'з', i: 'и', j: 'й', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', r: 'р', s: 'с', t: 'т', u: 'у', f: 'ф', h: 'х', c: 'к', y: 'ы', x: 'кс', q: 'к' };
const toCyr = (s: string) => { let x = s.toLowerCase(); for (const [re, r] of LC) x = x.replace(re, r); return [...x].map((ch) => L1[ch] ?? ch).join(''); };

/* ---------- sources ---------- */
async function itunesAlbums(term: string, country: string) {
  const v = await jget('https://itunes.apple.com/search', { term, entity: 'album', limit: '50', media: 'music', country });
  return (v?.results || []) as any[];
}
async function itunesTracks(id: number, country: string): Promise<TLItem[]> {
  const l = await jget('https://itunes.apple.com/lookup', { id: String(id), entity: 'song', country });
  return (l?.results || []).filter((r: any) => r.wrapperType === 'track' && r.trackName)
    .map((r: any) => ({ no: r.trackNumber || 0, disc: r.discNumber || 1, title: String(r.trackName), dur: Math.round((r.trackTimeMillis || 0) / 1000) }));
}
/** Best album among the results (most tracks wins a tie: deluxe ≥ standard). */
function bestOf<T>(list: T[], artist: string, album: string, f: (r: T) => [string, string, number]) {
  let best: T | null = null, bs = 0, bn = 0;
  for (const r of list) {
    const [an, title, n] = f(r);
    if (!artistOk(an, artist)) continue;
    const sc = albumScore(title, album);
    if (sc > bs || (sc === bs && sc && n > bn)) { best = r; bs = sc; bn = n; }
  }
  return { best, score: bs };
}
type Hit = { tl: TL; score: number };
async function fromItunes(artist: string, album: string): Promise<Hit | null> {
  const countries = hasCyr(artist + album) ? ['ru', 'kz', 'us'] : ['us', 'ru']; // the US store has few Russian albums
  let top: Hit | null = null;
  for (const c of countries) {
    const terms = [`${artist} ${strip(album)}`, strip(album), artist];
    if (c === 'ru' && !hasCyr(artist + album) && /^[\x00-\x7f]+$/.test(artist + album)) terms.push(`${toCyr(artist)} ${toCyr(strip(album))}`);
    for (const term of terms) {
      let res: any[];
      try { res = await itunesAlbums(term, c); } catch { return top; } // 403 = too many requests: Deezer takes over
      const { best, score } = bestOf(res, artist, album, (r: any) => [r.artistName || '', r.collectionName || '', r.trackCount || 0]);
      if (best?.collectionId && score > (top?.score ?? 0)) {
        const tracks = await itunesTracks(best.collectionId, c).catch(() => []);
        if (tracks.length) top = { tl: { album: String(best.collectionName), tracks }, score };
      }
      if (top?.score === 3) return top;
      await sleep(200);
    }
  }
  return top;
}
async function fromDeezer(artist: string, album: string): Promise<Hit | null> {
  const qs = [`artist:"${artist}" album:"${strip(album)}"`, `${artist} ${strip(album)}`, strip(album)];
  if (!hasCyr(artist + album) && /^[\x00-\x7f]+$/.test(artist + album)) qs.push(`${toCyr(artist)} ${toCyr(strip(album))}`);
  let pick: any = null, ps = 0;
  for (const q of qs) {
    const v = await jget('https://api.deezer.com/search/album', { q, limit: '25' }).catch(() => null);
    const { best, score } = bestOf(v?.data || [], artist, album, (r: any) => [r.artist?.name || '', r.title || '', r.nb_tracks || 0]);
    if (best && score > ps) { pick = best; ps = score; }
    if (ps === 3) break;
    await sleep(200);
  }
  if (!pick?.id) return null;
  const l = await jget(`https://api.deezer.com/album/${pick.id}/tracks`, { limit: '300' }).catch(() => null);
  const tracks: TLItem[] = (l?.data || []).filter((r: any) => r.title)
    .map((r: any, i: number) => ({ no: r.track_position || i + 1, disc: r.disk_number || 1, title: String(r.title), dur: r.duration || 0 }));
  return tracks.length ? { tl: { album: String(pick.title), tracks }, score: ps } : null;
}

/** After connecting VK: albums that were "not found" are looked up again. */
export function forgetMissing() {
  for (const k of Object.keys(tlCache)) if (!tlCache[k].v) delete tlCache[k];
  try { localStorage.setItem(TLKEY, JSON.stringify(tlCache)); } catch { /* quota */ }
}
async function fromVk(artist: string, album: string): Promise<Hit | null> {
  if (!vkAuth()) return null;
  let pick: Awaited<ReturnType<typeof vkAlbums>>[number] | null = null, ps = 0;
  for (const q of [`${artist} ${strip(album)}`, strip(album)]) {
    const list = await vkAlbums(H, q).catch(() => []);
    const { best, score } = bestOf(list, artist, album, (r) => [r.artist, r.title, r.count]);
    if (best && score > ps) { pick = best; ps = score; }
    if (ps === 3) break;
  }
  if (!pick) return null;
  const tracks: TLItem[] = await vkAlbumTracks(H, pick).catch(() => []);
  return tracks.length ? { tl: { album: pick.title, tracks }, score: ps } : null;
}

/** "Hints": the album's full track list — iTunes (Russian store first for Russian names), then Deezer, then VK Music (if connected),
 *  with fuzzy names (Кино ~ Kino, "(Deluxe)", "- EP", feat.). Found: cached for a week, not found: for a day. */
export async function albumTracklist(artist: string, album: string) {
  const key = gnorm(artist) + '|' + gnorm(album);
  const c = tlCache[key];
  if (c && Date.now() - c.at < (c.v ? 7 : 1) * 864e5) return c.v;
  let hit: Hit | null = null, failed = false;
  try { hit = await fromItunes(artist, album); } catch { failed = true; }
  if (!hit) failed = true; // iTunes may have refused (rate limit): don't remember "not found" unless Deezer answers
  if (!hit || hit.score < 3) {
    try { const d = await fromDeezer(artist, album); if (d && d.score > (hit?.score ?? 0)) hit = d; failed = false; } catch { /* network */ }
  }
  if (!hit || hit.score < 3) { // VK Music (when connected): many Russian albums the stores don't have
    try { const v = await fromVk(artist, album); if (v && v.score > (hit?.score ?? 0)) { hit = v; failed = false; } } catch { /* network */ }
  }
  const out = hit?.tl ?? null;
  if (out) out.tracks.sort((x, y) => x.disc - y.disc || x.no - y.no);
  if (out || !failed) {
    tlCache[key] = { at: Date.now(), v: out };
    try { localStorage.setItem(TLKEY, JSON.stringify(tlCache)); } catch { /* quota */ }
  }
  return out;
}
