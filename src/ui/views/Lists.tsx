import { startTransition, useEffect, useState } from 'react';
import { api } from '../../app/api';
import { Icon } from '../icons';
import { toast, useStore } from '../../app/store';
import type { SearchResult } from '../../core/types';
import { fmtNum } from '../../core/util';
import { addFolder, refreshLibrary } from '../../app/actions';
import { t } from '../../i18n';
import { isMobile } from '../../app/api';
import { TrackTable } from '../TrackTable';
import { useLoad, ListHead } from './common';
import { AlbumCard } from './Album';
import { ArtistCard } from './Artists';
import { askNet, isAsked, SearchOnline, useAsked } from './SearchOnline';
import { JobList } from './Jobs';
import type { DlMeta } from '../../core/download';

export function TracksView() {
  const sort = useStore((s) => s.sort);
  const tracks = useLoad(() => api.tracks(sort), [sort]);
  return (
    <>
      <div className="ptitle">{t('Все треки')}</div>
      <ListHead tracks={tracks} />
      {tracks && <TrackTable tracks={tracks} showAlbum numbered="index" />}
    </>
  );
}

export function FavsView() {
  const tracks = useLoad(() => api.favorites(), []);
  return (
    <>
      <div className="ptitle">{t('Любимое')}</div>
      <ListHead tracks={tracks} />
      {tracks && (tracks.length ? <TrackTable tracks={tracks} showAlbum numbered="index" /> : <div className="muted" style={{ marginTop: 30 }}>{t('Отмечайте треки сердечком — они появятся здесь.')}</div>)}
    </>
  );
}

export function SearchView({ q, net, meta }: { q: string; net?: boolean; meta?: DlMeta }) {
  const [r, setR] = useState<SearchResult | null>(null);
  const [all, setAll] = useState(false);
  useAsked();
  useEffect(() => setAll(false), [q]);
  // opened for the internet (album hint, shared words): search there at once
  useEffect(() => { if (net && q.trim()) askNet(q); }, [net, q]);
  // every letter: the library answers in milliseconds; the previous results stay until the new ones arrive (no flicker)
  useEffect(() => {
    let live = true;
    if (q.trim()) api.search(q).then((x) => live && startTransition(() => setR(x)));
    return () => { live = false; };
  }, [q]);
  if (!q.trim()) {
    return <>
      {isMobile && <JobList />}
      <div className="srch-empty muted"><Icon n="search" s={28} /><p>{isMobile ? t('Ищите в медиатеке — по мере ввода. Нажмите «Найти» (Enter) на клавиатуре, чтобы искать и скачивать песни из интернета. Ссылку YouTube, SoundCloud или Spotify можно просто вставить.') : t('Начните вводить запрос')}</p></div>
    </>;
  }
  if (!r) return null;
  const nothing = !r.tracks.length && !r.albums.length && !r.artists.length;
  // favourites first, then the whole library, then what can be downloaded; artists and albums after that.
  // After Enter (internet asked) the internet results come first: that is what was asked for.
  const fav = r.tracks.filter((x) => x.fav), other = r.tracks.filter((x) => !x.fav);
  const LIM = isAsked(q) ? 5 : 20, shown = all ? other : other.slice(0, LIM);
  const online = <SearchOnline q={q} local={r.tracks} meta={meta} />;
  const first = isAsked(q) || nothing;
  return (
    <>
      <div className="ptitle srch-t">{t('Поиск: «{0}»', q)}</div>
      {isMobile && <JobList />}
      {first && online}
      {nothing && !first && <div className="muted" style={{ marginTop: 20 }}>{t('В медиатеке ничего не найдено')}</div>}
      {!!fav.length && <><div className="sec" style={{ marginBottom: -10 }}><span><Icon n="heartf" s={14} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--acc)' }} />{t('В любимом')}</span></div><TrackTable tracks={fav} showAlbum numbered="index" /></>}
      {!!other.length && <><div className="sec" style={{ marginBottom: -10 }}>{fav.length ? t('Во всей медиатеке') : t('В медиатеке')}</div><TrackTable tracks={shown} showAlbum numbered="index" />
        {other.length > LIM && !all && <button className="lnk srch-more" onClick={() => setAll(true)}>{t('Показать все ({0})', other.length)}</button>}</>}
      {!first && online}
      {!!r.artists.length && <><div className="sec">{t('Исполнители')}</div><div className={'grid' + (isMobile ? ' hscroll' : '')}>{r.artists.slice(0, 8).map((a) => <ArtistCard key={a.name} a={a} />)}</div></>}
      {!!r.albums.length && <><div className="sec">{t('Альбомы')}</div><div className={'grid' + (isMobile ? ' hscroll' : '')}>{r.albums.slice(0, 12).map((a) => <AlbumCard key={a.id} a={a} />)}</div></>}
    </>
  );
}

/* ---------- folders & settings ---------- */
export function FoldersView() {
  const folders = useLoad(() => api.folders(), []);
  const scan = useStore((s) => s.scan);
  return (
    <div className="set">
      <div className="ptitle">{t('Папки')}</div>
      <div className="psub">{t('Teto Player следит за этими папками и автоматически подхватывает изменения.')}</div>
      {folders?.map((f) => (
        <div className="srow" key={f}>
          <div><div className="path" title={f}>{f}</div></div>
          <button className="btn" onClick={() => api.revealFile(f)}>{t('Открыть')}</button>
          <button className="btn" onClick={async () => { await api.removeFolder(f); refreshLibrary(); toast(t('Папка удалена из медиатеки')); }}><Icon n="trash" />{t('Убрать')}</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button className="btn pri" onClick={addFolder}><Icon n="plus" />{t('Добавить папку')}</button>
        <button className="btn" disabled={scan.state === 'scanning'} onClick={() => api.rescan()}><Icon n="refresh" />{t('Пересканировать')}</button>
      </div>
    </div>
  );
}

export function EmptyLibrary() {
  const scan = useStore((s) => s.scan);
  if (scan.state === 'scanning') {
    const pct = scan.total ? (scan.done / scan.total) * 100 : 0;
    return (
      <div className="empty-lib">
        <div className="big"><Icon n="refresh" s={34} /></div>
        <h2>{t('Сканируем медиатеку…')}</h2>
        <p>{scan.total ? t('{0} из {1} файлов', fmtNum(scan.done), fmtNum(scan.total)) : t('Ищем аудиофайлы')}</p>
        <div className="scanbox"><div className="pr"><b style={{ width: pct + '%' }} /></div><div>{scan.message}</div></div>
      </div>
    );
  }
  return (
    <div className="empty-lib">
      <div className="big"><Icon n="folder" s={36} /></div>
      <h2>{t('Медиатека пуста')}</h2>
      <p>{t('Добавьте папку с музыкой — Teto Player просканирует её в фоне, подтянет обложки и тексты, а для альбомов без обложки сгенерирует свою.')}</p>
      <button className="play" style={{ marginTop: 6 }} onClick={addFolder}><Icon n="folder" s={16} />{t('Добавить папку')}</button>
    </div>
  );
}
