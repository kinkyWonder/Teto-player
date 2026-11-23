/**
 * Generated covers, v4: rich abstract artwork (the "old" generator, rebuilt and extended).
 *  - nine compositions: aura, waves, horizon, stripes, topography, bauhaus tiles, orbits, spectrum ring, glass
 *    shapes (the scribbly "flow lines" was removed in 1.8.2 as too abstract; old recipes with it draw waves) — picked by genre / energy, neighbours do not repeat;
 *  - always in the colours of the current theme (each album shifts the accents a little, so a shelf of covers in
 *    one theme is not monotone), soft light, vignette and a whisper of grain;
 *  - optional "3D" style: a still frame of the chosen 3D-visualizer scene (rendered with WebGL, see viz/still.ts).
 * Fully deterministic for a recipe. Recipes stored by older versions still render (their motif picks a composition).
 */
import type { CoverRecipe } from '../core/types';
import { PALETTES, paletteFor } from './palettes';
import THEMES from '../styles/themes.json';

export const MOTIFS = 10; // compositions (see drawCover)

/* ---------------- symbols ---------------- */
export const SYMBOLS = ['moon', 'sun', 'heart', 'wave', 'flame', 'star', 'drop', 'city', 'road', 'planet', 'snow', 'flower', 'mountain', 'clock', 'cloud', 'bolt', 'house', 'eye', 'key', 'crown', 'bird', 'tree', 'spiral', 'arch', 'orbs', 'tri', 'rings'] as const;
export type Sym = (typeof SYMBOLS)[number];
const GEO: Sym[] = ['arch', 'orbs', 'tri', 'rings'];

// title keywords (stems, ru + en) -> symbol
const WORDS: [RegExp, Sym][] = [
  [/(^|[^\p{L}])(ноч|луна|лун[аые]|moon|night|midnight|полноч|dark|тьм|темн|сон(?!\p{L})|sleep|lullab|колыбел)/iu, 'moon'],
  [/(солн|sun|summer|лет[оа](?!\p{L})|жар|heat|day(?!\p{L})|днем|день|утр|morning|sunrise|sunset|закат|рассвет|gold)/iu, 'sun'],
  [/(любо|люблю|love|heart|сердц|поцел|kiss|valentin|нежн|baby|darling|милы|милая)/iu, 'heart'],
  [/(море|морск|sea(?!\p{L})|ocean|океан|волн|wave|surf|beach|пляж|берег|river|река|water|вода|tide|flow)/iu, 'wave'],
  [/(огон|огн|пожар|fire|flame|burn|гор[июя]|пламя|hell|ад(?!\p{L})|blaze|ignit|hot(?!\p{L}))/iu, 'flame'],
  [/(звезд|звёзд|star|galax|галакт|cosmo|космос|universe|вселен|astro)/iu, 'star'],
  [/(дожд|rain|слез|слёз|tear|cry|плач|storm|гроз|шторм|осень|autumn|fall(?!\p{L})|blue(?!\p{L})|груст|sad|melanchol)/iu, 'drop'],
  [/(город|city|street|улиц|урбан|urban|metro|метро|downtown|neon|неон|район|block|москв|питер|moscow|tokyo|london|paris|york)/iu, 'city'],
  [/(дорог|road|путь|way(?!\p{L})|drive|трасс|highway|route|travel|путешеств|ride|езд|поезд|train|run(?!\p{L})|бег)/iu, 'road'],
  [/(планет|planet|space|орбит|orbit|марс|mars|venus|сатурн|saturn|jupiter|луноход|ракет|rocket|apollo|nasa)/iu, 'planet'],
  [/(зим|снег|снеж|winter|snow|frost|мороз|лед(?!\p{L})|лёд|ice(?!\p{L})|cold|холод|december|декабр|январ|christmas|новый год)/iu, 'snow'],
  [/(цвет[оы]|цветок|flower|bloom|роз[аы]|rose|весн|spring|сад(?!\p{L})|garden|lotus|лотос|сакур|sakura|petal|blossom)/iu, 'flower'],
  [/(гор[аы](?!\p{L})|горн|mountain|peak|вершин|alps|альп|everest|summit|high(?!\p{L})|высот|холм|hill)/iu, 'mountain'],
  [/(врем|time|час[ыа]?(?!\p{L})|clock|минут|minute|forever|навсегда|вечн|past|прошл|future|будущ|year|год(?!\p{L})|memor|памят|ностальг|nostalg)/iu, 'clock'],
  [/(облак|cloud|небо|sky|heaven|рай(?!\p{L})|air(?!\p{L})|воздух|ветер|wind|dream|мечт|грез|грёз|float|fly|лет[аи]м|полет|полёт)/iu, 'cloud'],
  [/(электр|electr|energy|энерг|power|сила|thunder|молни|shock|volt|amp|rage|ярост|riot|бунт|fight|драк|war(?!\p{L})|войн)/iu, 'bolt'],
  [/(дом(?!\p{L})|дома|домой|home|house|room|комнат|кварт|family|семь|родн|back to)/iu, 'house'],
  [/(глаз|eye|взгляд|look|see(?!\p{L})|vision|видени|смотр|mirror|зеркал|lens|watch)/iu, 'eye'],
  [/(ключ|key(?!\p{L})|keys|door|двер|secret|тайн|lock|замок|open|открой)/iu, 'key'],
  [/(корол|king|queen|crown|корон|царь|цар[иь]ц|prince|принц|boss|босс|money|деньг|cash|rich|богат|empire|импер|throne|трон|gang|банд)/iu, 'crown'],
  [/(птиц|bird|wing|крыл|freedom|свобод|free(?!\p{L})|ворон|crow|raven|чайк|swallow|ласточк|голуб|dove|eagle|орел|орёл)/iu, 'bird'],
  [/(лес(?!\p{L})|леса|forest|tree|дерев|wood|роща|park(?!\p{L})|парк|nature|природ|green|зелен|leaf|лист)/iu, 'tree'],
  [/(спирал|spiral|hypno|гипно|loop|петл|circle|круг|vortex|вихр|maze|лабиринт|psych|trip|кайф|mind|разум)/iu, 'spiral'],
];
const GENRE_SYMS: Record<string, Sym[]> = {
  rock: ['bolt', 'flame', 'road'], punk: ['bolt', 'flame'], metal: ['flame', 'bolt', 'mountain'], alternative: ['bolt', 'eye', 'road'],
  electronic: ['wave', 'planet', 'spiral'], techno: ['rings', 'spiral', 'wave'], house: ['sun', 'wave', 'orbs'], trance: ['spiral', 'planet', 'star'],
  dnb: ['bolt', 'wave'], dubstep: ['bolt', 'rings'], synthwave: ['sun', 'road', 'city'], idm: ['spiral', 'rings'], experimental: ['eye', 'spiral'],
  hiphop: ['crown', 'city'], rap: ['crown', 'city', 'bolt'], rnb: ['heart', 'moon'], soul: ['heart', 'sun'], funk: ['sun', 'orbs'],
  jazz: ['moon', 'city', 'spiral'], blues: ['drop', 'moon', 'road'], classical: ['spiral', 'arch', 'star'], soundtrack: ['eye', 'mountain', 'star'],
  pop: ['heart', 'star', 'sun'], indie: ['flower', 'cloud', 'bird'], postrock: ['mountain', 'cloud'], shoegaze: ['cloud', 'flower'],
  folk: ['tree', 'mountain', 'bird'], acoustic: ['tree', 'house', 'sun'], country: ['road', 'sun', 'house'], reggae: ['sun', 'tree'],
  latin: ['sun', 'flower', 'flame'], world: ['sun', 'tree', 'mountain'], ambient: ['planet', 'moon', 'cloud', 'wave'], downtempo: ['moon', 'wave'],
  chillout: ['wave', 'cloud', 'sun'], lofi: ['moon', 'house', 'cloud'], newage: ['planet', 'flower', 'star'], vocal: ['heart', 'star'],
};

