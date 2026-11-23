/** Genre guess by the sound — a port of src-tauri/src/dsp.rs (energy, brightness, BPM; no ML).
 *  Used on the phone for albums that have no genre tag and were not found on the internet. */
const RATE = 11025;

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

export function genreOf(mono: Float32Array, rate = RATE): string {
  if (mono.length < 2048) return '';
  let s2 = 0;
  for (let i = 0; i < mono.length; i++) s2 += mono[i] * mono[i];
  const rms = Math.max(1e-6, Math.sqrt(s2 / mono.length));
  const energy = Math.min(1, Math.max(0, (20 * Math.log10(rms) + 30) / 24));
  const n = 512, hop = 128;
  const win = new Float32Array(n).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const re = new Float32Array(n), im = new Float32Array(n), prev = new Float32Array(n / 2 + 1);
  const flux: number[] = [];
  let cenSum = 0, cenW = 0;
  for (let i = 0; i + n <= mono.length; i += hop) {
    for (let k = 0; k < n; k++) { re[k] = mono[i + k] * win[k]; im[k] = 0; }
    fft(re, im);
    let f = 0, num = 0, den = 0;
    for (let k = 0; k <= n / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      num += k * m; den += m;
      const d = m - prev[k];
      if (d > 0) f += d;
      prev[k] = m;
    }
    if (den > 0) { cenSum += num; cenW += den; }
    flux.push(f);
  }
  const centroid = cenW > 0 ? (cenSum / cenW) * rate / n : 1500;
  const bright = Math.min(1, Math.max(0, (centroid - 800) / 3200));
  const fps = rate / hop;
  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, flux.length);
  const env = flux.map((x) => Math.max(0, x - mean));
  const lo = Math.floor((fps * 60) / 180), hi = Math.floor(fps);
  let best = [0, 0];
  for (let lag = Math.max(1, lo); lag < Math.min(hi, env.length - 1); lag++) {
    let s = 0;
    for (let j = 0; j < env.length - lag; j++) s += env[j] * env[j + lag];
    const bpm = (60 * fps) / lag, w = 1 - Math.abs(bpm - 115) / 200;
    if (s * w > best[1]) best = [lag, s * w];
  }
  const bpm = best[0] > 0 ? (60 * fps) / best[0] : 100;
  if (energy < 0.35 && bright < 0.35) return 'Ambient';
  if (energy < 0.45 && bright < 0.55) return bpm < 100 ? 'Downtempo' : 'Chillout';
  if (energy < 0.5) return 'Acoustic';
  if (bpm > 160 && energy > 0.6) return 'Drum & Bass';
  if (bpm >= 118 && bpm <= 140 && energy > 0.6 && bright < 0.5) return 'Techno';
  if (bpm >= 115 && bpm <= 130 && energy > 0.55) return 'House';
  if (bright > 0.6 && energy > 0.7) return 'Rock';
  if (bpm < 100 && energy > 0.6) return 'Hip-Hop';
  return 'Electronic';
}

/** Decode a piece of the file (a ~1.5 MB slice of the middle for big MP3s, the whole file otherwise)
 *  at 11 kHz mono and guess the genre. '' if the file can't be decoded here. */
/** A piece of the file decoded at `rate`: a ~1.5 MB slice of the middle for big MP3/AAC, the whole file
 *  otherwise (up to 30 MB). null when the file is too big to decode here. */
async function decodePiece(url: string, size: number, codec: string, rate: number): Promise<AudioBuffer | null> {
  let buf: ArrayBuffer;
  if (/MP3|AAC/i.test(codec) && size > 4e6) {
    const from = Math.floor(size * 0.35);
    const r = await fetch(url, { headers: { Range: `bytes=${from}-${from + 1_500_000}` } });
    buf = await r.arrayBuffer();
    if (buf.byteLength > 12e6) buf = buf.slice(from, from + 1_500_000); // server ignored Range
  } else if (size <= 30e6) {
    buf = await (await fetch(url)).arrayBuffer();
  } else return null;
  const ctx = new OfflineAudioContext(1, rate, rate);
  return ctx.decodeAudioData(buf);
}

