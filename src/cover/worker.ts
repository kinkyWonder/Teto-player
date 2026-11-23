/// <reference lib="webworker" />
// Renders generated covers off the main thread on an OffscreenCanvas (GPU-accelerated 2D canvas in WebView2).
import { drawCover, type CoverText } from './draw';
import '../viz/still'; // "3D" covers
import type { CoverRecipe } from '../core/types';

interface Req { id: number; recipe: CoverRecipe; size: number; type: 'jpeg' | 'png'; noGrain: boolean; text?: CoverText }

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, recipe, size, type, noGrain, text } = e.data;
  try {
    const cv = new OffscreenCanvas(size, size);
    drawCover(cv, recipe, noGrain, text);
    const blob = await cv.convertToBlob(type === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.9 });
    (self as unknown as Worker).postMessage({ id, blob });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
