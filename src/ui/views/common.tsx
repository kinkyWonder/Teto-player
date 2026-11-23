import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../icons';
import { toast, useStore } from '../../app/store';
import type { Track } from '../../core/types';
import { durMin, fmtNum, plural } from '../../core/util';
import { playTracks } from '../../app/actions';
import { t } from '../../i18n';
import { pickAll } from '../../core/pick';
import { isMobile } from '../../app/api';

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): T | null {
  const [v, setV] = useState<T | null>(null);
  const ver = useStore((s) => s.libVersion);
  useEffect(() => {
    let live = true;
    fn().then((r) => live && setV(r)).catch((e) => toast(String(e)));
    return () => { live = false; };
  }, [...deps, ver]);
  return v;
}

export const nTracks = (n: number) => `${n} ${plural(n, 'трек', 'трека', 'треков')}`;
export const nArtists = (n: number) => `${fmtNum(n)} ${plural(n, 'исполнитель', 'исполнителя', 'исполнителей')}`;
export const nAlbums = (n: number) => `${fmtNum(n)} ${plural(n, 'альбом', 'альбома', 'альбомов')}`;

export function ListHead({ tracks }: { tracks: Track[] | null }) {
  const dur = useMemo(() => tracks?.reduce((s, x) => s + x.dur, 0) ?? 0, [tracks]);
  return (
    <>
      <div className="psub">{tracks ? `${nTracks(tracks.length)} · ${durMin(dur)}` : ''}</div>
      <div className="acts" style={{ marginTop: 0 }}>
        <button className="play" onClick={() => tracks && playTracks(tracks, 0)}><Icon n="play" s={15} />{t('Слушать')}</button>
        <button className="ib" title={t('Перемешать')} onClick={() => tracks?.length && playTracks(tracks, Math.floor(Math.random() * tracks.length), true)}><Icon n="shuffle" s={16} /></button>
        {isMobile && !!tracks?.length && <button className="ib" title={t('Выбрать')} onClick={() => pickAll(tracks)}><Icon n="check" s={16} /></button>}
      </div>
    </>
  );
}
