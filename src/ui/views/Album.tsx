import { api } from '../../app/api';
import { Icon } from '../icons';
import { getState, navigate, openMenu, useStore } from '../../app/store';
import { regenerateCover } from '../../cover/actions';
import type { Album, Track } from '../../core/types';
import { durMin } from '../../core/util';
import { playAlbum, playTracks, refreshLibrary } from '../../app/actions';
import { t } from '../../i18n';
import { downloadHint, useMissing, type HintItem } from '../../core/hints';
import { fmtTime } from '../../core/util';
import { downloadAlbum, useAlbumBatch, useDlJobs, type DlMeta } from '../../core/download';
import { pickAll } from '../../core/pick';
import { isMobile } from '../../app/api';
import { Cover } from '../Cover';
import { splitGenres, tagLabel } from '../../core/tags';
import { TrackTable } from '../TrackTable';
import { useLoad, nTracks, nAlbums } from './common';

/* ---------- album ---------- */
export function AlbumView({ id }: { id: number }) {
  const album = useLoad(() => api.album(id), [id]);
  const tracks = useLoad(() => api.albumTracks(id), [id]);
  const npAlbum = useStore((s) => (s.currentAlbum?.id === id ? s.currentAlbum : null));
  const a = npAlbum ?? album;
  if (!a) return null;
  const dur = tracks?.reduce((s, t) => s + t.dur, 0) ?? a.dur;
  const allFav = !!tracks?.length && tracks.every((t) => t.fav);
  const more = (e: React.MouseEvent) => openMenu(e, [
    { label: t('Играть следующим'), onClick: () => tracks && api.enqueue(tracks.map((x) => x.id), true) },
    { label: t('Добавить в очередь'), onClick: () => tracks && api.enqueue(tracks.map((x) => x.id), false) },
    ...(isMobile ? [
      { label: t('Выбрать треки'), onClick: () => tracks && pickAll(tracks) },
      { label: t('Заменить обложку фото…'), onClick: () => import('../../mobile/photo').then((m) => m.pickCover(a.id)) },
    ] : [
      { label: t('Перейти к исполнителю'), onClick: () => navigate({ kind: 'artist', name: a.artist }) },
      ...(tracks?.[0] ? [{ label: t('Показать в проводнике'), onClick: () => api.revealFile(tracks[0].path) }] : []),
      { label: t('Заменить обложку картинкой…'), onClick: () => import('../../mobile/photo').then((m) => m.pickCover(a.id)) },
      ...(a.cover === 'custom' ? [{ label: t('Вернуть исходную обложку'), onClick: () => import('../../mobile/photo').then((m) => m.resetCover(a.id)) }] : []),
    ]),
    { sep: true, label: '' },
    { label: t('Пересоздать обложку'), disabled: getState().genBusy.includes(a.id), onClick: () => regenerateCover(a.id) },
  ]);
  return (
    <>
      <div className="ahead">
        <Cover a={a} size={168} eager />
        <div>
          <div className="k">{t('Альбом')}{a.year ? ` · ${a.year}` : ''}</div>
          <h1 title={a.title}>{a.title}</h1>
          <div className="m">
            <a onClick={() => navigate({ kind: 'artist', name: a.artist })}>{a.artist}</a> · {nTracks(tracks?.length ?? a.tracks)} · {durMin(dur)}
            {a.genre ? ` · ${splitGenres(a.genre).slice(0, 2).map(tagLabel).join(', ')}` : ''}
          </div>
          <div className="acts">
            <button className="play" onClick={() => tracks && playTracks(tracks, 0)}><Icon n="play" s={15} />{t('Слушать')}</button>
            <button className="ib" title={t('Перемешать')} onClick={() => playAlbum(id, true)}><Icon n="shuffle" s={16} /></button>
            <button className={'ib' + (allFav ? ' on' : '')} title={t('В любимое')} onClick={async () => { await api.setAlbumFav(id, !allFav); refreshLibrary(); }}>
              <Icon n={allFav ? 'heartf' : 'heart'} s={16} />
            </button>
            <button className="ib" onClick={more}><Icon n="more" s={16} /></button>
          </div>
        </div>
      </div>
      {tracks && <TrackTable tracks={tracks} />}
      <AlbumHints artist={a.artist} album={a.title} year={a.year} tracks={tracks} />
    </>
  );
}

