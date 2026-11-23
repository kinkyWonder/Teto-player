// Main-thread side of cover generation: a small worker pool, a priority queue (newest request first,
// cancelled when the cover scrolls away), an LRU of object URLs and a persistent on-disk cache (Cache API).
//
// Battery: on phones and on battery the pool is a single worker, renders are capped at 300 px without grain,
// and jobs start only when the main thread is idle. Charging lifts the cap to 600 px. Only covers that are
// actually on screen are ever requested (see components/Cover.tsx) — there is no background pass over the library.
import type { CoverRecipe } from '../core/types';
import { drawCover, recipeKey, type CoverText } from './draw';
import '../viz/still'; // "3D" covers (used only when no worker is available)
import { isMobile } from '../app/platform';
import { isCharging, prefs } from '../core/prefs';

type Job = { id: number; r: CoverRecipe; size: number; type: 'jpeg' | 'png'; noGrain: boolean; text?: CoverText; res: (b: Blob) => void; rej: (e: unknown) => void; signal?: AbortSignal };
const queue: Job[] = [];
const running = new Map<number, Job>();
let seq = 0;
let workers: Worker[] | null = null;
const busy = new Set<Worker>();
let noWorkers = false;

function pool(): Worker[] | null {
  if (workers || noWorkers) return workers;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') { noWorkers = true; return null; }
  const n = isMobile ? 1 : Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) >> 2));
  workers = Array.from({ length: n }, () => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
      busy.delete(w);
      const j = running.get(e.data.id);
      running.delete(e.data.id);
      if (j) { if (e.data.blob) j.res(e.data.blob); else j.rej(e.data.error); }
      pump();
    };
    return w;
  });
  return workers;
}

const idle = (f: () => void) => {
  const ric = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(f, { timeout: 400 }); else setTimeout(f, 30);
};
const lowPower = () => isMobile || !isCharging();

let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  const go = () => {
    pumping = false;
    const ws = pool();
    while (queue.length) {
      // drop requests nobody waits for any more (scrolled off screen)
      const j = queue.pop()!; // LIFO: what was asked for last is what is on screen now
      if (j.signal?.aborted) { j.rej('aborted'); continue; }
      if (ws) {
        const w = ws.find((x) => !busy.has(x));
        if (!w) { queue.push(j); break; }
        busy.add(w);
        running.set(j.id, j);
        w.postMessage({ id: j.id, recipe: j.r, size: j.size, type: j.type, noGrain: j.noGrain, text: j.text });
      } else {
        // no OffscreenCanvas: plain canvas, one job per idle slot so scrolling stays smooth
        const cv = document.createElement('canvas');
        cv.width = cv.height = j.size;
        try { drawCover(cv, j.r, j.noGrain, j.text); } catch (e) { j.rej(e); }
        cv.toBlob((b) => (b ? j.res(b) : j.rej('toBlob')), j.type === 'png' ? 'image/png' : 'image/jpeg', 0.88);
        if (queue.length) pump();
        break;
      }
    }
  };
  if (lowPower()) idle(go); else queueMicrotask(go);
}

function render(r: CoverRecipe, size: number, type: 'jpeg' | 'png', noGrain: boolean, text?: CoverText, signal?: AbortSignal): Promise<Blob> {
  return new Promise<Blob>((res, rej) => {
    queue.push({ id: ++seq, r, size, type, noGrain, text, res, rej, signal });
    pump();
  });
}

let fast = false;
/** "fast" quality: max 300 px, no grain. */
export function setCoverQuality(q: string) { fast = q === 'fast'; }
// phones on battery: 450 px; charging phones and desktops: 800 px; "fast": 300 px
const capOf = () => (fast ? 300 : lowPower() && !(isMobile && isCharging()) ? 450 : 800);

/** A recipe in the colours of the current theme and in the chosen style ("3D" = the chosen visualizer scene). */
export function themedRecipe(r: CoverRecipe, theme: string, style: 'classic' | 'viz' = 'classic'): CoverRecipe {
  const scene = prefs().vizScene;
  return { ...r, palette: 'theme:' + theme, style: style === 'viz' ? (scene >= 0 ? 'viz:' + scene : 'viz') : undefined };
}

const urls = new Map<string, string>();
interface Inflight { p: Promise<string>; ac: AbortController; n: number }
const inflight = new Map<string, Inflight>();
const MAX = isMobile ? 160 : 400;

