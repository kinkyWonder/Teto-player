import { useState } from 'react';
import { api } from '../../app/api';
import { Icon } from '../icons';
import { getState, navigate, openMenu, setState, useStore } from '../../app/store';
import type { Playlist } from '../../core/types';
import { durMin, fmtNum } from '../../core/util';
import { newPlaylist, playMix, playTracks, refreshPlaylists } from '../../app/actions';
import { t } from '../../i18n';
import { orderPlaylists, movePlaylist, useExtrasVersion } from '../../core/extras';
import { pickPlaylistCover, playlistCoverUrl, resetPlaylistCover } from '../../cover/playlist';
import { isMobile } from '../../app/api';
import { Cover } from '../Cover';
import { TrackTable } from '../TrackTable';
import { useLoad, nTracks } from './common';

function PlCover({ p, size }: { p: Playlist; size: number }) {
  useExtrasVersion();
  const url = playlistCoverUrl(p.id);
  if (url) return <img className="cv" src={url} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover' }} />;
  return <Cover a={p.recipe ? { id: 0, cover: null, recipe: p.recipe } : { id: p.album_id, cover: null, recipe: null, title: p.name }} size={size} />;
}

export function playlistItems(p: Playlist, all: Playlist[], after?: () => void) {
  const hasCover = !!playlistCoverUrl(p.id);
  const ord = orderPlaylists(all);
  const i = ord.findIndex((x) => x.id === p.id);
  return [
    { label: t('Слушать'), onClick: async () => { const tr = await api.playlistTracks(p.id); if (tr.length) playTracks(tr, 0); } },
    { label: t('Перемешать'), onClick: async () => { const tr = await api.playlistTracks(p.id); if (tr.length) playMix(tr); } },
    { sep: true, label: '' },
    { label: t('Переименовать…'), onClick: () => renamePlaylist(p) },
    { label: hasCover ? t('Заменить обложку…') : t('Выбрать обложку…'), onClick: () => pickPlaylistCover(p.id) },
    ...(hasCover ? [{ label: t('Вернуть обложку'), onClick: () => resetPlaylistCover(p.id) }] : []),
    ...(i > 0 ? [{ label: t('Переместить выше'), onClick: () => movePlaylist(all, p.id, -1) }] : []),
    ...(i >= 0 && i < ord.length - 1 ? [{ label: t('Переместить ниже'), onClick: () => movePlaylist(all, p.id, 1) }] : []),
    { sep: true, label: '' },
    { label: t('Удалить плейлист'), danger: true, onClick: () => deletePlaylist(p, after) },
  ];
}
function renamePlaylist(p: Playlist) {
  setState({ dialog: { title: t('Переименовать'), text: '', ok: t('Сохранить'), input: p.name, onOk: async () => { const n = (getState().dialog?.input ?? '').trim(); if (n) { await api.renamePlaylist(p.id, n); refreshPlaylists(); } } } });
}
function deletePlaylist(p: Playlist, after?: () => void) {
  setState({ dialog: { title: t('Удалить плейлист?'), text: isMobile ? t('«{0}» будет удалён. Песни останутся в медиатеке.', p.name) : t('«{0}» будет удалён. Файлы останутся на диске.', p.name), ok: t('Удалить'), danger: true, onOk: async () => { await api.deletePlaylist(p.id); resetPlaylistCover(p.id); await refreshPlaylists(); after?.(); } } });
}

function PlaylistCard({ p, all, edit }: { p: Playlist; all: Playlist[]; edit: boolean }) {
  const menu = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); openMenu(e, playlistItems(p, all)); };
  return (
    <div className={'card plc' + (edit ? ' editing' : '')} onClick={() => !edit && navigate({ kind: 'playlist', id: p.id })} onContextMenu={menu}>
      <div className="cw">
        <PlCover p={p} size={190} />
        {!edit && !isMobile && <button className="fp" title={t('Слушать')} onClick={async (e) => { e.stopPropagation(); const tr = await api.playlistTracks(p.id); if (tr.length) playTracks(tr, 0); }}><Icon n="play" s={16} /></button>}
        {edit && (
          <div className="pl-edit" onClick={(e) => e.stopPropagation()}>
            <button title={t('Переместить выше')} onClick={() => movePlaylist(all, p.id, -1)}><Icon n="arrl" s={17} /></button>
            <button title={t('Обложка')} onClick={() => pickPlaylistCover(p.id)}><Icon n="photo" s={17} /></button>
            <button title={t('Ещё')} onClick={menu}><Icon n="more" s={17} /></button>
            <button title={t('Переместить ниже')} onClick={() => movePlaylist(all, p.id, 1)}><Icon n="arrr" s={17} /></button>
          </div>
        )}
      </div>
      <b title={p.name}>{p.name}</b>
      <span>{nTracks(p.tracks)}</span>
    </div>
  );
}

