import { Icon } from '../icons';
import { useContext, useEffect, useRef, useState } from 'react';
import { getState, navigate, openMenu, setState, toast, useStore } from '../../app/store';
import { playMix, playTag, playTeto, playTracks, togglePlay } from '../../app/actions';
import { type Genre } from '../../core/mix';
import { t } from '../../i18n';
import { addCustomGenre, removeCustomGenre, setTagOrder } from '../../core/extras';
import { Logo } from '../Logo';
import { tagLabel } from '../../core/tags';
import { isMobile } from '../../app/api';
import { ScrollCtx, TrackTable } from '../TrackTable';
import { nTracks, nArtists } from './common';
import { useGenres, genreStyle } from './Home';

const UNTAGGED = '\u0000untagged';
export function newGenreDialog() {
  setState({ dialog: { title: t('Новый тэг'), text: t('Поставить его песням: «⋯» → «Редактировать» → «Тэги…»'), ok: t('Создать'), input: '', onOk: () => {
    const n = (getState().dialog?.input ?? '').trim();
    if (n) { const g = addCustomGenre(n); toast(t('Тэг «{0}» создан', g)); }
  } } });
}
const genreMenu = (x: Genre) => [
  ...(x.tracks.length ? [{ label: t('Слушать микс'), onClick: () => playMix(x.tracks, undefined, 'tag:' + x.key) }] : []),
  { label: t('Показать треки'), onClick: () => navigate({ kind: 'genre', name: x.key === '_' ? UNTAGGED : x.name }) },
  ...(x.custom ? [{ sep: true, label: '' }, { label: t('Удалить тэг'), danger: true, onClick: () => removeCustomGenre(x.name) }] : []),
];