// compositions that suit a genre (neighbouring albums rotate through them): 0 aura, 1 waves, 2 horizon,
// 3 stripes, 4 topography, 5 bauhaus, 6 orbits, 7 flow lines, 8 spectrum ring, 9 glass
const ALL_MOTIFS = [0, 1, 2, 3, 4, 5, 6, 8, 9];
const DROPPED = 7; // flow lines: too abstract
/** Composition actually drawn for a stored motif (dropped ones fall back to waves). */
const compOf = (m: number) => { const c = ((m % MOTIFS) + MOTIFS) % MOTIFS; return c === DROPPED ? 1 : c; };
const GENRE_MOTIFS: Record<string, number[]> = {
  ambient: [0, 4, 1], downtempo: [0, 1, 4], chillout: [1, 0, 9, 2], lofi: [2, 9, 0, 4], newage: [0, 4, 6],
  electronic: [8, 3, 6], techno: [3, 8, 5], house: [8, 9, 3, 0], trance: [6, 8, 0], dnb: [3, 8], dubstep: [8, 3],
  synthwave: [2, 8, 3], idm: [5, 4, 8], experimental: [5, 4, 9], classical: [4, 0, 6, 1], soundtrack: [2, 4, 6, 0],
  jazz: [5, 9, 1, 0], blues: [1, 2, 9], soul: [9, 0, 1], rnb: [9, 0, 6, 1], funk: [5, 3, 9], hiphop: [5, 3, 9, 8], rap: [3, 5, 8, 9],
  pop: [9, 0, 5, 1], indie: [2, 9, 5, 1], rock: [3, 2, 5, 8], alternative: [3, 2, 5], punk: [3, 5, 8], metal: [3, 8],
  postrock: [2, 4, 1], shoegaze: [0, 1, 9], folk: [2, 4, 1], acoustic: [2, 1, 4], country: [2, 1, 5], reggae: [5, 2, 1],
  latin: [5, 9, 2], world: [5, 4, 2], vocal: [9, 0, 1],
};