/** Decode a piece of the file at 11 kHz mono and guess the genre. '' if the file can't be decoded here. */
export async function soundGenre(url: string, size: number, codec: string): Promise<string> {
  const ab = await decodePiece(url, size, codec, RATE);
  if (!ab) return '';
  const ch = ab.numberOfChannels, len = ab.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / ch; }
  // three 8-second windows like the desktop (or the whole slice when it is short)
  const w = 8 * ab.sampleRate;
  if (len > 5 * w) {
    const parts = [0.3, 0.55, 0.8].map((p) => mono.subarray(Math.floor(len * p), Math.floor(len * p) + w));
    const out = new Float32Array(parts.length * w);
    parts.forEach((p, i) => out.set(p, i * w));
    return genreOf(out, ab.sampleRate);
  }
  return genreOf(mono.subarray(0, Math.min(len, 3 * w)), ab.sampleRate);
}

/* ---- loudness (EBU R128 / ITU BS.1770 style, integrated over the decoded piece) ---- */
type BQ = [number, number, number, number, number]; // b0 b1 b2 a1 a2 (a0 = 1)
function biquad(kind: 'hs' | 'hp', f0: number, q: number, gainDb: number, fs: number): BQ {
  const w = 2 * Math.PI * f0 / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
  if (kind === 'hp') {
    const a0 = 1 + al;
    return [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0];
  }
  const A = Math.pow(10, gainDb / 40), sA = 2 * Math.sqrt(A) * al;
  const a0 = (A + 1) - (A - 1) * cw + sA;
  return [A * ((A + 1) + (A - 1) * cw + sA) / a0, -2 * A * ((A - 1) + (A + 1) * cw) / a0, A * ((A + 1) + (A - 1) * cw - sA) / a0,
    2 * ((A - 1) - (A + 1) * cw) / a0, ((A + 1) - (A - 1) * cw - sA) / a0];
}
function filt(x: Float32Array, f: BQ) {
  const [b0, b1, b2, a1, a2] = f;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y;
  }
}
/** Integrated loudness of the file in LUFS (approximate: K-weighting, 400 ms blocks, absolute + relative gates).
 *  NaN if the file can't be decoded here. */
export async function loudnessOf(url: string, size: number, codec: string): Promise<number> {
  const fs = 16000; // enough for K-weighting (shelf at 1.7 kHz), keeps memory low
  const ab = await decodePiece(url, size, codec, fs);
  if (!ab || ab.length < fs) return NaN;
  const len = ab.length, ch = Math.min(2, ab.numberOfChannels);
  const shelf = biquad('hs', 1681.97, 0.7071, 4, fs), hp = biquad('hp', 38.14, 0.5003, 0, fs);
  // energy of 100 ms chunks summed over channels; a 400 ms block = 4 chunks (75 % overlap)
  const hop = Math.round(0.1 * fs), nc = Math.floor(len / hop);
  const ce = new Float64Array(nc);
  for (let c = 0; c < ch; c++) {
    const x = ab.getChannelData(c); // filtered in place — the buffer is thrown away afterwards
    filt(x, shelf); filt(x, hp);
    for (let k = 0; k < nc; k++) { let e = 0; for (let i = k * hop, j = i + hop; i < j; i++) e += x[i] * x[i]; ce[k] += e; }
  }
  const ms: number[] = [];
  for (let b = 0; b + 4 <= nc; b++) { const m = (ce[b] + ce[b + 1] + ce[b + 2] + ce[b + 3]) / (4 * hop); if (-0.691 + 10 * Math.log10(m + 1e-12) > -70) ms.push(m); }
  if (!ms.length) return NaN;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const rel = -0.691 + 10 * Math.log10(mean(ms)) - 10;
  const g = ms.filter((m) => -0.691 + 10 * Math.log10(m) > rel);
  return Math.round((-0.691 + 10 * Math.log10(mean(g.length ? g : ms))) * 10) / 10;
}
