/**
 * "3D" covers: one still frame of a 3D-visualizer scene, rendered with WebGL2 in the colours of the theme.
 * One small GL context is created lazily and reused for every cover (in the cover worker, on an OffscreenCanvas),
 * so a cover costs a single draw call. Without WebGL2 the cover falls back to the 2D artwork.
 */
import { FS, VS } from './shader';
import { SCENES } from './scenes';
import { setVizCoverRenderer } from '../cover/draw';
import type { CoverRecipe } from '../core/types';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type GL = WebGL2RenderingContext;
let ctx: { cv: AnyCanvas; gl: GL; u: Record<string, WebGLUniformLocation | null> } | null = null;
let broken = false;

function init() {
  if (ctx || broken) return ctx;
  try {
    const cv: AnyCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
    const gl = cv.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'low-power' }) as GL | null;
    if (!gl) throw new Error('no webgl2');
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS(110)));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const u: Record<string, WebGLUniformLocation | null> = {};
    for (const n of ['R', 'T', 'B', 'M', 'H', 'E', 'K', 'MIXV', 'SA', 'SB', 'SP', 'C1', 'C2', 'C3']) u[n] = gl.getUniformLocation(p, n);
    ctx = { cv, gl, u };
  } catch (e) {
    console.warn('3D covers unavailable', e);
    broken = true;
  }
  return ctx;
}

const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const lift = (c: number[], k: number) => c.map((x) => Math.min(1, x * k + 0.06));
function rnd(seed: number) { let x = seed % 2147483647; if (x <= 0) x += 2147483646; return () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; }

/** Scene of a cover: "viz:<n>" uses scene n, "viz" (random in the settings) picks one per album. */
export function sceneOf(r: CoverRecipe): number {
  const m = /^viz:(\d+)$/.exec(r.style ?? '');
  return m ? Math.min(SCENES.length - 1, +m[1]) : r.seed % SCENES.length;
}

setVizCoverRenderer((target, r, c) => {
  const x = init();
  if (!x) return false;
  const { cv, gl, u } = x;
  const W = target.width, H = target.height;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  gl.viewport(0, 0, W, H);
  const R = rnd(r.seed ^ 0x3d);
  const e = Math.max(0.2, Math.min(1, r.energy ?? 0.5));
  // a believable frozen spectrum: falling from the bass, a few peaks
  const sp = new Float32Array(24);
  for (let i = 0; i < 24; i++) sp[i] = Math.min(1, (0.75 - i * 0.022) * (0.55 + R() * 0.6) * (0.7 + e * 0.5));
  const light = c.light;
  gl.uniform2f(u.R, W, H);
  gl.uniform1f(u.T, 8 + R() * 60);
  gl.uniform1f(u.B, 0.25 + e * 0.45); gl.uniform1f(u.M, 0.3 + R() * 0.3); gl.uniform1f(u.H, 0.2 + R() * 0.3);
  gl.uniform1f(u.E, 0.35 + e * 0.4); gl.uniform1f(u.K, 0.25 + R() * 0.3); gl.uniform1f(u.MIXV, 0);
  const s = sceneOf(r);
  gl.uniform1i(u.SA, s); gl.uniform1i(u.SB, s);
  gl.uniform1fv(u.SP, sp);
  gl.uniform3fv(u.C1, lift(rgb(c.a1), light ? 0.85 : 1));
  gl.uniform3fv(u.C2, lift(rgb(c.a2), light ? 0.85 : 1));
  gl.uniform3fv(u.C3, lift(rgb(c.a3), 1.5));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const g = target.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  g.drawImage(cv as CanvasImageSource, 0, 0, W, H);
  if (light) {
    // light themes: the scene is printed on the theme's pastel paper instead of black space
    g.globalCompositeOperation = 'screen';
    g.fillStyle = c.bg0; g.globalAlpha = 0.55; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  }
  return true;
});