/** "Hints": songs of this album that are not here yet, greyed, with a "Download" button. */
function AlbumHints({ artist, album, year, tracks }: { artist: string; album: string; year?: number; tracks: Track[] | null }) {
  const miss = useMissing(artist, album, tracks);
  const jobs = useDlJobs();
  const key = artist + '|' + album;
  const batch = useAlbumBatch(key);
  if (!miss.length) return null;
  const meta = (h: HintItem): DlMeta => ({ album, albumArtist: artist, no: h.no, disc: h.disc, year: year || 0 });
  const jobOf = (h: HintItem) => jobs.find((j) => j.title === h.title && j.artist === artist);
  const left = miss.filter((h) => { const j = jobOf(h); return !j || j.state === 'failed'; });
  return (
    <div className="hints">
      <div className="sec">{t('Нет в медиатеке')}<span className="hn">{miss.length}</span>
        {left.length > 1 && (
          <button className={'hall' + (batch?.running ? ' run' : '')} disabled={batch?.running} onClick={() => downloadAlbum(key, artist, left.map((h) => ({ title: h.title, dur: h.dur, meta: meta(h) })))}>
            {batch?.running ? <><span className="hall-sp" />{t('Ищу {0} из {1}…', Math.min(batch.done + 1, batch.total), batch.total)}</>
              : <><Icon n="download" s={14} />{t('Скачать все ({0})', left.length)}</>}
          </button>
        )}
      </div>
      {batch?.running && <div className="hall-bar"><b style={{ width: `${(batch.done / Math.max(1, batch.total)) * 100}%` }} /></div>}
      {miss.map((h: HintItem) => {
        const j = jobOf(h);
        const live = j && (j.state === 'queued' || j.state === 'running');
        const missed = !j && batch?.missed.includes(h.title);
        return (
          <div key={h.disc + ':' + h.no + h.title} className={'hrow' + (live ? ' live' : '') + (j?.state === 'done' ? ' ok' : '')}>
            <span className="hno">{h.no || ''}</span>
            <div className="hti"><b>{h.title}</b><span>{live ? j!.message : missed ? t('Не нашлось само — нажмите, чтобы выбрать') : j?.state === 'failed' ? j.message : artist}</span></div>
            <span className="hdur">{h.dur ? fmtTime(h.dur) : ''}</span>
            {j?.state === 'done' ? <span className="hok"><Icon n="check" s={16} /></span>
              : live ? <span className="hpr" style={{ ['--p' as string]: Math.max(0.04, j!.progress) }} />
              : <button className="btn hdl" onClick={() => (missed ? navigate({ kind: 'download', q: `${artist} - ${h.title}`, meta: meta(h) }) : downloadHint(artist, h.title, h.dur, meta(h)))}>
                  <Icon n={missed ? 'search' : 'download'} s={14} />{missed ? t('Выбрать') : t('Скачать')}</button>}
          </div>
        );
      })}
      <div className="note hnote"><Icon n="info" s={14} />{t('«Скачать» кладёт песню прямо в этот альбом — подсказка исчезнет сама.')}</div>
    </div>
  );
}

/* ---------- grids ---------- */
export function AlbumCard({ a }: { a: Album }) {
  const busy = useStore((s) => s.genBusy.includes(a.id));
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    openMenu(e, [
      { label: t('Слушать'), onClick: () => playAlbum(a.id) },
      { label: t('Перемешать'), onClick: () => playAlbum(a.id, true) },
      ...(isMobile ? [] : [{ label: t('Перейти к исполнителю'), onClick: () => navigate({ kind: 'artist', name: a.artist }) }]),
      { sep: true, label: '' },
      { label: busy ? t('Обложка создаётся…') : t('Пересоздать обложку'), disabled: busy, onClick: () => regenerateCover(a.id) },
    ]);
  };
  return (
    <div className="card" onClick={() => navigate({ kind: 'album', id: a.id })} onContextMenu={menu}>
      <div className="cw">
        <Cover a={a} size={190} className={'cv' + (busy ? ' genbusy' : '')} />
        <button className="fp" title={t('Слушать')} onClick={(e) => { e.stopPropagation(); playAlbum(a.id); }}><Icon n="play" s={16} /></button>
      </div>
      <b title={a.title}>{a.title}</b>
      <span>{a.artist}{a.year ? ` · ${a.year}` : ''}</span>
    </div>
  );
}

export function AlbumsView() {
  const sort = useStore((s) => s.sort);
  const albums = useLoad(() => api.albums(sort), [sort]);
  const n = useStore((s) => s.stats.albums);
  return (
    <>
      <div className="ptitle">{t('Альбомы')}</div>
      <div className="psub">{nAlbums(n)}</div>
      <div className="grid">{albums?.map((a) => <AlbumCard key={a.id} a={a} />)}</div>
    </>
  );
}
