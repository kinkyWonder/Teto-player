import { useMemo } from 'react';
import { api } from '../../app/api';
import { Icon } from '../icons';
import { getState, navigate, openMenu, setState, useStore } from '../../app/store';
import type { Track } from '../../core/types';
import { playMix, playTeto } from '../../app/actions';
import { t, isEn } from '../../i18n';
import { useExtrasVersion } from '../../core/extras';
import { Logo } from '../Logo';
import { groupGenres } from '../../core/mix';
import { tagLabel } from '../../core/tags';
import { PALETTES, paletteFor } from '../../cover/palettes';
import { isMobile } from '../../app/api';
import { useLoad, nTracks, nArtists, nAlbums } from './common';
import { AlbumCard } from './Album';
import { showReport, useReportWindow } from '../../report/schedule';

export function HomeView() {
  const recent = useLoad(() => api.recent(), []);
  const sort = useStore((s) => s.sort);
  const albums = useLoad(() => api.albums(isMobile ? sort : 'added'), [sort]);
  const st = useStore((s) => s.stats);
  const hour = new Date().getHours();
  const hi = hour < 6 ? t('Доброй ночи') : hour < 12 ? t('Доброе утро') : hour < 18 ? t('Добрый день') : t('Добрый вечер');
  return (
    <>
      <div className="ptitle">{hi}</div>
      <div className="psub">{nTracks(st.tracks)} · {nAlbums(st.albums)} · {nArtists(st.artists)}</div>
      <ReportBanner />
      <TetoStrip />
      {!!recent?.length && <><div className="sec">{t('Недавно слушали')}</div><div className={'grid' + (isMobile ? ' hscroll' : '')}>{recent.slice(0, 12).map((a) => <AlbumCard key={a.id} a={a} />)}</div></>}
      {isMobile ? <>
        <div className="sec">{t('Все альбомы')}<button onClick={(e) => openMenu(e, ALBUM_SORTS.map(([k, l]) => ({ label: (k === sort ? '✓ ' : '\u2003') + t(l), onClick: () => setState({ sort: k }) })))}><Icon n="sort" s={14} />{t(ALBUM_SORTS.find(([k]) => k === sort)?.[1] ?? 'По исполнителю')}</button></div>
        <div className="grid">{albums?.map((a) => <AlbumCard key={a.id} a={a} />)}</div>
      </> : <>
        <div className="sec">{t('Недавно добавленные')}<button onClick={() => { setState({ sort: 'added' }); navigate({ kind: 'albums' }); }}>{t('Все альбомы')}</button></div>
        <div className="grid">{albums?.slice(0, 18).map((a) => <AlbumCard key={a.id} a={a} />)}</div>
      </>}
    </>
  );
}
const ALBUM_SORTS: [string, string][] = [['artist', 'По исполнителю'], ['title', 'По названию'], ['year', 'По году'], ['added', 'По дате добавления']];

/* ---------- genres & the Teto mix ---------- */
let allCache: { ver: number; p: Promise<Track[]> } | null = null;
export const allTracks = () => {
  const v = getState().libVersion;
  if (!allCache || allCache.ver !== v) allCache = { ver: v, p: api.tracks('artist') };
  return allCache.p;
};
export function useGenres() {
  const ev = useExtrasVersion(); // own genres changed
  const tracks = useLoad(allTracks, []);
  const ag = useLoad(() => api.albumGenres().catch(() => [] as [number, string][]), []);
  return useMemo(() => (tracks ? { all: tracks, ...groupGenres(tracks, new Map(ag ?? [])) } : null), [tracks, ag, ev]);
}

/** Tag tile style: the gradient plus its two accent colours as CSS variables (AMOLED draws only thin glows). */
export function genreStyle(name: string): React.CSSProperties {
  const p = PALETTES[paletteFor(name)] ?? PALETTES.default;
  return { background: genreBg(name), ['--ga' as string]: p[2], ['--gb' as string]: p[4] };
}
export function genreBg(name: string) {
  const p = PALETTES[paletteFor(name)] ?? PALETTES.default;
  return `radial-gradient(120% 140% at 0% 0%, ${p[2]}55, transparent 60%), radial-gradient(120% 140% at 100% 100%, ${p[4]}66, transparent 55%), linear-gradient(135deg, ${p[1]}, ${p[0]})`;
}

/** The Teto button: the songs you pick most often first (shuffled), then everything else. */
export function TetoButton({ list, big }: { list?: Track[]; big?: boolean }) {
  return (
    <button className={'mixb teto' + (big ? ' big' : '')} onClick={() => playTeto(list)}>
      <span className="tlogo"><Logo s={big ? 26 : 22} /></span>
      <div><b>Teto</b><span>{t('Ваши любимые вперемешку, потом — всё остальное')}</span></div>
      <i className="tgo"><Icon n="play" s={16} /></i>
    </button>
  );
}

/** Home: the Teto button (+ the most common genres as quick starts on desktop). */
function TetoStrip() {
  const g = useGenres();
  if (!g || !g.all.length) return null;
  return (
    <div className="mixs">
      <TetoButton list={g.all} big={isMobile} />
      {!isMobile && g.list.filter((x) => x.tracks.length).slice(0, 7).map((x) => (
        <button key={x.key} className="gchip" style={genreStyle(x.name)} onClick={() => playMix(x.tracks, undefined, 'tag:' + x.key)}>{tagLabel(x.name)}</button>
      ))}
      {!isMobile && g.list.length > 0 && <button className="gchip more" onClick={() => navigate({ kind: 'genres' })}>{t('Все тэги')}<Icon n="chev" s={14} /></button>}
    </div>
  );
}

/** From the last day of the month through the 3rd: "your month is ready" — opens the report. */
function ReportBanner() {
  const w = useReportWindow();
  if (!w) return null;
  return (
    <button className={'rbanner' + (w.seen ? ' seen' : '')} onClick={() => showReport(w.month)}>
      <span className="rb-glow" aria-hidden><i /><i /><i /></span>
      <span className="rb-ic"><Icon n="sparkle" s={22} /></span>
      <span className="rb-t"><small>{t('Итоги месяца')}</small><b>{t('Ваш {0} в Teto', (isEn() ? w.label : w.label.toLowerCase()))}</b><span>{w.seen ? t('Посмотреть ещё раз') : t('Время, любимые песни, привычки — нажмите')}</span></span>
      <i className="rb-go"><Icon n="arrr" s={18} /></i>
    </button>
  );
}
