import { useEffect, useState } from 'react';
import { hasArtist } from '../../core/artists';
import { api, artistPhotoUrl } from '../../app/api';
import { artistMenu } from '../../core/names';
import { Icon } from '../icons';
import { navigate, openMenu, useStore } from '../../app/store';
import type { Artist } from '../../core/types';
import { playMix, playTracks } from '../../app/actions';
import { t } from '../../i18n';
import { Cover } from '../Cover';
import { TrackTable } from '../TrackTable';
import { useLoad, nTracks, nArtists, nAlbums } from './common';
import { AlbumCard } from './Album';
import { allTracks } from './Home';

export function ArtistsView() {
  const list = useLoad(() => api.artists(), []);
  return (
    <>
      <div className="ptitle">{t('Исполнители')}</div>
      <div className="psub">{list ? nArtists(list.length) : ''}</div>
      <div className="grid">{list?.map((a) => <ArtistCard key={a.name} a={a} />)}</div>
    </>
  );
}

export function ArtistCard({ a }: { a: Artist }) {
  return (
    <div className="card round" onClick={() => navigate({ kind: 'artist', name: a.name })}>
      <div className="cw"><Cover a={{ id: a.album_id, cover: a.cover, recipe: a.recipe, title: a.album_title, artist: a.name, genre: a.genre }} size={190} /></div>
      <b style={{ textAlign: 'center' }}>{a.name}</b>
      <span style={{ textAlign: 'center' }}>{nAlbums(a.albums)} · {nTracks(a.tracks)}</span>
    </div>
  );
}

export function ArtistView({ name }: { name: string }) {
  const albums = useLoad(() => api.artistAlbums(name), [name]);
  const photoRev = useStore((s) => s.photoRev);
  const [photo, setPhoto] = useState('');
  useEffect(() => { let live = true; artistPhotoUrl(name).then((u) => live && setPhoto(u)); return () => { live = false; }; }, [name, photoRev]);
  // every track by the artist: their albums + appearances on other albums / compilations
  const tracks = useLoad(async () => {
    const al = await api.artistAlbums(name);
    const own = new Set(al.map((a) => a.id));
    const all = await allTracks();
    return all.filter((x) => own.has(x.album_id) || hasArtist(x.artist, name))
      .sort((a, b) => (b.year || 0) - (a.year || 0) || a.album.localeCompare(b.album) || a.disc - b.disc || a.no - b.no);
  }, [name]);
  const first = albums?.[0];
  const n = tracks?.length ?? 0;
  return (
    <>
      <div className="ar-head">
        {photo ? <img className="ar-photo" src={photo} alt="" />
          : first ? <Cover a={first} size={168} className="ar-photo" eager /> : null}
        <div style={{ minWidth: 0 }}>
          <div className="k" style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--t3)' }}>{t('Исполнитель')}</div>
          <div className="ptitle" style={{ fontSize: 34 }}>{name}</div>
          <div className="psub">{nAlbums(albums?.length ?? 0)} · {nTracks(n)}</div>
        </div>
      </div>
      <div className="acts" style={{ marginTop: 0 }}>
        <button className="play" onClick={() => tracks && playTracks(tracks, 0)}><Icon n="play" s={15} />{t('Слушать всё')}</button>
        <button className="ib" title={t('Перемешать')} onClick={() => tracks && playMix(tracks)}><Icon n="shuffle" s={16} /></button>
        <button className="ib" title={t('Ещё')} onClick={(e) => openMenu(e, artistMenu(name, !!photo))}><Icon n="more" s={16} /></button>
      </div>
      {!!albums?.length && <><div className="sec">{t('Альбомы')}</div>
        <div className="grid">{albums.map((a) => <AlbumCard key={a.id} a={a} />)}</div></>}
      <div className="sec" style={{ marginBottom: -10 }}>{t('Все треки')}</div>
      {tracks && <TrackTable tracks={tracks} showAlbum />}
    </>
  );
}

/* ---------- track lists ---------- */
