import { useEffect, useRef } from 'react';
import { api } from '../app/api';
import { getState, useStore } from '../app/store';
import { Cover } from './Cover';

/** Slowly drifting aura made from the current cover, behind the main content (GPU: transform + opacity only). */
export function Ambient() {
  const album = useStore((s) => s.currentAlbum);
  const rov = useStore((s) => (album ? s.rov[album.id] : undefined));
  const on = useStore((s) => s.settings.glow);
  if (!on || !album) return null;
  const a = rov !== undefined ? { ...album, recipe: rov } : album;
  return (
    <div className="ambient" aria-hidden>
      <Cover key={`${a.id}:${JSON.stringify(a.recipe)}`} a={a} size={64} eager className="amb fadein" />
    </div>
  );
}

/**
 * Real-time spectrum of what is audible (computed natively in the audio engine, ~30 fps).
 * Polling stops automatically when paused, hidden or disabled; bass drives the cover glow (--beat).
 */
export function Visualizer({ className = 'viz', bars = 24 }: { className?: string; bars?: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const playing = useStore((s) => s.player.playing);
  const on = useStore((s) => s.settings.visualizer);
  const anim = useStore((s) => s.settings.anim);
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const c = cv.current;
    if (!c || !on || anim === 'off') return;
    const g = c.getContext('2d')!;
    const vals = new Float32Array(bars);
    let target: number[] = [];
    let raf = 0, last = 0, inflight = false, idleFrames = 0;
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const acc = `rgb(${css.getPropertyValue('--acc').trim() || '95,242,208'})`;
    const acc2 = `rgb(${css.getPropertyValue('--acc2').trim() || '86,214,240'})`;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 33) return; // ~30 fps
      last = t;
      if (getState().viz) return; // the fullscreen visualizer covers everything
      if (playing && !inflight && !document.hidden) {
        inflight = true;
        api.levels().then((l) => { target = l; }).catch(() => {}).finally(() => { inflight = false; });
      }
      let energy = 0;
      for (let i = 0; i < bars; i++) {
        const v = playing ? target[i] ?? 0 : 0;
        // fast attack, slow release
        vals[i] = v > vals[i] ? vals[i] + (v - vals[i]) * 0.6 : vals[i] * 0.86 + v * 0.14;
        energy += vals[i];
      }
      const bass = (vals[0] + vals[1] + vals[2]) / 3;
      root.style.setProperty('--beat', bass.toFixed(3));
      if (!playing && energy < 0.01) {
        if (++idleFrames > 3) { g.clearRect(0, 0, c.width, c.height); cancelAnimationFrame(raf); root.style.setProperty('--beat', '0'); return; }
      } else idleFrames = 0;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      g.clearRect(0, 0, W, H);
      const grad = g.createLinearGradient(0, H, W, 0);
      grad.addColorStop(0, acc);
      grad.addColorStop(1, acc2);
      g.fillStyle = grad;
      const gap = 3 * dpr, bw = (W - gap * (bars - 1)) / bars;
      for (let i = 0; i < bars; i++) {
        const h = Math.max(2 * dpr, Math.pow(vals[i], 1.6) * H);
        const x = i * (bw + gap);
        g.globalAlpha = 0.35 + vals[i] * 0.6;
        g.beginPath();
        g.roundRect(x, H - h, bw, h, [bw / 2, bw / 2, 0, 0]);
        g.fill();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); root.style.setProperty('--beat', '0'); };
  }, [playing, on, anim, bars, theme]);
  if (!on || anim === 'off') return null;
  return <canvas ref={cv} className={className} aria-hidden />;
}
