import { api } from '../app/api';
import { getState, setState, toast } from '../app/store';
import type { Album, CoverRecipe } from '../core/types';
import { newRecipe } from './draw';
import { coverImage, coverPng, themedRecipe } from './gen';
import { prefs } from '../core/prefs';
import { paletteFor } from './palettes';
import { recipeOf } from '../ui/Cover';
import { t } from '../i18n';
import { themeKey } from '../core/look';

const analysisCache = new Map<number, Promise<Partial<CoverRecipe> & { genre: string; title?: string }>>();
/** Forget analysis results of this session (Settings → "Reprocess all files"). */
export const forgetAnalysis = () => analysisCache.clear();
/** Audio analysis (cached in the DB, computed on a background-priority thread) mapped to cover parameters. */
export function baseFor(a: Album) {
  let p = analysisCache.get(a.id);
  if (!p) {
    p = api.analyze(a.id).then((x) => ({ ...x, genre: a.genre || x.genre || '', title: a.title, palette: paletteFor(a.genre || x.genre || '') })).catch(() => ({ genre: a.genre, title: a.title, palette: paletteFor(a.genre) }));
    analysisCache.set(a.id, p);
  }
  return p;
}

export async function applyRecipe(a: Album, recipe: CoverRecipe, history: CoverRecipe[]) {
  const s = getState();
  const cur = s.currentAlbum?.id === a.id ? { ...s.currentAlbum, recipe, history } : s.currentAlbum;
  setState({ currentAlbum: cur, rov: { ...s.rov, [a.id]: recipe }, hov: { ...s.hov, [a.id]: history } });
  await api.setRecipe(a.id, recipe, history);
  // PNG for the system media overlay (SMTC) and tray; the user's files are not touched.
  coverPng(themedRecipe(recipe, themeKey(s.settings.theme), prefs().coverStyle), 300, { title: a.title, artist: a.artist }).then((png) => api.saveGenCover(a.id, png)).catch(() => {});
}

export async function anotherVariant(a: Album, count = 1) {
  const base = await baseFor(a);
  const fresh: CoverRecipe[] = [];
  let prev = getState().rov[a.id] ?? recipeOf(a);
  for (let i = 0; i < count; i++) {
    const r = newRecipe(prev, base);
    fresh.push(r);
    prev = r;
  }
  // pre-render off-thread so the swap is instant and crossfades
  await Promise.all(fresh.map((r) => coverImage(r, 300).catch(() => '')));
  const hist = getState().hov[a.id] ?? a.history;
  const history = [...fresh, ...hist.filter((h) => !fresh.includes(h))].slice(0, 20);
  await applyRecipe(a, fresh[0], history);
}

/** "Пересоздать обложку": everything happens in the background, the result is applied automatically. */
export async function regenerateCover(albumId: number) {
  if (getState().genBusy.includes(albumId)) return;
  setState((s) => ({ genBusy: [...s.genBusy, albumId] }));
  try {
    const a = getState().currentAlbum?.id === albumId ? getState().currentAlbum : await api.album(albumId);
    if (!a) return;
    toast(t('Создаю обложку для «{0}»…', a.title));
    await anotherVariant(a, 1);
    toast(t('Новая обложка «{0}» готова', a.title));
  } catch (e) {
    toast(t('Не удалось создать обложку: ') + e);
  } finally {
    setState((s) => ({ genBusy: s.genBusy.filter((x) => x !== albumId) }));
  }
}