export function GenresView() {
  const g = useGenres();
  const src = useStore((s) => s.src);
  const playing = useStore((s) => s.player.playing && !!s.player.track);
  const grid = useRef<HTMLDivElement>(null);
  const scroller = useContext(ScrollCtx);
  const [order, setOrder] = useState<string[] | null>(null); // local order while dragging
  const [drag, setDrag] = useState<{ key: string; x: number; y: number; dx: number; dy: number; w: number; h: number } | null>(null);
  const press = useRef<{ key: string; x: number; y: number; t: number; timer: number; el: HTMLElement; started: boolean; moved: boolean; pid: number } | null>(null);
  const swallow = useRef(false); // the click that ends a drag / long press must not start a mix
  const gRef = useRef(g);
  gRef.current = g;

  /* ---- drag to reorder: long press (touch) or press-and-move (mouse) ---- */
  const begin = (p: NonNullable<typeof press.current>, cx: number, cy: number) => {
    const r = p.el.getBoundingClientRect();
    p.started = true;
    try { navigator.vibrate?.(10); } catch { /* not allowed */ }
    setOrder((gRef.current?.list ?? []).map((x) => x.key));
    setDrag({ key: p.key, x: cx, y: cy, dx: cx - r.left, dy: cy - r.top, w: r.width, h: r.height });
  };
  const onDown = (e: React.PointerEvent, x: Genre) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const el = e.currentTarget as HTMLElement;
    const p = { key: x.key, x: e.clientX, y: e.clientY, t: performance.now(), timer: 0, el, started: false, moved: false, pid: e.pointerId };
    if (e.pointerType !== 'mouse') p.timer = window.setTimeout(() => { if (press.current === p && !p.moved) begin(p, p.x, p.y); }, 380);
    press.current = p;
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pid) return;
      const far = Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8;
      if (!p.started) {
        if (!far) return;
        if (e.pointerType === 'mouse') begin(p, e.clientX, e.clientY);
        else { p.moved = true; clearTimeout(p.timer); press.current = null; return; } // it is a scroll
      }
      setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
      const hit = document.elementsFromPoint(e.clientX, e.clientY).find((n) => (n as HTMLElement).dataset?.k && n.closest('.ggrid') === grid.current) as HTMLElement | undefined;
      const k = hit?.dataset.k;
      if (k && k !== p.key) setOrder((o) => { if (!o) return o; const a = o.filter((y) => y !== p.key); a.splice(a.indexOf(k) + (o.indexOf(k) > o.indexOf(p.key) ? 1 : 0), 0, p.key); return a; });
      // auto-scroll near the edges
      const sc = scroller?.current;
      if (sc) { const r = sc.getBoundingClientRect(); if (e.clientY < r.top + 60) sc.scrollBy(0, -12); else if (e.clientY > r.bottom - 60) sc.scrollBy(0, 12); }
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pid) return;
      clearTimeout(p.timer);
      press.current = null;
      if (p.started) {
        swallow.current = true;
        setTimeout(() => { swallow.current = false; }, 80);
        setOrder((o) => { if (o) setTagOrder(o); return null; });
        setDrag(null);
      }
    };
    const touch = (e: TouchEvent) => { if (press.current?.started) e.preventDefault(); }; // no scrolling while dragging
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
    document.addEventListener('touchmove', touch, { passive: false });
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); document.removeEventListener('touchmove', touch); };
  }, []);

  if (!g) return null;
  const byKey = new Map(g.list.map((x) => [x.key, x]));
  const list = order ? order.map((k) => byKey.get(k)!).filter(Boolean) : g.list;
  const tap = (x: Genre) => {
    if (swallow.current) return;
    if (x.tracks.length) playTag(x.key, x.tracks); else navigate({ kind: 'genre', name: x.name });
  };
  const body = (x: Genre) => {
    const on = src === 'tag:' + x.key;
    return <>
      <b>{tagLabel(x.name)}</b>
      <span>{x.tracks.length ? (isMobile ? nTracks(x.tracks.length) : `${nTracks(x.tracks.length)} · ${nArtists(x.artists)}`) : t('Свой тэг · пока пусто')}</span>
      <button className="gl" title={t('Показать треки')} onClick={(e) => { e.stopPropagation(); navigate({ kind: 'genre', name: x.key === '_' ? UNTAGGED : x.name }); }}><Icon n="queue" s={15} /></button>
      {x.tracks.length > 0 && <i className={'gp' + (on ? ' on' : '')}><Icon n={on && playing ? 'pause' : 'play'} s={15} /></i>}
    </>;
  };
  const tile = (x: Genre, draggable = true) => (
    <div key={x.key} data-k={draggable ? x.key : undefined} className={'gtile' + (x.tracks.length ? '' : ' empty') + (src === 'tag:' + x.key ? ' now' : '') + (drag?.key === x.key ? ' ghost' : '')}
      style={genreStyle(x.name)}
      onPointerDown={draggable ? (e) => onDown(e, x) : undefined}
      onClick={() => tap(x)}
      onContextMenu={(e) => { e.preventDefault(); if (!press.current?.started && !drag) openMenu(e, genreMenu(x)); }}>
      {body(x)}
    </div>
  );
  const dragged = drag ? byKey.get(drag.key) : null;
  return (
    <>
      <div className="ptitle">{t('Тэги')}</div>
      <div className={'ggrid' + (drag ? ' dragging' : '')} ref={grid}>
        <div className={'gtile mix teto' + (src === 'teto' ? ' now' : '')} onClick={() => (src === 'teto' && getState().player.track ? togglePlay() : playTeto(g.all))}>
          <b><Logo s={15} />Teto</b>
          <i className={'gp' + (src === 'teto' ? ' on' : '')}><Icon n={src === 'teto' && playing ? 'pause' : 'play'} s={15} /></i>
        </div>
        {list.map((x) => tile(x))}
        {g.untagged.length > 0 && tile({ key: '_', name: t('Без тэгов'), tracks: g.untagged, artists: new Set(g.untagged.map((x) => x.artist)).size }, false)}
        <div className="gtile add" onClick={newGenreDialog}><b><Icon n="plus" s={18} />{t('Новый тэг')}</b><span>{t('Свой тэг для любых песен')}</span></div>
      </div>
      {dragged && drag && (
        <div className="gtile gdrag" style={{ ...genreStyle(dragged.name), width: drag.w, height: drag.h, transform: `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px) scale(1.05)` }}>{body(dragged)}</div>
      )}
      <div className="note" style={{ marginTop: 18 }}><Icon n="info" s={14} />{isMobile ? t('Удерживайте тэг и перетащите, чтобы поменять порядок.') : t('Перетащите тэг мышью, чтобы поменять порядок.')} {t('Изменить тэги песни: «⋯» у трека → «Редактировать» → «Тэги…».')}</div>
    </>
  );
}

export function GenreView({ name }: { name: string }) {
  const g = useGenres();
  if (!g) return null;
  const x = name === UNTAGGED || name === 'Без тэгов' ? { key: '_', name: t('Без тэгов'), tracks: g.untagged, artists: 0 } as Genre
    : g.list.find((y) => y.name.toLowerCase() === name.toLowerCase());
  if (!x) return <div className="muted">{t('Тэг не найден')}</div>;
  return (
    <>
      <div className="k" style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--t3)' }}>{t('Тэг')}</div>
      <div className="ptitle">{tagLabel(x.name)}</div>
      <div className="psub">{nTracks(x.tracks.length)}</div>
      <div className="acts" style={{ marginTop: 0 }}>
        {x.tracks.length > 0 && <>
          <button className="play" onClick={() => playMix(x.tracks, undefined, 'tag:' + x.key)}><Icon n="mix" s={15} />{t('Микс')}</button>
          <button className="ib" title={t('По порядку')} onClick={() => playTracks(x.tracks, 0)}><Icon n="play" s={15} /></button>
        </>}
        {x.custom && <button className="ib" title={t('Ещё')} onClick={(e) => openMenu(e, genreMenu(x))}><Icon n="more" s={16} /></button>}
      </div>
      {x.tracks.length ? <TrackTable tracks={x.tracks} showAlbum numbered="index" />
        : <div className="muted" style={{ marginTop: 24 }}>{t('Поставьте этот тэг песням: «⋯» у трека → «Редактировать» → «Тэги…»')}</div>}
    </>
  );
}

/* ---------- catalog: playlists as albums, then artists and all tracks ---------- */
