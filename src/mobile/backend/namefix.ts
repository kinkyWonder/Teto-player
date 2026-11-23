// The desktop scanner's name cleanup (src-tauri/src/namefix.rs) compiled to WebAssembly for the phone,
// so both versions recognise "artist - title" from messy file names exactly the same way.
import wasmUrl from './namefix.wasm?url';

export interface Raw { stem: string; title: string; artist: string; album: string; aa: string }
export interface NameOut { title: string; artist: string; album: string; albumArtist: string; no: number; conf: 0 | 1 | 2; origin: 'tags' | 'cleaned' | 'file'; swapped: boolean }

interface Exports {
  memory: WebAssembly.Memory;
  nf_buf(len: number): number; nf_out(): number; nf_reset(): void; nf_artists(): number;
  nf_add_track(): void; nf_add_alias(): void; nf_resolve(): number; nf_dirty(): number; nf_key(): number;
}

const SEP = '\u001f';
const enc = new TextEncoder(), dec = new TextDecoder();
let X: Exports | null = null;
let loading: Promise<Exports | null> | null = null;

export function loadNamefix(): Promise<Exports | null> {
  return (loading ??= (async () => {
    try {
      const bin = await (await fetch(wasmUrl)).arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bin, {});
      X = instance.exports as unknown as Exports;
    } catch (e) { console.warn('namefix wasm', e); X = null; }
    return X;
  })());
}
export const namefixReady = () => !!X;

function put(s: string) {
  const b = enc.encode(s);
  const p = X!.nf_buf(b.length);
  new Uint8Array(X!.memory.buffer, p, b.length).set(b);
}
function take(len: number) { return dec.decode(new Uint8Array(X!.memory.buffer, X!.nf_out(), len)); }

export const nf = {
  reset() { X?.nf_reset(); },
  artists() { return X ? X.nf_artists() : 0; },
  addTrack(artist: string, title: string, album: string, w = 1) { if (!X) return; put([artist, title, album, String(w)].join(SEP)); X.nf_add_track(); },
  addAlias(from: string, to: string) { if (!X) return; put(from + SEP + to); X.nf_add_alias(); },
  resolve(r: Raw): NameOut | null {
    if (!X) return null;
    put([r.stem, r.title, r.artist, r.album, r.aa].join(SEP));
    const p = take(X.nf_resolve()).split(SEP);
    return { title: p[0] ?? '', artist: p[1] ?? '', album: p[2] ?? '', albumArtist: p[3] ?? '', no: +p[4] || 0, conf: (+p[5] || 0) as 0 | 1 | 2, origin: (p[6] || 'file') as NameOut['origin'], swapped: p[7] === '1' };
  },
  dirty(title: string, artist: string, album: string) { if (!X) return false; put([title, artist, album].join(SEP)); return X.nf_dirty() === 1; },
  key(s: string) { if (!X) return s.trim().toLowerCase().replace(/ё/g, 'е'); put(s); return take(X.nf_key()); },
};
