/**
 * Monthly report: the numbers. Rows come from the hidden listening log (desktop: src-tauri/src/listen.rs,
 * phone: src/mobile/backend/listen.ts) — seconds / plays / skips per local day, hour and track.
 */
import { call } from '../app/api';
import { splitArtists, artistKey } from '../core/artists';
import { genresOf } from '../core/extras';
import { tagLabel } from '../core/tags';
import { t, isEn } from '../i18n';

export interface Row { d: string; h: number; id: number; s: number; p: number; k: number; title: string; artist: string; album: string; album_id: number; genre: string; dur: number }
export interface TopTrack { id: number; title: string; artist: string; album: string; album_id: number; genre: string; plays: number; secs: number }
export interface TopArtist { name: string; plays: number; secs: number; album_id: number; album: string; genre: string }
export interface TopAlbum { id: number; title: string; artist: string; genre: string; plays: number; secs: number }
export interface Persona { key: string; title: string; text: string }
export interface Report {
  month: string; label: string; year: number;
  secs: number; plays: number; skips: number; songs: number; artists: number; days: number; daysInMonth: number;
  topTracks: TopTrack[]; topArtists: TopArtist[]; topAlbums: TopAlbum[]; tags: { name: string; share: number }[];
  hours: number[]; weekdays: number[]; peakHour: number; peakWeekday: number;
  busiest: { d: string; secs: number } | null; streak: number; nightShare: number; newArtists: number;
  first: { title: string; artist: string } | null; persona: Persona;
  /** previous month's totals (null when nothing was played) — for the "vs last month" chip */
  prev: { secs: number; plays: number; songs: number; artists: number } | null;
  /** minutes per day of the month; weekday (Mon..Sun) × 3-hour buckets in seconds; morning/day/evening/night shares */
  daily: number[]; grid: number[]; parts: number[];
  newSongs: number; topShare: number; session: number; weekendShare: number;
  nightTrack: { title: string; artist: string; plays: number } | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const prevMonth = (d = new Date()) => monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1));