/** Symbols that suit an album, best first (title keywords, then genre, then geometry). */
export function symbolsFor(title: string, genre: string): Sym[] {
  const out: Sym[] = [];
  for (const [re, s] of WORDS) if (re.test(title || '') && !out.includes(s)) out.push(s);
  for (const s of GENRE_SYMS[paletteFor(genre)] ?? []) if (!out.includes(s)) out.push(s);
  return out;
}

function rnd(seed: number) {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
}
export function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return (a[0] % 2147483646) + 1;
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 2147483646) + 1;
}

/** Deterministic default recipe for an album that has no cover yet. */
export function defaultRecipe(key: string, genre: string, id?: number, title?: string): CoverRecipe {
  const seed = hash(key);
  const palette = paletteFor(genre);
  const opts = symbolsFor(title ?? key.split('|').slice(1).join('|'), genre);
  const sym: Sym = opts.length ? opts[0] : GEO[(seed + Math.abs(id ?? 0)) % GEO.length];
  const R = rnd(seed ^ 0x5bd1e995);
  const pool = GENRE_MOTIFS[palette] ?? ALL_MOTIFS;
  const motif = pool[(Math.abs(id ?? 0) + (seed % 3)) % pool.length];
  return { seed, motif, palette, sym, energy: +(0.3 + R() * 0.5).toFixed(2), bpm: Math.round(80 + R() * 60), bright: +(0.4 + R() * 0.2).toFixed(2), valence: +(0.35 + R() * 0.3).toFixed(2) };
}

/** Kept for the browser preview mock. */
export function legacyMotif(seed: number): number { return seed % MOTIFS; }

/** "Another variant": a different symbol or composition, still meaningful for the album. */
export function newRecipe(prev: CoverRecipe | null, base: Partial<CoverRecipe> & { title?: string; genre?: string }): CoverRecipe {
  const pal = base.palette ?? prev?.palette ?? 'default';
  const good = symbolsFor(base.title ?? '', base.genre ?? pal);
  const pool: Sym[] = [...good, ...GEO].filter((s, i, a) => a.indexOf(s) === i);
  let sym: Sym;
  if (!prev?.sym) sym = pool[0] ?? GEO[0];
  else {
    // mostly stay with a fitting symbol (new composition / colours), sometimes switch to another one
    const others = pool.filter((s) => s !== prev.sym);
    sym = Math.random() < 0.55 && good.includes(prev.sym as Sym) ? (prev.sym as Sym) : others[Math.floor(Math.random() * others.length)] ?? (prev.sym as Sym);
  }
  const choices = ALL_MOTIFS.filter((m) => !prev || m !== compOf(prev.motif));
  const motif = choices[Math.floor(Math.random() * choices.length)];
  return {
    seed: randomSeed(), motif, palette: pal, sym,
    energy: base.energy ?? prev?.energy ?? 0.5, bpm: base.bpm ?? prev?.bpm ?? 100,
    bright: base.bright ?? prev?.bright ?? 0.5, valence: base.valence ?? prev?.valence ?? 0.5,
  };
}

export const recipeKey = (r: CoverRecipe) => `v4:${r.seed}:${r.motif}:${r.palette}:${r.style ?? ''}:${r.energy}:${r.bright}`;

