/**
 * Search → internet, right inside the ordinary search: runs on request (the keyboard's Enter / search key, or the
 * button), so typing stays instant. Sources: Settings → Download → "Where from" (chips here switch it too).
 * Songs that are already in the library are hidden; a tap downloads the song (into the album when it came from one).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Icon } from '../icons';
import { t } from '../../i18n';
import { navigate, useStore } from '../../app/store';
import { isMobile } from '../../app/api';
import { titleKey } from '../../core/hints';
import type { Track } from '../../core/types';
import { enqueue, extractUrl, NET_SOURCES, search, useDlJobs, type DlItem, type DlMeta } from '../../core/download';
import { setPrefs } from '../../core/prefs';
import { usePrefsLite } from '../../core/prefsHook';
import { NetRow, NetSkeleton } from './NetRow';

const SHOW = 8;
// recent queries → results (going back and forth costs no network)
const cache = new Map<string, Promise<DlItem[]>>();
function cached(q: string, src: string): Promise<DlItem[]> {
  const k = src + '\u0001' + q.toLowerCase();
  let p = cache.get(k);
  if (!p) {
    p = search(q, src as 'all').catch((e) => { cache.delete(k); throw e; });
    cache.set(k, p);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/* "search the internet for this" — asked by the header (Enter) or the button */
let asked = '';
const subs = new Set<() => void>();
export function askNet(q: string) { asked = q.trim(); subs.forEach((f) => f()); }
export const useAsked = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => asked);
export const isAsked = (q: string) => !!q.trim() && asked.toLowerCase() === q.trim().toLowerCase();

const akey = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\b(official|vevo|topic|music)\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
/** Already in the library: same title and (when both are known) a matching artist. */
function owned(it: DlItem, local: Track[]): boolean {
  const tk = titleKey(it.title), ak = akey(it.artist);
  if (!tk) return false;
  return local.some((x) => {
    if (titleKey(x.title) !== tk) return false;
    const xa = akey(x.artist || '');
    return !ak || !xa || xa.includes(ak) || ak.includes(xa);
  });
}

export function SearchOnline({ q, local, meta }: { q: string; local: Track[]; meta?: DlMeta }) {
  const offline = useStore((s) => s.settings.offline);
  const src = usePrefsLite().dlSrc ?? 'all';
  const jobs = useDlJobs();
  const want = useAsked();
  const s = q.trim();
  const url = extractUrl(s);
  const [res, setRes] = useState<{ k: string; items: DlItem[] | null; err: string } | null>(null);
  const [all, setAll] = useState(false);
  const on = !offline && !url && s.length >= 2 && want.toLowerCase() === s.toLowerCase();
  const k = src + '\u0001' + s.toLowerCase();

  useEffect(() => {
    if (!on) return;
    let live = true;
    setAll(false);
    setRes((r) => (r?.k === k && r.items ? r : { k, items: null, err: '' }));
    cached(s, src).then((items) => live && setRes({ k, items, err: '' }), (e) => live && setRes({ k, items: [], err: String(e?.message ?? e) }));
    return () => { live = false; };
  }, [k, on]);

  if (offline) return null;
  if (url) {
    return <div className="net">
      <button className="net-ask" onClick={() => enqueue({ url, title: '', artist: '' }, meta)}><Icon n="download" s={16} /><span>{t('Скачать по ссылке')}</span><small>{t('YouTube · SoundCloud · Spotify · ВК')}</small></button>
    </div>;
  }
  if (s.length < 2) return null;
  const srcLabel = src === 'all' || (!isMobile && src === 'vk') ? (isMobile ? 'YouTube · SoundCloud · ВК' : 'YouTube · SoundCloud') : t(NET_SOURCES.find((x) => x[0] === src)?.[1] ?? '');
  const mine = res && res.k === k ? res : null;
  if (!on || !mine) {
    return <div className="net">
      <button className="net-ask" onClick={() => askNet(s)}>
        <Icon n="search" s={16} /><span>{t('Найти «{0}» в интернете', s)}</span>
        <small>{srcLabel}</small>
      </button>
    </div>;
  }
  const fresh = mine.items?.filter((x) => !owned(x, local)) ?? null;
  const shown = fresh && (all ? fresh : fresh.slice(0, SHOW));
  return (
    <div className="net on">
      <div className="sec net-h"><span><Icon n="download" s={14} style={{ verticalAlign: -2, marginRight: 6 }} />{t('Скачать из интернета')}</span>
        {!isMobile && !!fresh?.length && <button onClick={() => navigate({ kind: 'download', q: s })}>{t('Ещё')}</button>}</div>
      <div className="net-src">{NET_SOURCES.filter(([k2]) => isMobile || k2 !== 'vk').map(([k2, l]) => <button key={k2} className={src === k2 || (!isMobile && src === 'vk' && k2 === 'all') ? 'on' : ''} onClick={() => setPrefs({ dlSrc: k2 })}>{t(l)}</button>)}</div>
      {meta && <div className="dl-tip dl-alb"><Icon n="disc" s={13} />{t('Скачанное попадёт в альбом «{0}»', meta.album)}</div>}
      {fresh === null ? <NetSkeleton />
        : mine.err ? <div className="muted net-msg">{mine.err}</div>
        : !fresh.length ? <div className="muted net-msg">{mine.items?.length ? t('Всё найденное уже есть в медиатеке') : t('В сети ничего не нашлось')}</div>
        : <div className="nr-list">{shown!.map((r, i) => <NetRow key={r.url} r={r} i={i} job={jobs.find((x) => x.url === r.url)} meta={meta} />)}</div>}
      {!!fresh && fresh.length > SHOW && !all && <button className="lnk srch-more" onClick={() => setAll(true)}>{t('Показать все ({0})', fresh.length)}</button>}
    </div>
  );
}