const sizeOf = (size: number) => Math.min(size, capOf());
const textKey = (t?: CoverText) => (t ? `|${t.title}|${t.artist}` : '');
const keyOf = (r: CoverRecipe, size: number, t?: CoverText) => {
  const s = sizeOf(size);
  return `${recipeKey(r)}:${s}:${fast || s <= 300 ? 'f' : 'h'}${textKey(t)}`;
};

/* ---- persistent cache: generated covers survive restarts, so they are drawn once per device ---- */
const CACHE = 'teto-covers-v4';
let cacheP: Promise<Cache | null> | null = null;
const disk = () => (cacheP ??= (typeof caches !== 'undefined' ? caches.open(CACHE).then((c) => { prune(c); return c; }).catch(() => null) : Promise.resolve(null)));
const diskUrl = (k: string) => `/__gen/${encodeURIComponent(k)}.jpg`;
async function prune(c: Cache) {
  try {
    const keys = await c.keys();
    const LIMIT = isMobile ? 1500 : 4000;
    if (keys.length > LIMIT) for (const k of keys.slice(0, keys.length - LIMIT)) await c.delete(k);
  } catch { /* ignore */ }
}

/** Revoke later: a picture that is still on screen (or crossfading) must not turn blank. */
const revokeLater = (u: string) => setTimeout(() => URL.revokeObjectURL(u), 20000);
function remember(k: string, url: string) {
  urls.set(k, url);
  if (urls.size > MAX) {
    const old = urls.keys().next().value!;
    revokeLater(urls.get(old)!);
    urls.delete(old);
  }
}

/** Drop every generated cover (memory + disk); they are drawn again on demand. */
export async function clearGenCovers() {
  for (const u of urls.values()) revokeLater(u);
  urls.clear();
  cacheP = null;
  try { if (typeof caches !== 'undefined') await caches.delete(CACHE); } catch { /* ignore */ }
}

/**
 * Called on start and on theme / style changes. Covers are drawn on demand in the current theme anyway; when the
 * theme changed since the last run, the old pictures are dropped from the disk cache, so the cache holds one
 * consistent set and does not grow. Nothing is redrawn in advance (no extra load): visible covers are drawn once,
 * then served from the cache on every next start.
 */
export function syncCoverLook(theme: string, style: string) {
  const key = `${theme}|${style}|${prefs().vizScene}|g182`; // g182: "flow lines" removed → re-render saved covers once
  let old: string | null = null;
  try { old = localStorage.getItem('teto.coverLook'); localStorage.setItem('teto.coverLook', key); } catch { /* private mode */ }
  if (old && old !== key) clearGenCovers();
  // the previous generator's cache is not needed any more
  try { if (typeof caches !== 'undefined') caches.delete('teto-covers-v2').catch(() => {}); } catch { /* ignore */ }
}

export function coverCached(r: CoverRecipe, size: number, text?: CoverText): string | undefined {
  const k = keyOf(r, size, text);
  const u = urls.get(k);
  if (u) { urls.delete(k); urls.set(k, u); }
  return u;
}

export function coverImage(r: CoverRecipe, size: number, text?: CoverText, signal?: AbortSignal): Promise<string> {
  const k = keyOf(r, size, text);
  const u = urls.get(k);
  if (u) return Promise.resolve(u);
  let e = inflight.get(k);
  if (!e || e.ac.signal.aborted) {
    // one render per picture, shared by every cover that shows it; it is cancelled only when all of them are gone
    const s = sizeOf(size);
    const ac = new AbortController();
    const entry: Inflight = { ac, n: 0, p: Promise.resolve('') };
    entry.p = (async () => {
      const c = await disk();
      const hit = c ? await c.match(diskUrl(k)).catch(() => undefined) : undefined;
      let blob: Blob;
      if (hit) blob = await hit.blob();
      else {
        blob = await render(r, s, 'jpeg', fast || s <= 300, text, ac.signal);
        c?.put(diskUrl(k), new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } })).catch(() => {});
      }
      const url = URL.createObjectURL(blob);
      remember(k, url);
      return url;
    })().finally(() => { if (inflight.get(k) === entry) inflight.delete(k); });
    inflight.set(k, entry);
    e = entry;
  }
  const entry = e;
  if (!signal) entry.n = Infinity; // a caller that cannot cancel keeps the render alive
  else if (!signal.aborted) {
    entry.n++;
    signal.addEventListener('abort', () => { if (--entry.n <= 0) entry.ac.abort(); }, { once: true });
  }
  return entry.p;
}

export async function coverPng(r: CoverRecipe, size = 600, text?: CoverText): Promise<number[]> {
  const b = await render(r, size, 'png', false, text);
  return Array.from(new Uint8Array(await b.arrayBuffer()));
}