export function CatalogView() {
  useExtrasVersion();
  const raw = useStore((s) => s.playlists);
  const all = orderPlaylists(raw);
  const st = useStore((s) => s.stats);
  const [edit, setEdit] = useState(false);
  return (
    <>
      <div className="ptitle">{t('Каталог')}</div>
      <div className="sec">{t('Плейлисты')}{all.length > 0 && <button onClick={() => setEdit(!edit)}>{edit ? t('Готово') : t('Изменить')}</button>}</div>
      <div className="grid plgrid">
        {all.map((p) => <PlaylistCard key={p.id} p={p} all={raw} edit={edit} />)}
        <div className="card plc newpl" onClick={() => newPlaylist()}>
          <div className="cw"><div className="cv plus"><Icon n="plus" s={30} /></div></div>
          <b>{t('Новый плейлист')}</b><span>&nbsp;</span>
        </div>
      </div>
      {edit && <div className="note" style={{ marginTop: 10 }}><Icon n="info" s={14} />{t('Стрелки меняют порядок, фото — обложку, «⋯» — название и удаление.')}</div>}
      <div className="sec">{t('Медиатека')}</div>
      <div className="cat-links">
        <button onClick={() => navigate({ kind: 'artists' })}><Icon n="user" s={20} /><b>{t('Исполнители')}</b><span>{fmtNum(st.artists)}</span><Icon n="chev" s={14} /></button>
        <button onClick={() => navigate({ kind: 'tracks' })}><Icon n="lib" s={20} /><b>{t('Все треки')}</b><span>{fmtNum(st.tracks)}</span><Icon n="chev" s={14} /></button>
        <button onClick={() => navigate({ kind: 'albums' })}><Icon n="disc" s={20} /><b>{t('Альбомы')}</b><span>{fmtNum(st.albums)}</span><Icon n="chev" s={14} /></button>
        {!isMobile && <button onClick={() => navigate({ kind: 'folders' })}><Icon n="folder" s={20} /><b>{t('Папки')}</b><span /><Icon n="chev" s={14} /></button>}
      </div>
    </>
  );
}

export function PlaylistView({ id }: { id: number }) {
  useExtrasVersion();
  const all = useStore((s) => s.playlists);
  const pl = all.find((p) => p.id === id) as Playlist | undefined;
  const tracks = useLoad(() => api.playlistTracks(id), [id, pl?.tracks]);
  const dur = tracks?.reduce((s, x) => s + x.dur, 0) ?? 0;
  if (!pl) return <div className="muted">{t('Плейлист не найден')}</div>;
  const url = playlistCoverUrl(id);
  const first = tracks?.[0];
  return (
    <>
      <div className="ahead">
        {url ? <img className="cv" src={url} alt="" style={{ width: 168, height: 168, objectFit: 'cover' }} />
          : <Cover a={pl.recipe ? { id: 0, cover: null, recipe: pl.recipe } : first ? { id: first.album_id, cover: null, recipe: null, title: pl.name } : { id: 0, cover: null, recipe: null, title: pl.name }} size={168} eager />}
        <div>
          <div className="k">{t('Плейлист')}</div>
          <h1>{pl.name}</h1>
          <div className="m">{nTracks(tracks?.length ?? 0)} · {durMin(dur)}</div>
          <div className="acts">
            <button className="play" onClick={() => tracks?.length && playTracks(tracks, 0)}><Icon n="play" s={15} />{t('Слушать')}</button>
            <button className="ib" title={t('Перемешать')} onClick={() => tracks?.length && playTracks(tracks, Math.floor(Math.random() * tracks.length), true)}><Icon n="shuffle" s={16} /></button>
            <button className="ib" title={t('Ещё')} onClick={(e) => openMenu(e, playlistItems(pl, all, () => navigate({ kind: 'catalog' })).filter((_, k) => k > 2))}><Icon n="more" s={16} /></button>
          </div>
        </div>
      </div>
      {tracks && <TrackTable tracks={tracks} showAlbum numbered="index"
        extraMenu={(sel) => [{ label: t('Убрать из плейлиста'), danger: true, onClick: async () => { await api.removeFromPlaylist(id, sel.map((x) => x.id)); refreshPlaylists(); } }]} />}
      {tracks && !tracks.length && <div className="muted" style={{ marginTop: 24 }}>{isMobile ? t('Добавляйте песни через «⋯» у трека или выделив несколько долгим нажатием.') : t('Добавляйте песни через правый клик по треку.')}</div>}
    </>
  );
}
