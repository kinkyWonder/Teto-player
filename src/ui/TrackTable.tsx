import { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import { ArtistLinks } from '../core/artists';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Track } from '../core/types';
import { Icon } from './icons';
import { useStore, navigate } from '../app/store';
import { fmtFormat, fmtTime, isHiRes } from '../core/util';
import { playPicked, trackMenu } from '../app/actions';
import { t as tr } from '../i18n';
import { startPick, togglePick } from '../core/pick';
import { renameTrackDialog } from '../core/names';
import type { MenuItem } from '../app/store';
import { albumHasCover, isMobile } from '../app/api';
import { Cover } from './Cover';
import { usePrefsLite } from '../core/prefsHook';

export const ScrollCtx = createContext<React.RefObject<HTMLDivElement>>({ current: null });

export function EqBars({ anim }: { anim: boolean }) {
  return <span className={'eqb' + (anim ? ' anim' : '')}><b /><b /><b /></span>;
}

interface Props {
  tracks: Track[];
  showAlbum?: boolean;
  numbered?: 'no' | 'index';
  extraMenu?: (sel: Track[]) => MenuItem[];
}

const COLS = '40px minmax(0,1.14fr) minmax(0,1.1fr) minmax(0,1fr) 64px';
const COLS_AL = '40px minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) 120px 64px';
const COLS_M = '44px minmax(0,1fr) 40px';

export function TrackTable({ tracks, showAlbum, numbered = 'no', extraMenu }: Props) {
  const scrollRef = useContext(ScrollCtx);
  const listRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState(-1);
  const [margin, setMargin] = useState(0);
  const cur = useStore((s) => s.player.track?.id ?? -1);
  const playing = useStore((s) => s.player.playing);
  const albumPref = usePrefsLite().listAlbum;
  const albumText = !!showAlbum && albumPref;
  const cols = isMobile ? COLS_M : albumText ? COLS_AL : COLS;
  const picked = useStore((s) => s.pick);
  const pickIds = isMobile && picked ? new Set(picked.map((x) => x.id)) : null;

  useEffect(() => {
    if (listRef.current) setMargin(listRef.current.offsetTop);
  });
  useEffect(() => setSel(new Set()), [tracks]);

  const v = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (isMobile ? 58 : 44),
    overscan: 12,
    scrollMargin: margin,
  });

  const click = (e: React.MouseEvent, i: number) => {
    const id = tracks[i].id;
    if (e.shiftKey && anchor >= 0) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      setSel(new Set(tracks.slice(a, b + 1).map((t) => t.id)));
    } else if (e.ctrlKey) {
      const n = new Set(sel);
      n.has(id) ? n.delete(id) : n.add(id);
      setSel(n);
      setAnchor(i);
    } else {
      setSel(new Set([id]));
      setAnchor(i);
    }
  };
  const ctx = (e: React.MouseEvent, i: number) => {
    let s = sel;
    if (!sel.has(tracks[i].id)) { s = new Set([tracks[i].id]); setSel(s); setAnchor(i); }
    const list = tracks.filter((t) => s.has(t.id));
    trackMenu(e, list, extraMenu?.(list));
  };

  return (
    <>
      {!isMobile && <div className="tt-head" style={{ gridTemplateColumns: cols }}>
        <div>#</div><div>{tr('Название')}</div><div>{tr('Исполнитель')}</div>{albumText && <div>{tr('Альбом')}</div>}<div>{tr('Формат')}</div>
        <div style={{ textAlign: 'right' }}><Icon n="clock" s={14} /></div>
      </div>}
      <div ref={listRef} style={{ height: v.getTotalSize(), position: 'relative', paddingBottom: 24 }}>
        {v.getVirtualItems().map((it) => {
          const t = tracks[it.index];
          return (
            <Row key={t.id} t={t} i={it.index} cols={cols} showAlbum={!!showAlbum} albumText={albumText} on={t.id === cur} anim={t.id === cur && playing}
              sel={pickIds ? pickIds.has(t.id) : sel.has(t.id)} picking={!!pickIds} num={numbered === 'no' ? t.no || it.index + 1 : it.index + 1}
              top={it.start - margin} onClick={click} onCtx={ctx} onPlay={(i) => playPicked(tracks, i)} src={tracks} />
          );
        })}
      </div>
    </>
  );
}