/* ---------------- colours ---------------- */
type RGB = [number, number, number];
const hex2 = (h: string): RGB => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgb2hex = ([r, g, b]: RGB) => '#' + ((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1);
const mixC = (a: string, b: string, t: number) => { const x = hex2(a), y = hex2(b); return rgb2hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]); };
const lum = (h: string) => { const [r, g, b] = hex2(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
function hueShift(h: string, deg: number): string {
  let [r, g, b] = hex2(h).map((x) => x / 255) as RGB;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 0.02) return h; // greys stay grey
  const s = d / (1 - Math.abs(2 * l - 1));
  let hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hh = (hh * 60 + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = l - c / 2;
  [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return rgb2hex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}
const rgba = (h: string, a: number) => { const [r, g, b] = hex2(h); return `rgba(${r},${g},${b},${a})`; };

type ThemeDef = { bg: string; s1: string; s2: string; acc: string; acc2: string; t1: string; light?: boolean };
const THEME_DEFS = THEMES as Record<string, ThemeDef>;

/** Cover colours: background pair, three accents, ink; light themes get airy pastel covers. */
interface Scheme { bg0: string; bg1: string; a1: string; a2: string; a3: string; ink: string; light: boolean }
export function schemeOf(palette: string, R: () => number): Scheme {
  const th = palette.startsWith('theme:') ? THEME_DEFS[palette.slice(6)] ?? THEME_DEFS.tide : null;
  let bg: string, s1: string, a1: string, a2: string, ink: string;
  if (th) { bg = th.bg; s1 = th.s1; a1 = th.acc; a2 = th.acc2; ink = th.t1; }
  else { const p = PALETTES[palette] ?? PALETTES.default; bg = p[0]; s1 = p[1]; a1 = p[2]; a2 = p[3]; ink = '#f2fbf9'; }
  const light = lum(bg) > 0.6;
  // monochrome themes (AMOLED / Nothing): keep them monochrome, with a cold silver second tone
  const mono = lum(a1) > 0.95 || a2.toLowerCase() === '#ffffff';
  const shift = (R() - 0.5) * (mono ? 0 : 46);
  a1 = hueShift(a1, shift); a2 = hueShift(a2, -shift * 0.7);
  const a3 = mono ? mixC(a1, bg, 0.55) : hueShift(mixC(a1, a2, 0.5), 25 + shift);
  const deep = light ? mixC(bg, a1, 0.18) : mixC(bg, a1, 0.1);
  const v = R();
  if (v < 0.5) return { bg0: light ? bg : mixC(bg, '#000000', 0.2), bg1: deep, a1, a2, a3, ink, light };
  if (v < 0.75) return { bg0: light ? mixC(bg, a2, 0.25) : mixC(s1, a1, 0.12), bg1: light ? mixC(bg, a1, 0.3) : mixC(bg, a2, 0.18), a1, a2, a3, ink, light };
  return { bg0: light ? mixC(a1, '#ffffff', 0.55) : mixC(a1, bg, 0.72), bg1: light ? mixC(a2, '#ffffff', 0.45) : mixC(a2, bg, 0.82), a1, a2, a3, ink, light };
}

/* ---------------- drawing ---------------- */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const TAU = Math.PI * 2;

let grainTile: AnyCanvas | null = null;
function grain(): AnyCanvas {
  if (grainTile) return grainTile;
  const N = 256;
  const c: AnyCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : Object.assign(document.createElement('canvas'), { width: N, height: N });
  const g = c.getContext('2d') as Ctx;
  const img = g.createImageData(N, N), d = img.data, R = rnd(918273);
  for (let i = 0; i < N * N; i++) if (R() < 1 / 12) { const p = i << 2; d[p] = d[p + 1] = d[p + 2] = R() < 0.5 ? 255 : 0; d[p + 3] = Math.round(R() * 0.07 * 255); }
  g.putImageData(img, 0, 0);
  grainTile = c;
  return c;
}

/** Seeded 2D value noise (smooth, 0..1). */
function noise2(seed: number) {
  const R = rnd(seed), P = new Float32Array(512);
  for (let i = 0; i < 512; i++) P[i] = R();
  const h = (x: number, y: number) => P[((x * 73856093) ^ (y * 19349663)) & 511];
  const sm = (t: number) => t * t * (3 - 2 * t);
  const n = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  return (x: number, y: number) => (n(x, y) * 0.6 + n(x * 2.1 + 17, y * 2.1 - 9) * 0.3 + n(x * 4.3 - 31, y * 4.3 + 5) * 0.1);
}

export interface CoverText { title: string; artist: string }

/** Optional renderer of "3D" covers, installed by viz/still.ts (kept apart so 2D covers do not pull WebGL in). */
let vizDraw: ((cv: AnyCanvas, r: CoverRecipe, s: Scheme) => boolean) | null = null;
export function setVizCoverRenderer(f: typeof vizDraw) { vizDraw = f; }

export function drawCover(cv: AnyCanvas, r: CoverRecipe, noGrain = false, text?: CoverText) {
  const g = cv.getContext('2d') as Ctx;
  const W = cv.width, H = cv.height, S = Math.min(W, H), R = rnd(r.seed);
  const c = schemeOf(r.palette, R);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.lineCap = 'round'; g.lineJoin = 'round';
  let done = false;
  if (r.style?.startsWith('viz') && vizDraw) {
    try { done = vizDraw(cv, r, c); } catch { done = false; }
  }
  if (!done) {
    // background: diagonal gradient + a soft light from one corner
    const ang = R() * TAU;
    const bg = g.createLinearGradient(W / 2 - Math.cos(ang) * W * 0.75, H / 2 - Math.sin(ang) * H * 0.75, W / 2 + Math.cos(ang) * W * 0.75, H / 2 + Math.sin(ang) * H * 0.75);
    bg.addColorStop(0, c.bg0); bg.addColorStop(1, c.bg1);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const comp = compOf(r.motif);
    const e = Math.max(0, Math.min(1, r.energy ?? 0.5));
    COMPS[comp](g, W, H, S, c, R, e, r);
    // light + vignette
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    const lx = R() < 0.5 ? 0 : W, ly = R() * H * 0.4;
    const lg = g.createRadialGradient(lx, ly, 0, lx, ly, S * 1.1);
    lg.addColorStop(0, c.light ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.07)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg; g.fillRect(0, 0, W, H);
  }
  const vg = g.createRadialGradient(W / 2, H / 2, S * 0.38, W / 2, H / 2, S * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, c.light ? 'rgba(120,20,70,.10)' : 'rgba(0,0,0,.38)');
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  if (text && W >= 160 && text.title.trim()) drawTitle(g, W, H, text, c);
  if (!noGrain) {
    const pat = g.createPattern(grain() as CanvasImageSource, 'repeat');
    if (pat) { const ox = r.seed % 256, oy = (r.seed >> 8) % 256; g.save(); g.translate(-ox, -oy); g.fillStyle = pat; g.fillRect(ox, oy, W, H); g.restore(); }
  }
}

type Comp = (g: Ctx, W: number, H: number, S: number, c: Scheme, R: () => number, e: number, r: CoverRecipe) => void;
const glowDot = (g: Ctx, x: number, y: number, rr: number, col: string, a = 1) => {
  const gr = g.createRadialGradient(x, y, 0, x, y, rr);
  gr.addColorStop(0, rgba(col, a)); gr.addColorStop(0.35, rgba(col, a * 0.45)); gr.addColorStop(1, rgba(col, 0));
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
};
const pick = <T,>(R: () => number, a: T[]) => a[Math.floor(R() * a.length)];

const COMPS: Comp[] = [
  /* 0 aura: soft colour blobs (mesh gradient), a fine ring and a bright core */
  (g, W, H, S, c, R, e) => {
    g.globalCompositeOperation = c.light ? 'source-over' : 'screen';
    const cols = [c.a1, c.a2, c.a3, c.a1];
    for (let i = 0; i < 5; i++) glowDot(g, W * (0.15 + R() * 0.7), H * (0.15 + R() * 0.7), S * (0.45 + R() * 0.35), cols[i % 4], c.light ? 0.55 : 0.5 + e * 0.2);
    g.globalCompositeOperation = 'source-over';
    const cx = W * (0.35 + R() * 0.3), cy = H * (0.35 + R() * 0.3), rr = S * (0.2 + R() * 0.12);
    g.strokeStyle = rgba(c.light ? '#ffffff' : c.ink, 0.55); g.lineWidth = S / 300;
    g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.stroke();
    g.globalAlpha = 0.35; g.beginPath(); g.arc(cx, cy, rr * 1.35, 0, TAU); g.stroke(); g.globalAlpha = 1;
    glowDot(g, cx, cy, rr * 0.55, '#ffffff', c.light ? 0.65 : 0.45);
  },
  /* 1 waves: stacked flowing ribbons under a calm sky */
  (g, W, H, S, c, R, e) => {
    const n = 6 + Math.floor(e * 4), base = H * (0.38 + R() * 0.12), amp = S * (0.04 + e * 0.05), f = 1 + R() * 1.5, ph = R() * TAU;
    glowDot(g, W * (0.25 + R() * 0.5), base - S * 0.12, S * 0.22, c.a2, 0.55);
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1), y0 = base + t * (H - base) * 0.95;
      const gr = g.createLinearGradient(0, y0 - amp, W, y0 + amp);
      gr.addColorStop(0, mixC(c.a1, c.bg1, t * 0.7)); gr.addColorStop(1, mixC(c.a2, c.bg0, t * 0.6));
      g.fillStyle = gr; g.globalAlpha = 0.55 + 0.45 * t;
      g.beginPath(); g.moveTo(0, H);
      for (let i = 0; i <= 48; i++) { const x = (i / 48) * W; g.lineTo(x, y0 + Math.sin((i / 48) * TAU * f + ph + k * 0.9) * amp * (1 - t * 0.4) + Math.sin((i / 48) * TAU * f * 2.3 + k) * amp * 0.25); }
      g.lineTo(W, H); g.closePath(); g.fill();
      g.globalAlpha = 0.5; g.strokeStyle = rgba('#ffffff', c.light ? 0.6 : 0.18); g.lineWidth = S / 400; g.stroke();
    }
    g.globalAlpha = 1;
  },
  /* 2 horizon: a striped sun sinking behind layered hills, stars above */
  (g, W, H, S, c, R) => {
    const hy = H * (0.6 + R() * 0.1);
    g.fillStyle = rgba(c.ink, c.light ? 0.5 : 0.7);
    for (let i = 0; i < 40; i++) { const x = R() * W, y = R() * hy * 0.8; g.globalAlpha = R() * 0.6; g.fillRect(x, y, S / 380, S / 380); }
    g.globalAlpha = 1;
    const sx = W * (0.3 + R() * 0.4), sr = S * (0.2 + R() * 0.08);
    glowDot(g, sx, hy - sr * 0.4, sr * 2.4, c.a1, 0.35);
    g.save(); g.beginPath(); g.arc(sx, hy - sr * 0.4, sr, 0, TAU); g.clip();
    const sg = g.createLinearGradient(0, hy - sr * 1.4, 0, hy + sr * 0.6); sg.addColorStop(0, c.a2); sg.addColorStop(1, c.a1);
    g.fillStyle = sg; g.fillRect(sx - sr, hy - sr * 1.5, sr * 2, sr * 2.2);
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 6; i++) { const y = hy - sr * 0.4 + i * sr * 0.17, h = sr * (0.02 + i * 0.018); g.fillRect(sx - sr, y, sr * 2, h); }
    g.restore();
    for (let k = 0; k < 3; k++) {
      const t = k / 2, y0 = hy + k * S * 0.07, amp = S * (0.08 - k * 0.02), ph = R() * TAU;
      g.fillStyle = mixC(c.a3, c.bg0, 0.35 + t * 0.5);
      g.beginPath(); g.moveTo(0, H);
      for (let i = 0; i <= 40; i++) { const x = (i / 40) * W; g.lineTo(x, y0 - Math.abs(Math.sin((i / 40) * Math.PI * (1.4 + k) + ph)) * amp); }
      g.lineTo(W, H); g.closePath(); g.fill();
    }
  },
  /* 3 stripes: bold diagonal bands, a circle that inverts them */
  (g, W, H, S, c, R, e) => {
    const n = 7 + Math.floor(e * 6), a = (R() < 0.5 ? -1 : 1) * (0.5 + R() * 0.35);
    const cols = [c.a1, c.a2, c.a3, mixC(c.bg0, c.ink, 0.1)];
    const band = (inv: boolean) => {
      g.save(); g.translate(W / 2, H / 2); g.rotate(a);
      const w = (S * 1.6) / n;
      for (let i = 0; i < n; i++) { g.fillStyle = inv ? cols[(i + 1) % cols.length] : (i % 2 ? cols[i % cols.length] : 'rgba(0,0,0,0)'); g.fillRect(-S + i * w, -S, w * (i % 2 ? 1 : 0.55), S * 2); }
      g.restore();
    };
    g.globalAlpha = 0.85; band(false); g.globalAlpha = 1;
    const cx = W * (0.35 + R() * 0.3), cy = H * (0.35 + R() * 0.3), rr = S * (0.22 + R() * 0.1);
    g.save(); g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.clip();
    g.fillStyle = c.bg1; g.fillRect(0, 0, W, H);
    g.translate(cx, cy); g.rotate(-2 * a); g.translate(-cx, -cy); band(true);
    g.restore();
    g.strokeStyle = rgba(c.ink, 0.35); g.lineWidth = S / 260; g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.stroke();
  },
  /* 4 topography: contour lines of a noise landscape */
  (g, W, H, S, c, R, e, r) => {
    const nz = noise2(r.seed ^ 0x2f), N = 64, sc = 2.2 + R() * 1.4;
    const levels = 10 + Math.floor(e * 8);
    // sample field
    const f = new Float32Array((N + 1) * (N + 1));
    for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) f[y * (N + 1) + x] = nz((x / N) * sc, (y / N) * sc);
    const cw = W / N, ch = H / N;
    for (let l = 0; l < levels; l++) {
      const iso = 0.12 + (l / levels) * 0.76;
      const t = l / levels;
      g.strokeStyle = mixC(c.a1, c.a2, t); g.globalAlpha = 0.35 + 0.55 * (l % 4 === 0 ? 1 : 0.5); g.lineWidth = S / (l % 4 === 0 ? 220 : 420);
      g.beginPath();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const v0 = f[y * (N + 1) + x], v1 = f[y * (N + 1) + x + 1], v2 = f[(y + 1) * (N + 1) + x + 1], v3 = f[(y + 1) * (N + 1) + x];
        const idx = (v0 > iso ? 8 : 0) | (v1 > iso ? 4 : 0) | (v2 > iso ? 2 : 0) | (v3 > iso ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const lerp = (a: number, b: number) => (iso - a) / (b - a || 1e-6);
        const T = [x + lerp(v0, v1), y], Rr = [x + 1, y + lerp(v1, v2)], B = [x + lerp(v3, v2), y + 1], L = [x, y + lerp(v0, v3)];
        const seg = (p: number[], q: number[]) => { g.moveTo(p[0] * cw, p[1] * ch); g.lineTo(q[0] * cw, q[1] * ch); };
        switch (idx) {
          case 1: case 14: seg(L, B); break; case 2: case 13: seg(B, Rr); break; case 3: case 12: seg(L, Rr); break;
          case 4: case 11: seg(T, Rr); break; case 6: case 9: seg(T, B); break; case 7: case 8: seg(L, T); break;
          case 5: seg(L, T); seg(B, Rr); break; case 10: seg(T, Rr); seg(L, B); break;
        }
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    // a marker on the highest peak
    let bi = 0; for (let i = 0; i < f.length; i++) if (f[i] > f[bi]) bi = i;
    const px = (bi % (N + 1)) * cw, py = Math.floor(bi / (N + 1)) * ch;
    glowDot(g, px, py, S * 0.08, c.a2, 0.8);
    g.fillStyle = c.ink; g.beginPath(); g.arc(px, py, S / 110, 0, TAU); g.fill();
  },
  /* 5 bauhaus tiles: quarter circles, halves, dots and triangles on a grid */
  (g, W, H, S, c, R) => {
    const n = pick(R, [3, 4, 4, 5]), w = W / n, h = H / n;
    const cols = [c.a1, c.a2, c.a3, mixC(c.bg0, c.ink, c.light ? 0.06 : 0.12), c.bg1];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const X = x * w, Y = y * h, k = Math.floor(R() * 6), bgc = pick(R, cols), fg = pick(R, cols.filter((q) => q !== bgc));
      g.fillStyle = bgc; g.fillRect(X, Y, w + 1, h + 1);
      g.fillStyle = fg;
      g.beginPath();
      const rot = Math.floor(R() * 4);
      const corner = [[X, Y], [X + w, Y], [X + w, Y + h], [X, Y + h]][rot];
      if (k === 0) { g.moveTo(corner[0], corner[1]); g.arc(corner[0], corner[1], w, rot * Math.PI / 2, rot * Math.PI / 2 + Math.PI / 2); }
      else if (k === 1) g.arc(X + w / 2, Y + h / 2, w * 0.36, 0, TAU);
      else if (k === 2) { const a0 = rot * Math.PI / 2; g.arc(X + w / 2, Y + h / 2, w / 2, a0, a0 + Math.PI); }
      else if (k === 3) { g.moveTo(X, Y + h); g.lineTo(X + w, Y + h); g.lineTo(rot % 2 ? X : X + w, Y); }
      else if (k === 4) { g.rect(X + w * 0.2, Y + h * 0.2, w * 0.6, h * 0.6); }
      else { g.arc(X + w / 2, Y + h / 2, w * 0.42, 0, TAU); g.arc(X + w / 2, Y + h / 2, w * 0.2, 0, TAU, true); }
      g.fill();
    }
  },
  /* 6 orbits: tilted orbits, glowing planets, a star field */
  (g, W, H, S, c, R, e) => {
    g.fillStyle = c.ink;
    for (let i = 0; i < 70; i++) { g.globalAlpha = R() * 0.7; const s = R() < 0.1 ? S / 220 : S / 500; g.fillRect(R() * W, R() * H, s, s); }
    g.globalAlpha = 1;
    const cx = W * (0.4 + R() * 0.2), cy = H * (0.42 + R() * 0.16), tilt = (R() - 0.5) * 0.9, k = 0.32 + R() * 0.25;
    glowDot(g, cx, cy, S * 0.38, c.a1, 0.55);
    const sun = g.createRadialGradient(cx - S * 0.03, cy - S * 0.03, 0, cx, cy, S * 0.1);
    sun.addColorStop(0, '#ffffff'); sun.addColorStop(0.4, c.a2); sun.addColorStop(1, c.a1);
    g.fillStyle = sun; g.beginPath(); g.arc(cx, cy, S * 0.09, 0, TAU); g.fill();
    const n = 4 + Math.floor(e * 3);
    for (let i = 1; i <= n; i++) {
      const rx = S * (0.13 + i * 0.075), ry = rx * k;
      g.save(); g.translate(cx, cy); g.rotate(tilt);
      g.strokeStyle = rgba(c.ink, 0.12 + 0.2 * (i % 2)); g.lineWidth = S / 500 * (i % 3 === 0 ? 2 : 1);
      g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, TAU); g.stroke();
      const a = R() * TAU, px = Math.cos(a) * rx, py = Math.sin(a) * ry, pr = S * (0.008 + R() * 0.02);
      const col = pick(R, [c.a1, c.a2, c.a3]);
      glowDot(g, px, py, pr * 4, col, 0.5);
      g.fillStyle = col; g.beginPath(); g.arc(px, py, pr, 0, TAU); g.fill();
      g.restore();
    }
  },
  /* 7 flow lines: thousands of short strokes following a smooth vector field */
  (g, W, H, S, c, R, e, r) => {
    const nz = noise2(r.seed ^ 0x7a1), sc = 1.6 + R() * 1.6, n = 260 + Math.floor(e * 260), steps = 34;
    g.lineWidth = S / 450;
    for (let i = 0; i < n; i++) {
      let x = R() * W, y = R() * H;
      const t = R();
      g.strokeStyle = t < 0.45 ? c.a1 : t < 0.85 ? c.a2 : c.ink;
      g.globalAlpha = 0.18 + R() * 0.5;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < steps; k++) {
        const a = nz((x / W) * sc, (y / H) * sc) * TAU * 2;
        x += Math.cos(a) * S * 0.008; y += Math.sin(a) * S * 0.008;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    glowDot(g, W * (0.3 + R() * 0.4), H * (0.3 + R() * 0.4), S * 0.25, c.a2, 0.35);
  },
  /* 8 spectrum ring: radial bars like a frozen frame of sound */
  (g, W, H, S, c, R, e, r) => {
    const cx = W / 2, cy = H / 2, r0 = S * (0.17 + R() * 0.05), n = 72 + Math.floor(e * 48);
    const nz = noise2(r.seed ^ 0x51);
    glowDot(g, cx, cy, S * 0.5, c.a1, 0.4);
    const disc = g.createRadialGradient(cx, cy, 0, cx, cy, r0);
    disc.addColorStop(0, mixC(c.a2, '#ffffff', 0.25)); disc.addColorStop(1, c.a1);
    g.fillStyle = disc; g.beginPath(); g.arc(cx, cy, r0 * 0.82, 0, TAU); g.fill();
    g.lineWidth = Math.max(1, (TAU * r0) / n * 0.55);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU - Math.PI / 2, v = Math.pow(nz(Math.cos(a) * 1.3 + 3, Math.sin(a) * 1.3 + 3), 1.6);
      const len = S * (0.03 + v * (0.22 + e * 0.12));
      g.strokeStyle = mixC(c.a1, c.a2, v); g.globalAlpha = 0.6 + v * 0.4;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); g.stroke();
    }
    g.globalAlpha = 1;
    g.strokeStyle = rgba(c.ink, 0.3); g.lineWidth = S / 400;
    g.beginPath(); g.arc(cx, cy, r0 * 0.6, 0, TAU); g.stroke();
    g.fillStyle = c.bg0; g.beginPath(); g.arc(cx, cy, r0 * 0.12, 0, TAU); g.fill();
  },
  /* 9 glass: big translucent shapes overlapping, soft shadows, a glossy edge */
  (g, W, H, S, c, R) => {
    const shapes = 3 + Math.floor(R() * 2);
    for (let i = 0; i < shapes; i++) {
      const col = [c.a1, c.a2, c.a3][i % 3];
      const x = W * (0.2 + R() * 0.6), y = H * (0.2 + R() * 0.6), s = S * (0.22 + R() * 0.2), kind = Math.floor(R() * 3), rot = R() * TAU;
      g.save(); g.translate(x, y); g.rotate(rot);
      g.shadowColor = c.light ? 'rgba(160,40,100,.25)' : 'rgba(0,0,0,.45)'; g.shadowBlur = S * 0.06; g.shadowOffsetY = S * 0.02;
      const gr = g.createLinearGradient(-s, -s, s, s);
      gr.addColorStop(0, rgba(mixC(col, '#ffffff', 0.35), 0.85)); gr.addColorStop(1, rgba(col, 0.55));
      g.fillStyle = gr;
      g.beginPath();
      if (kind === 0) g.arc(0, 0, s, 0, TAU);
      else if (kind === 1) { const q = s * 0.3; g.moveTo(-s + q, -s); g.arcTo(s, -s, s, s, q); g.arcTo(s, s, -s, s, q); g.arcTo(-s, s, -s, -s, q); g.arcTo(-s, -s, s, -s, q); }
      else { g.moveTo(0, -s * 1.1); g.lineTo(s, s * 0.7); g.lineTo(-s, s * 0.7); g.closePath(); }
      g.fill();
      g.shadowColor = 'rgba(0,0,0,0)';
      g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = S / 300; g.stroke();
      g.restore();
    }
  },
];

