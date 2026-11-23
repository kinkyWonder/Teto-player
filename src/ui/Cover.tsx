import { memo, useEffect, useRef, useState } from 'react';
import type { CoverRecipe, Track } from '../core/types';
import { defaultRecipe } from '../cover/draw';
import { coverCached, coverImage, themedRecipe } from '../cover/gen';
import { albumHasCover, coverUrl, isMobile } from '../app/api';
import { useStore } from '../app/store';
import { themeKey } from '../core/look';
import { usePrefsLite } from '../core/prefsHook';

/** `cover: undefined` = not known yet (the album is still loading): nothing is generated for it meanwhile. */
export interface CoverSrc { id: number; cover?: 'file' | 'folder' | 'custom' | null; recipe: CoverRecipe | null; title?: string; artist?: string; genre?: string }

const BUCKETS = [64, 168, 300, 450, 600, 800];
const bucket = (css: number) => {
  const px = css * (window.devicePixelRatio || 1);
  return BUCKETS.find((b) => b >= px) ?? 800;
};

export function recipeOf(a: CoverSrc): CoverRecipe | null {
  if (a.recipe) return a.recipe;
  if (a.cover) return null;
  return defaultRecipe(`${a.artist ?? ''}|${a.title ?? a.id}`, a.genre ?? '', a.id, a.title);
}

/** Cover source for the playing track: the loaded album, or "unknown yet" while it loads (no generated flash). */
export function trackCover(tr: Track, album: { id: number } & Partial<CoverSrc> | null | undefined): CoverSrc {
  if (album && album.id === tr.album_id) return album as CoverSrc;
  const known = isMobile ? (albumHasCover(tr.album_id) ? 'file' : undefined) : undefined;
  return { id: tr.album_id, cover: known, recipe: null, title: tr.album, artist: tr.artist, genre: tr.genre };
}

/**
 * Album cover: real image from the backend cache or a procedurally generated one.
 * `eager` covers (player, mini player) never blink: the new picture is decoded off-screen first and only then
 * replaces the old one, and while the album is still loading the previous picture stays.
 */
export const Cover = memo(function Cover({ a: a0, size, className = 'cv', eager, style, typeset }: { a: CoverSrc | null; size: number; className?: string; eager?: boolean; style?: React.CSSProperties; typeset?: boolean }) {
  let a = a0;
  const ref = useRef<HTMLImageElement>(null);
  const rev = useStore((s) => s.coverRev);
  const ov = useStore((s) => (a && a.id in s.rov ? s.rov[a.id] : undefined));
  if (a && ov !== undefined) a = { ...a, recipe: ov };
  const theme = useStore((s) => themeKey(s.settings.theme));
  const style3d = usePrefsLite().coverStyle;
  const [visible, setVisible] = useState(!!eager);
  const [failed, setFailed] = useState(false);
  const unknown = !!a && a.cover === undefined && !a.recipe && !failed;
  let rec = a && !unknown ? (failed && !a.recipe ? defaultRecipe(`${a.artist ?? ''}|${a.title ?? a.id}`, a.genre ?? '', a.id, a.title) : recipeOf(a)) : null;
  // generated covers always follow the colours of the current theme (and the chosen style)
  if (rec) rec = themedRecipe(rec, theme, style3d);
  const px = bucket(size);
  // titles are typeset only on demand (exported covers); in the UI the title is already printed next to the cover
  const text = typeset && a && a.title ? { title: a.title, artist: a.artist ?? '' } : undefined;

  useEffect(() => setFailed(false), [a?.id, a?.cover]);
  useEffect(() => {
    if (visible || !ref.current) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setVisible(true), io.disconnect()), { rootMargin: '300px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);

  // generated covers render asynchronously in a worker; cached ones show instantly
  const [, setGen] = useState<string | undefined>(() => (rec ? coverCached(rec, px, text) : undefined));
  const recKey = rec ? JSON.stringify(rec) + px + (text ? text.title + text.artist : '') : '';
  useEffect(() => {
    if (!rec || !visible) return;
    const c = coverCached(rec, px, text);
    if (c) { setGen(c); return; }
    let live = true;
    const ac = new AbortController();
    let tries = 0;
    const go = () => coverImage(rec, px, text, ac.signal).then((u) => live && setGen(u)).catch(() => {
      // a busy / restarted worker: try again a little later instead of leaving an empty square
      if (live && ++tries < 3) setTimeout(() => live && go(), 700 * tries);
    });
    go();
    return () => { live = false; ac.abort(); };
  }, [recKey, visible]);
  let want: string | undefined;
  if (a && visible && !unknown) want = rec ? coverCached(rec, px, text) : coverUrl(a.id, px) + (rev ? `?r=${rev}` : '');
  if (unknown && !eager && a && visible) want = coverUrl(a.id, px); // desktop lists: try the real file, fall back on error

  // eager covers: swap only to an already decoded picture
  const [shown, setShown] = useState<string | undefined>(want);
  useEffect(() => {
    if (!eager || !want || want === shown) return;
    let live = true;
    const im = new Image();
    im.src = want;
    const done = () => { if (live) setShown(want); };
    im.decode().then(done, () => { if (live) { if (!rec) setFailed(true); else done(); } });
    return () => { live = false; };
  }, [want, eager]);
  const src = eager ? shown ?? want : want;
  return (
    <img
      ref={ref}
      className={className + (src && (rec || eager) ? ' ld' : '')}
      style={style}
      src={src}
      alt=""
      draggable={false}
      decoding="async"
      onLoad={(e) => e.currentTarget.classList.add('ld')}
      onError={() => !rec && setFailed(true)}
    />
  );
});
