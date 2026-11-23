import { useEffect, useRef, useState } from 'react';
import { api, isMobile, setFullscreen } from '../app/api';
import { Icon } from './icons';
import { getState, useStore } from '../app/store';
import { toggleViz } from '../app/actions';
import { Viz3D } from '../viz/viz3d';
import { prefs, setPrefs, vizQuality } from '../core/prefs';
import { usePrefsLite } from '../core/prefsHook';
import { t } from '../i18n';

/** Fullscreen 3D visualizer. Controls fade out after a moment of stillness; Esc / back / double-click closes. */
export function VizFull() {
  const on = useStore((s) => s.viz);
  return on ? <VizInner /> : null;
}

function VizInner() {
  const cv = useRef<HTMLCanvasElement>(null);
  const eng = useRef<Viz3D | null>(null);
  const playing = useStore((s) => s.player.playing);
  const track = useStore((s) => s.player.track);
  const theme = useStore((s) => s.settings.theme);
  const [ui, setUi] = useState(true);
  const [info, setInfo] = useState(true);
  const [scene, setScene] = useState('');
  const [err, setErr] = useState('');
  const hideT = useRef<number>();

  const poke = () => {
    setUi(true);
    clearTimeout(hideT.current);
    hideT.current = window.setTimeout(() => setUi(false), isMobile ? 3500 : 2200);
  };

  useEffect(() => {
    setFullscreen(true);
    document.documentElement.dataset.viz = '1';
    let e: Viz3D;
    try {
      e = new Viz3D(cv.current!, () => api.levels(), { quality: vizQuality(), mobile: isMobile, scene: prefs().vizScene, auto: !prefs().vizTap, gain: prefs().vizSens });
    } catch (x) { setErr(String((x as Error).message || x)); return () => { setFullscreen(false); delete document.documentElement.dataset.viz; }; }
    eng.current = e;
    e.playing = getState().player.playing;
    e.onScene = (n) => { setScene(t(n)); };
    setScene(t(e.scene));
    e.start();
    const vis = () => (document.hidden ? e.stop() : e.start());
    const key = (k: KeyboardEvent) => {
      if (k.code === 'Escape' || k.code === 'KeyV') { k.preventDefault(); k.stopPropagation(); toggleViz(false); }
      else if (k.code === 'KeyN' || k.code === 'Enter') { e.next(true); poke(); }
    };
    document.addEventListener('visibilitychange', vis);
    addEventListener('keydown', key, true);
    poke();
    return () => {
      document.removeEventListener('visibilitychange', vis);
      removeEventListener('keydown', key, true);
      clearTimeout(hideT.current);
      e.destroy();
      eng.current = null;
      delete document.documentElement.dataset.viz;
      setFullscreen(false);
    };
  }, []);

  useEffect(() => { if (eng.current) eng.current.playing = playing; }, [playing]);
  useEffect(() => { eng.current?.palette(); }, [theme]);
  const gain = usePrefsLite().vizSens;
  useEffect(() => { eng.current?.setGain(gain); }, [gain]);
  useEffect(() => {
    if (!track) return;
    eng.current?.shake();
    setInfo(true);
    const t = setTimeout(() => setInfo(false), 5000);
    return () => clearTimeout(t);
  }, [track?.id]);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  // "change scene on tap": a single tap / click switches the scene, a double one still closes
  const tapT = useRef<number>();
  const tap = () => {
    if (!prefs().vizTap) return;
    clearTimeout(tapT.current);
    tapT.current = window.setTimeout(() => { eng.current?.next(true); }, 240);
  };
  return (
    <div className={'vzf' + (ui ? ' ui' : '')} onPointerMove={isMobile ? undefined : poke} onPointerDown={isMobile ? poke : undefined}
      onClick={tap} onDoubleClick={() => { clearTimeout(tapT.current); toggleViz(false); }}>
      <canvas ref={cv} />
      {err && <div className="vz-err">{t('Визуализация недоступна: ')}{err}</div>}
      <div className={'vz-info' + (info || ui ? ' on' : '')}>
        <b>{track?.title ?? ''}</b>
        <span>{track?.artist ?? ''}</span>
      </div>
      <div className="vz-top" onPointerDown={stop} onDoubleClick={stop} onClick={stop}>
        <button className="vz-scene" title={t('Следующая сцена (N)')} onClick={() => { eng.current?.next(true); poke(); }}><Icon n="spark" s={14} />{scene}</button>
        <label className="vz-sens" title={t('Чувствительность визуализации')}><Icon n="spark" s={13} />
          <input type="range" min={0.5} max={2.5} step={0.1} value={gain} onChange={(e) => { setPrefs({ vizSens: +e.target.value }); poke(); }} />
        </label>
        <button className="vz-x" title={t('Закрыть (Esc)')} onClick={() => toggleViz(false)}><Icon n="x" s={18} /></button>
      </div>
      <div className="vz-ctl" onPointerDown={stop} onDoubleClick={stop} onClick={stop}>
        <button onClick={() => { api.prev(); poke(); }}><Icon n="prev" /></button>
        <button className="pp" onClick={() => { api.toggle(); poke(); }}><Icon n={playing ? 'pause' : 'play'} s={18} /></button>
        <button onClick={() => { api.next(); poke(); }}><Icon n="next" /></button>
      </div>
    </div>
  );
}