const FONT = '"Inter Variable","Segoe UI Variable Display","Segoe UI","Noto Sans","Roboto","Helvetica Neue",system-ui,sans-serif';

/** Title typography for exported covers (media overlay, embedding): a calm block at the bottom. */
function drawTitle(g: Ctx, W: number, H: number, t: CoverText, c: Scheme) {
  const title = t.title.trim(), artist = t.artist.trim();
  const pad = W * 0.07, maxW = W - pad * 2;
  const wrap = (txt: string, size: number) => {
    g.font = `700 ${size}px ${FONT}`;
    const words = txt.split(/\s+/), lines: string[] = [];
    let cur = '';
    for (const w of words) { const next = cur ? cur + ' ' + w : w; if (g.measureText(next).width <= maxW || !cur) cur = next; else { lines.push(cur); cur = w; } }
    if (cur) lines.push(cur);
    return lines;
  };
  let size = W * 0.075, lines = wrap(title, size);
  while ((lines.length > 2 || lines.some((l) => g.measureText(l).width > maxW)) && size > W * 0.04) { size *= 0.9; lines = wrap(title, size); }
  if (lines.length > 2) { lines = lines.slice(0, 2); lines[1] = lines[1].replace(/.{0,2}$/, '…'); }
  const small = Math.max(9, W * 0.03);
  const blockH = lines.length * size * 1.1 + small * 1.8;
  const top = H - pad - blockH;
  const dark = !c.light;
  const ink = dark ? '#ffffff' : '#111111';
  const sg = g.createLinearGradient(0, top - pad, 0, H);
  sg.addColorStop(0, 'rgba(0,0,0,0)'); sg.addColorStop(1, dark ? 'rgba(0,0,0,.45)' : 'rgba(255,255,255,.55)');
  g.globalAlpha = 1; g.fillStyle = sg; g.fillRect(0, top - pad, W, H - top + pad);
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.fillStyle = ink;
  let y = top;
  for (const l of lines) { y += size * 1.05; g.font = `700 ${size}px ${FONT}`; g.fillText(l, pad, y, maxW); }
  g.font = `600 ${small}px ${FONT}`; g.globalAlpha = 0.75;
  g.fillText(artist.toUpperCase().split('').join('\u200a'), pad, y + small * 1.6, maxW);
  g.globalAlpha = 1;
}
