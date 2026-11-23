/**
 * Teto 3D visualizer: a single full-screen WebGL2 fragment shader with five scenes (nebula, black hole,
 * neon tunnel, crystal, pulsar)
 * that slowly morph into each other. Audio features (bass / mid / high / energy / beat + 24-band
 * spectrum) drive geometry, colour and the speed of time itself.
 *
 * Battery: renders at a reduced internal resolution (upscaled by the compositor), adapts the
 * resolution to keep the frame budget, caps fps (30 in eco mode, 20 while paused) and stops
 * completely when the page is hidden.
 */

import { SCENES } from './scenes';
export { SCENES };

import { FS, VS } from './shader';

export interface VizOpts {
  quality: 'eco' | 'normal' | 'high'; mobile: boolean;
  /** first scene (-1 / undefined = random) */
  scene?: number;
  /** change scenes by themselves every ~minute (false = only on tap / next()) */
  auto?: boolean;
  /** how strongly the picture reacts to the music, 1 … 1.5 */
  gain?: number;
}
export type LevelsFn = () => Promise<number[] | null> | number[] | null;

function cssRgb(name: string, fb: [number, number, number]): [number, number, number] {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const p = v.split(',').map((x) => +x / 255);
  return p.length === 3 && p.every((x) => isFinite(x)) ? (p as [number, number, number]) : fb;
}
const lift = (c: number[], k: number) => c.map((x) => Math.min(1, x * k + 0.08)) as [number, number, number];

export class Viz3D {
  private gl: WebGL2RenderingContext;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private raf = 0;
  private running = false;
  private scale: number;
  private last = 0;
  private time = Math.random() * 100;
  private spec = new Float32Array(24);
  private target = new Float32Array(24);
  private peak = 0.5; // slow auto-level of the input (see poll)
  private f = { b: 0, m: 0, h: 0, e: 0, k: 0, bAvg: 0.2 };
  private pollAt = 0;
  private inflight = false;
  private sceneA = Math.floor(Math.random() * SCENES.length);
  private sceneB = 0;
  private mix = 0;
  private sceneAt = 0;
  private sceneLen = 45;
  private fade = 5; // crossfade seconds
  playing = true;
  onScene?: (name: string) => void;

  constructor(private cv: HTMLCanvasElement, private levels: LevelsFn, private opts: VizOpts) {
    const gl = cv.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: opts.quality === 'high' ? 'high-performance' : 'low-power', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 недоступен');
    this.gl = gl;
    this.scale = opts.quality === 'eco' ? 0.4 : opts.quality === 'high' ? 0.85 : 0.6;
    if (opts.mobile) this.scale *= 0.75;
    this.build();
    if (opts.scene !== undefined && opts.scene >= 0 && opts.scene < SCENES.length) this.sceneA = opts.scene;
    this.sceneB = (this.sceneA + 1) % SCENES.length;
  }

  get scene() { return SCENES[this.mix > 0.5 ? this.sceneB : this.sceneA]; }