const Row = memo(function Row({ t, i, cols, showAlbum, albumText, on, anim, sel, picking, num, top, onClick, onCtx, onPlay, src }: {
  t: Track; i: number; cols: string; showAlbum: boolean; albumText: boolean; on: boolean; anim: boolean; sel: boolean; picking: boolean; num: number; top: number;
  onClick: (e: React.MouseEvent, i: number) => void; onCtx: (e: React.MouseEvent, i: number) => void; onPlay: (i: number) => void; src: Track[];
}) {
  if (isMobile) return <MRow t={t} i={i} cols={cols} showAlbum={showAlbum} albumText={albumText} on={on} anim={anim} top={top} sel={sel} picking={picking} onCtx={onCtx} onPlay={onPlay} src={src} />;
  const f = fmtFormat(t);
  return (
    <div className={'trow' + (on ? ' on' : '') + (sel && !on ? ' sel' : '') + (t.missing ? ' miss' : '')}
      style={{ gridTemplateColumns: cols, position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${top}px)` }}
      onMouseDown={(e) => e.button === 0 && onClick(e, i)} onDoubleClick={() => onPlay(i)} onContextMenu={(e) => onCtx(e, i)}
      title={t.missing ? tr('Файл не найден: ') + t.path : undefined}>
      <div className="n">
        {on ? <EqBars anim={anim} /> : <><span className="num">{num}</span><span className="pi" onClick={() => onPlay(i)}><Icon n="play" s={13} /></span></>}
      </div>
      <div className="tt">{t.missing && <Icon n="warn" s={13} style={{ marginRight: 6, verticalAlign: -2, color: '#ffb4ab' }} />}{t.title}<Review t={t} /></div>
      <div><ArtistLinks name={t.artist} className="ar" /></div>
      {albumText && <div><span className="al" onClick={(e) => { e.stopPropagation(); navigate({ kind: 'album', id: t.album_id }); }}>{t.album}</span></div>}
      <div><span className={'fmt' + (isHiRes(t) ? ' hi' : '')}>{f}</span></div>
      <div className="d">
        <button className="mo" title={tr('Ещё')} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onCtx(e, i); }}><Icon n="more" s={16} /></button>
        {fmtTime(t.dur)}
      </div>
    </div>
  );
});

/** Unobtrusive "check this name" mark for tracks whose names were recognised automatically. */
function Review({ t, passive }: { t: Track; passive?: boolean }) {
  const r = useStore((s) => s.review[t.id]);
  if (!r) return null;
  const tip = r === 2 ? tr('Исполнитель и название распознаны автоматически и переставлены местами — проверьте. Нажмите, чтобы исправить') : tr('Название распознано автоматически — проверьте. Нажмите, чтобы исправить');
  if (passive) return <span className="rvw" title={tip}><Icon n="info" s={12} /></span>;
  return (
    <span className="rvw" title={tip} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); renameTrackDialog(t); }}><Icon n="info" s={12} /></span>
  );
}

/** Phone row: cover (or album number), title + artist, ⋯. A tap anywhere plays the song (nothing navigates away);
 *  a long press starts selecting, then taps add / remove songs. */
const MRow = memo(function MRow({ t, i, cols, showAlbum, albumText, on, anim, top, sel, picking, onCtx, onPlay, src }: {
  t: Track; i: number; cols: string; showAlbum: boolean; albumText: boolean; on: boolean; anim: boolean; top: number; sel: boolean; picking: boolean;
  onCtx: (e: React.MouseEvent, i: number) => void; onPlay: (i: number) => void; src: Track[];
}) {
  const lp = useRef<{ t: number; x: number; y: number; fired: boolean } | null>(null);
  const begin = () => { if (!picking) startPick(t, src); };
  const down = (e: React.TouchEvent) => {
    const p = e.touches[0];
    const st = { t: 0, x: p.clientX, y: p.clientY, fired: false };
    st.t = window.setTimeout(() => { st.fired = true; begin(); }, 460);
    lp.current = st;
  };
  const move = (e: React.TouchEvent) => {
    const st = lp.current, p = e.touches[0];
    if (st && !st.fired && Math.hypot(p.clientX - st.x, p.clientY - st.y) > 10) { clearTimeout(st.t); lp.current = null; }
  };
  const up = () => { if (lp.current && !lp.current.fired) clearTimeout(lp.current.t); };
  const tap = () => {
    const st = lp.current; lp.current = null;
    if (st?.fired) return; // the long press already selected this row
    if (picking) togglePick(t); else onPlay(i);
  };
  return (
    <div className={'trow m' + (on ? ' on' : '') + (sel ? ' pk' : '')} style={{ gridTemplateColumns: cols, position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${top}px)` }}
      onClick={tap} onTouchStart={down} onTouchMove={move} onTouchEnd={up} onTouchCancel={up}
      onContextMenu={(e) => { e.preventDefault(); if (!lp.current?.fired) { if (lp.current) clearTimeout(lp.current.t); lp.current = { t: 0, x: 0, y: 0, fired: true }; begin(); } }}>
      <div className="n">
        {picking ? <span className={'mchk' + (sel ? ' on' : '')}>{sel && <Icon n="check" s={15} />}</span>
          : showAlbum ? <span className="mc"><Cover a={{ id: t.album_id, cover: albumHasCover(t.album_id) ? 'file' : null, recipe: null, title: t.album, artist: t.artist, genre: t.genre }} size={40} />{on && <EqBars anim={anim} />}</span>
          : on ? <EqBars anim={anim} /> : <span className="num">{t.no || i + 1}</span>}
      </div>
      <div className="tt2"><b>{t.title}<Review t={t} passive /></b><span>{t.artist}{albumText && t.album && t.album !== 'Синглы' ? ' · ' + t.album : ''}</span></div>
      {!picking && <button className="mo" onClick={(e) => { e.stopPropagation(); onCtx(e, i); }} onTouchStart={(e) => e.stopPropagation()}><Icon n="more" s={18} /></button>}
    </div>
  );
});
