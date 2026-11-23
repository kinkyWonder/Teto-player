import { useEffect, useState } from 'react';
import { ArtistLinks } from '../core/artists';
import { api } from '../app/api';
import { Icon } from './icons';
import { getState, livePos, navigate, setState, useStore } from '../app/store';
import { fmtTime, isHiRes } from '../core/util';
import { Cover, trackCover } from './Cover';
import { srcTitle } from '../core/teto';
import { Slider } from './Slider';
import { tetoCross, toggleFav, toggleViz } from '../app/actions';
import { t as tr } from '../i18n';

export function Progress() {
  const dur = useStore((s) => s.player.dur);
  const playing = useStore((s) => s.player.playing);
  const pos0 = useStore((s) => s.pos);
  const [pos, setPos] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  useEffect(() => {
    setPos(livePos(getState()));
    if (!playing) return;
    // a progress bar does not need 60 fps: 4 updates per second, none while the window is hidden
    const t = setInterval(() => { if (!document.hidden) setPos(livePos(getState())); }, 250);
    return () => clearInterval(t);
  }, [playing, pos0]);
  const shown = preview !== null ? preview * dur : pos;
  return (
    <div className="prog">
      <span className="mono">{fmtTime(shown)}</span>
      <Slider value={dur ? Math.min(1, shown / dur) : 0} onInput={setPreview}
        onCommit={(v) => { setPreview(null); const p = v * dur; setState({ pos: p, posAt: performance.now() }); api.seek(p); }} />
      <span className="mono">{fmtTime(dur)}</span>
    </div>
  );
}

export function PlayerBar() {
  const p = useStore((s) => s.player);
  const album = useStore((s) => s.currentAlbum);
  const panel = useStore((s) => s.panel);
  const showNp = useStore((s) => s.settings.show_np);
  const showLyrics = useStore((s) => s.showLyrics);
  const src = useStore((s) => s.src);
  const [vol, setVol] = useState<number | null>(null);
  const t = p.track;
  const v = vol ?? (p.muted ? 0 : p.volume);
  const hi = t ? isHiRes(t) : false;
  const nextRepeat = { off: 'all', all: 'one', one: 'off' } as const;
  const wheel = (e: React.WheelEvent) => { const nv = Math.max(0, Math.min(1, p.volume - Math.sign(e.deltaY) * 0.05)); api.setVolume(nv); };
  const lyricsOn = showNp && showLyrics;
  return (
    <div className={'bar' + (p.playing ? '' : ' paused')}>
      <div className="trk">
        {t ? <>
          <span onClick={() => navigate({ kind: 'album', id: t.album_id })}><Cover a={trackCover(t, album)} size={52} eager /></span>
          <div><b title={t.title}>{t.title}</b><span><ArtistLinks name={t.artist} /></span>{srcTitle(src) && <em className={'bsrc' + (src === 'teto' ? ' teto' : '')}>{srcTitle(src)}</em>}</div>
          <button className={'fav' + (t.fav ? ' on' : '')} title={t.fav ? tr('Убрать из любимого') : tr('В любимое')} onClick={() => toggleFav(t)}><Icon n={t.fav ? 'heartf' : 'heart'} s={17} /></button>
        </> : <div className="muted" style={{ fontSize: 12 }}>{p.error ?? ''}</div>}
      </div>
      <div className="ctr">
        <div className="btns">
          {src === 'teto' && t && <button className="cross" title={tr('Больше не играть в режиме Teto')} onClick={() => tetoCross(t)}><Icon n="x" /></button>}
          <button className={p.shuffle ? 'on' : ''} title={tr('Перемешать')} onClick={() => api.setShuffle(!p.shuffle)}><Icon n="shuffle" /></button>
          <button title={tr('Предыдущий (Ctrl+←)')} onClick={() => api.prev()}><Icon n="prev" /></button>
          <button className="pp" title={tr('Пауза / воспроизведение (Space)')} onClick={() => api.toggle()}><Icon n={p.playing ? 'pause' : 'play'} s={16} /></button>
          <button title={tr('Следующий (Ctrl+→)')} onClick={() => api.next()}><Icon n="next" /></button>
          <button className={p.repeat !== 'off' ? 'on' : ''} title={tr('Повтор')} onClick={() => api.setRepeat(nextRepeat[p.repeat])}><Icon n={p.repeat === 'one' ? 'repeat1' : 'repeat'} /></button>
        </div>
        <Progress />
      </div>
      <div className="rt">
        {p.output && t?.lossless && <span className={'chip mono' + (hi ? '' : ' dim')}>{p.output}</span>}
        <button title={tr('3D-визуализация (V)')} disabled={!t} onClick={() => toggleViz(true)}><Icon n="orbit" /></button>
        <button className={lyricsOn ? 'on' : ''} title={tr('Текст (Ctrl+L)')} onClick={() => toggleLyrics()}><Icon n="lyrics" /></button>
        <button className={panel === 'queue' ? 'on' : ''} title={tr('Очередь')} onClick={() => setState({ panel: panel === 'queue' ? 'none' : 'queue' })}><Icon n="queue" /></button>
        <button title={tr('Без звука')} onClick={() => api.setMuted(!p.muted)}><Icon n={p.muted || p.volume === 0 ? 'mute' : 'vol'} /></button>
        <Slider className="vol" value={v} onWheel={wheel} onInput={(x) => { setVol(x); api.setVolume(x); }} onCommit={(x) => { setVol(null); api.setVolume(x); if (p.muted) api.setMuted(false); }} />
      </div>
    </div>
  );
}

export function toggleLyrics() {
  const s = getState();
  if (!s.settings.show_np) {
    api.setSettings({ show_np: true }).then((st) => setState({ settings: st, showLyrics: true }));
  } else setState({ showLyrics: !s.showLyrics });
}