  private build() {
    const gl = this.gl;
    const steps = this.opts.quality === 'eco' || this.opts.mobile ? 56 : this.opts.quality === 'high' ? 96 : 72;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS(steps)));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['R', 'T', 'B', 'M', 'H', 'E', 'K', 'MIXV', 'SA', 'SB', 'SP', 'C1', 'C2', 'C3']) this.u[n] = gl.getUniformLocation(p, n);
    this.palette();
  }

  /** How strongly the picture reacts to the music (1 … 1.5), applied live. */
  setGain(g: number) { this.opts.gain = g; }

  /** Re-read theme colours (call after a theme switch). */
  palette() {
    const gl = this.gl;
    const a = cssRgb('--acc', [0.37, 0.95, 0.82]), b = cssRgb('--acc2', [0.34, 0.84, 0.94]), c = cssRgb('--acc3', [0.1, 0.43, 0.45]);
    const light = cssRgb('--bg-rgb', [0, 0, 0]).reduce((s, x) => s + x, 0) > 1.5;
    gl.uniform3fv(this.u.C1, lift(a, light ? 0.8 : 1));
    gl.uniform3fv(this.u.C2, lift(b, light ? 0.8 : 1));
    gl.uniform3fv(this.u.C3, lift(c, 1.9));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.sceneAt = this.time;
    this.raf = requestAnimationFrame(this.tick);
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf); }
  destroy() { this.stop(); this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }

  /** Jump to the next scene with a crossfade. */
  next(fast = false) { if (this.mix === 0) { this.sceneB = (this.sceneA + 1) % SCENES.length; this.fade = fast ? 1.4 : 5; this.mix = 0.0001; } }
  /** Switch to a random other scene (e.g. on a new track). */
  shake() { if (this.mix === 0 && this.opts.auto !== false) { let n = this.sceneA; while (n === this.sceneA) n = Math.floor(Math.random() * SCENES.length); this.sceneB = n; this.fade = 5; this.mix = 0.0001; } }

  private poll(now: number) {
    if (this.inflight || now - this.pollAt < 33) return;
    this.pollAt = now;
    const r = this.levels();
    const g = Math.max(0.5, Math.min(2.5, this.opts.gain ?? 1.4));
    // sensitivity: louder input and a steeper curve, so quiet passages move too and peaks hit harder;
    // plus a slow auto-level: quiet tracks / quiet masters are lifted towards the same liveliness
    const apply = (l: number[] | null) => {
      if (!l || !l.length) { this.target.fill(0); return; }
      let pk = 0;
      for (const v of l) if (v > pk) pk = v;
      this.peak = pk > this.peak ? this.peak + (pk - this.peak) * 0.3 : this.peak * 0.997;
      const lift = Math.min(2.2, 0.75 / Math.max(0.2, this.peak)); // ≈1 for loud material
      const amp = 0.55 + 0.45 * g, curve = 0.6 + 0.4 * g;
      for (let i = 0; i < 24; i++) {
        const v = (l[Math.floor((i * l.length) / 24)] ?? 0) * Math.max(1, lift);
        this.target[i] = Math.min(1, Math.pow(Math.min(1, v), 1 / curve) * amp);
      }
    };
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      this.inflight = true;
      (r as Promise<number[] | null>).then(apply, () => {}).finally(() => { this.inflight = false; });
    } else apply(r as number[] | null);
  }

  private tick = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    if (document.hidden) return;
    const fps = !this.playing ? 20 : this.opts.quality === 'eco' ? 30 : this.opts.mobile ? 40 : 60;
    const dtMs = now - this.last;
    if (dtMs < 1000 / fps - 2) return;
    this.last = now;
    const dt = Math.min(0.1, dtMs / 1000);
    this.poll(now);

    // smoothing: fast attack, slow release
    const s = this.spec, tg = this.target;
    for (let i = 0; i < 24; i++) s[i] += (tg[i] - s[i]) * (tg[i] > s[i] ? 0.65 : 0.14);
    const avg = (a: number, b: number) => { let x = 0; for (let i = a; i < b; i++) x += s[i]; return x / (b - a); };
    const f = this.f;
    const bass = avg(0, 4), mid = avg(4, 13), high = avg(13, 24);
    f.b += (bass - f.b) * 0.35; f.m += (mid - f.m) * 0.2; f.h += (high - f.h) * 0.2;
    f.e += ((bass + mid + high) / 3 - f.e) * 0.05;
    f.bAvg += (bass - f.bAvg) * 0.02;
    const gk = Math.max(0.5, Math.min(2.5, this.opts.gain ?? 1.4));
    if (bass > f.bAvg * (1.42 - gk * 0.12) + 0.04 && bass - f.b > -0.02 && f.k < 0.3) f.k = 1;
    f.k *= Math.exp(-dt * 5);

    // time runs faster when the music is intense, crawls when paused
    this.time += dt * (this.playing ? 0.45 + (f.e * 1.3 + f.k * 0.5) * (0.4 + 0.5 * gk) : 0.12);

    // scene schedule
    if (this.opts.auto !== false && this.mix === 0 && this.time - this.sceneAt > this.sceneLen) this.next();
    if (this.mix > 0) {
      this.mix = Math.min(1, this.mix + dt / this.fade);
      if (this.mix >= 1) {
        this.sceneA = this.sceneB; this.mix = 0; this.sceneAt = this.time;
        this.sceneLen = 35 + Math.random() * 30;
        this.onScene?.(SCENES[this.sceneA]);
      }
    }

    // adaptive resolution to stay inside the frame budget
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(64, Math.round(this.cv.clientWidth * dpr * this.scale));
    const Hh = Math.max(64, Math.round(this.cv.clientHeight * dpr * this.scale));
    if (this.cv.width !== W || this.cv.height !== Hh) { this.cv.width = W; this.cv.height = Hh; }
    gl.viewport(0, 0, W, Hh);
    const u = this.u;
    gl.uniform2f(u.R, W, Hh);
    gl.uniform1f(u.T, this.time);
    gl.uniform1f(u.B, f.b); gl.uniform1f(u.M, f.m); gl.uniform1f(u.H, f.h); gl.uniform1f(u.E, f.e); gl.uniform1f(u.K, f.k);
    gl.uniform1f(u.MIXV, this.mix > 0 ? this.mix * this.mix * (3 - 2 * this.mix) : 0);
    gl.uniform1i(u.SA, this.sceneA); gl.uniform1i(u.SB, this.sceneB);
    gl.uniform1fv(u.SP, s);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.adapt(dtMs);
  };

  private slowFrames = 0;
  private fastFrames = 0;
  private adapt(dtMs: number) {
    const fps = this.opts.quality === 'eco' ? 30 : this.opts.mobile ? 40 : 60;
    const budget = 1000 / fps;
    if (dtMs > budget * 1.6) this.slowFrames++; else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (dtMs < budget * 1.1) this.fastFrames++; else this.fastFrames = 0;
    const max = (this.opts.quality === 'high' ? 1 : this.opts.quality === 'eco' ? 0.5 : 0.75) * (this.opts.mobile ? 0.75 : 1);
    if (this.slowFrames > 20 && this.scale > 0.25) { this.scale *= 0.85; this.slowFrames = 0; }
    else if (this.fastFrames > 240 && this.scale < max) { this.scale = Math.min(max, this.scale * 1.08); this.fastFrames = 0; }
  }
}