const range = (m: string) => { const [y, mo] = m.split('-').map(Number); return [`${m}-01`, `${monthKey(new Date(y, mo, 1))}-01`] as const; };
const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m: string) => (isEn() ? MONTHS_EN : MONTHS_RU)[+m.slice(5, 7) - 1];
export const WEEKDAYS = () => (isEn() ? ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'] : ['понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам', 'воскресеньям']);

export const fetchRows = async (from: string, to: string) => (await call<Row[]>('listen_log', { from, to }).catch(() => [])) ?? [];
export const firstDay = () => call<string | null>('listen_first', {}).catch(() => null);

function persona(r: Omit<Report, 'persona'>): Persona {
  const topShare = r.topArtists[0] && r.secs ? r.topArtists[0].secs / r.secs : 0;
  const morning = r.hours.slice(5, 10).reduce((a, b) => a + b, 0) / Math.max(1, r.secs);
  const perDay = r.secs / Math.max(1, r.days);
  if (r.nightShare >= 0.25) return { key: 'night', title: t('Ночная сова'), text: t('Четверть музыки — между полуночью и пятью утра') };
  if (r.topTracks[0]?.plays >= 25) return { key: 'repeat', title: t('На репите'), text: t('«{0}» — {1} раз за месяц', r.topTracks[0].title, r.topTracks[0].plays) };
  if (topShare >= 0.35) return { key: 'loyal', title: t('Верный фанат'), text: t('Больше трети времени — {0}', r.topArtists[0].name) };
  if (morning >= 0.3) return { key: 'early', title: t('Ранняя пташка'), text: t('Музыка с утра — до десяти часов') };
  if (perDay >= 3 * 3600) return { key: 'marathon', title: t('Марафонец'), text: t('Больше трёх часов музыки в день') };
  if (r.newArtists >= 15 || r.songs >= 200) return { key: 'explorer', title: t('Исследователь'), text: t('{0} новых исполнителей за месяц', r.newArtists) };
  return { key: 'meloman', title: t('Меломан'), text: t('Музыка — каждый день, в своём ритме') };
}

/** Builds the report of month `m` (YYYY-MM); null when there is (almost) nothing to show. */
export async function buildReport(m: string): Promise<Report | null> {
  const [from, to] = range(m);
  const rows = await fetchRows(from, to);
  const secs = rows.reduce((a, r) => a + r.s, 0);
  if (secs < 300) return null;
  const before = new Set<string>(), heard = new Set<number>();
  const first0 = await firstDay();
  const [py, pm] = m.split('-').map(Number);
  const pFrom = `${monthKey(new Date(py, pm - 2, 1))}-01`;
  let prevRows: Row[] = [];
  if (first0 && first0 < from) for (const r of await fetchRows(first0, from)) {
    for (const a of splitArtists(r.artist)) before.add(artistKey(a));
    heard.add(r.id);
    if (r.d >= pFrom) prevRows.push(r);
  }
  const pSecs = prevRows.reduce((a, r) => a + r.s, 0);
  const prevM = pSecs >= 300 ? {
    secs: pSecs, plays: prevRows.reduce((a, r) => a + r.p, 0), songs: new Set(prevRows.map((r) => r.id)).size,
    artists: new Set(prevRows.flatMap((r) => splitArtists(r.artist).map(artistKey))).size,
  } : null;
  prevRows = [];

  const tracks = new Map<number, TopTrack>(), artists = new Map<string, TopArtist>(), albums = new Map<number, TopAlbum>(), tags = new Map<string, number>();
  const hours = Array(24).fill(0), weekdays = Array(7).fill(0), byDay = new Map<string, number>(), grid = Array(56).fill(0);
  const byHour = new Map<string, number>(), night = new Map<number, number>();
  let plays = 0, skips = 0;
  for (const r of rows) {
    plays += r.p; skips += r.k;
    hours[r.h] += r.s;
    const wd = (new Date(r.d + 'T12:00:00').getDay() + 6) % 7; weekdays[wd] += r.s;
    grid[wd * 8 + Math.floor(r.h / 3)] += r.s;
    byHour.set(r.d + ' ' + r.h, (byHour.get(r.d + ' ' + r.h) ?? 0) + r.s);
    if (r.h < 5) night.set(r.id, (night.get(r.id) ?? 0) + r.p);
    byDay.set(r.d, (byDay.get(r.d) ?? 0) + r.s);
    const tt = tracks.get(r.id) ?? { id: r.id, title: r.title, artist: r.artist, album: r.album, album_id: r.album_id, genre: r.genre, plays: 0, secs: 0 };
    tt.plays += r.p; tt.secs += r.s; tracks.set(r.id, tt);
    for (const name of splitArtists(r.artist)) {
      const k = artistKey(name);
      const a = artists.get(k) ?? { name, plays: 0, secs: 0, album_id: r.album_id, album: r.album, genre: r.genre };
      a.plays += r.p; a.secs += r.s; artists.set(k, a);
    }
    const al = albums.get(r.album_id) ?? { id: r.album_id, title: r.album, artist: r.artist, genre: r.genre, plays: 0, secs: 0 };
    al.plays += r.p; al.secs += r.s; albums.set(r.album_id, al);
    for (const g of genresOf({ id: r.id, genre: r.genre, title: r.title, artist: r.artist })) tags.set(g, (tags.get(g) ?? 0) + r.s);
  }
  const by = <T extends { plays: number; secs: number }>(l: Iterable<T>) => [...l].sort((a, b) => b.plays - a.plays || b.secs - a.secs);
  const topArtists = by(artists.values()).slice(0, 5);
  // the album cover that represents an artist: their most played album
  for (const a of topArtists) {
    const best = by([...albums.values()].filter((x) => splitArtists(x.artist).some((n) => artistKey(n) === artistKey(a.name))))[0];
    if (best) { a.album_id = best.id; a.album = best.title; a.genre = best.genre; }
  }
  const days = [...byDay.entries()].filter(([, s]) => s >= 60).map(([d]) => d).sort();
  let streak = 0, run = 0, prev = '';
  for (const d of days) {
    let next = '';
    if (prev) { const nd = new Date(prev + 'T12:00:00'); nd.setDate(nd.getDate() + 1); next = `${nd.getFullYear()}-${pad(nd.getMonth() + 1)}-${pad(nd.getDate())}`; }
    run = next === d ? run + 1 : 1; streak = Math.max(streak, run); prev = d;
  }
  const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const firstRow = rows.slice().sort((a, b) => a.d.localeCompare(b.d) || a.h - b.h)[0];
  const tagTotal = [...tags.values()].reduce((a, b) => a + b, 0) || 1;
  const [y, mo] = m.split('-').map(Number);
  const dim = new Date(y, mo, 0).getDate();
  const daily = Array.from({ length: dim }, (_, i) => Math.round((byDay.get(`${m}-${pad(i + 1)}`) ?? 0) / 60));
  // the longest "session": consecutive clock hours with at least 10 minutes of music each
  let session = 0;
  for (const [k, v] of byHour) {
    if (v < 600) continue;
    const [d, h] = k.split(' ');
    if ((byHour.get(d + ' ' + (+h - 1)) ?? 0) >= 600) continue; // not the start of a run
    let n = 1;
    while ((byHour.get(d + ' ' + (+h + n)) ?? 0) >= 600) n++;
    session = Math.max(session, n);
  }
  const sum = (a: number[]) => a.reduce((x, v) => x + v, 0);
  const parts = [sum(hours.slice(5, 12)), sum(hours.slice(12, 18)), sum(hours.slice(18, 23)), hours[23] + sum(hours.slice(0, 5))].map((v) => v / secs);
  const nt = [...night.entries()].sort((a, b) => b[1] - a[1])[0];
  const ntt = nt && nt[1] >= 2 ? tracks.get(nt[0]) : undefined;
  const base: Omit<Report, 'persona'> = {
    month: m, label: monthName(m), year: y,
    secs, plays, skips, songs: tracks.size, artists: artists.size, days: days.length, daysInMonth: dim,
    topTracks: by(tracks.values()).slice(0, 5), topArtists, topAlbums: by(albums.values()).slice(0, 3),
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, s]) => ({ name: tagLabel(name), share: s / tagTotal })),
    hours, weekdays, peakHour: hours.indexOf(Math.max(...hours)), peakWeekday: weekdays.indexOf(Math.max(...weekdays)),
    busiest: busiest ? { d: busiest[0], secs: busiest[1] } : null, streak,
    nightShare: hours.slice(0, 5).reduce((a, b) => a + b, 0) / secs,
    newArtists: before.size ? [...artists.keys()].filter((k) => !before.has(k)).length : 0,
    first: firstRow ? { title: firstRow.title, artist: firstRow.artist } : null,
    prev: prevM, daily, grid, parts,
    newSongs: heard.size ? [...tracks.keys()].filter((id) => !heard.has(id)).length : 0,
    topShare: topArtists[0] ? topArtists[0].secs / secs : 0,
    session, weekendShare: (weekdays[5] + weekdays[6]) / secs,
    nightTrack: ntt ? { title: ntt.title, artist: ntt.artist, plays: nt[1] } : null,
  };
  return { ...base, persona: persona(base) };
}
