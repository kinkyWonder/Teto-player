/** "Download" screen — like Dot Player: link or "artist — title", YouTube + SoundCloud results, downloads with progress. */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { isMobile } from '../../app/api';
import { t } from '../../i18n';
import { NetRow, NetSkeleton } from './NetRow';
import { JobRow } from './Jobs';
import {
  clearFinished, engine, enqueue, extractUrl, onShare, search, SOURCE_LABEL, takeShare, useDlJobs,
  type DlItem, type DlMeta, type DlSource, type Engine,
} from '../../core/download';

// last results survive leaving the screen
let lastQ = '', lastItems: DlItem[] = [];

export function DownloadView({ q: initial, meta }: { q?: string; meta?: DlMeta }) {
  const jobs = useDlJobs();
  const [input, setInput] = useState(initial ?? '');
  const [items, setItems] = useState<DlItem[]>(initial ? [] : lastItems);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<DlSource | null>(null);
  const [eng, setEng] = useState<Engine | null>(null);
  const inp = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true, tm = 0;
    const poll = () => engine().then((e) => { if (!alive) return; setEng(e); if (!e.ready && !e.error) tm = window.setTimeout(poll, 1500); }).catch(() => alive && setEng(null));
    poll();
    return () => { alive = false; clearTimeout(tm); };
  }, []);

  const submit = async (text: string) => {
    const s = text.trim();
    if (s.length < 2) return;
    setErr(null);
    const url = extractUrl(s);
    if (url) { enqueue({ url, title: '', artist: '' }, ctx); setInput(''); inp.current?.blur(); return; }
    inp.current?.blur();
    setBusy(true);
    try {
      const r = await search(s);
      lastQ = s; lastItems = r;
      setItems(r);
      if (!r.length) setErr(t('Ничего не нашлось'));
    } catch (e) { setItems([]); setErr(String((e as Error)?.message ?? e)); } finally { setBusy(false); }
  };

  useEffect(() => {
    const sh = takeShare();
    if (sh) { setInput(sh); submit(sh); } else if (initial) submit(initial); else if (lastQ && !input) setInput(lastQ);
    return onShare((x) => { takeShare(); setInput(x); submit(x); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isUrl = !!extractUrl(input);
  const ctx = meta && input.trim() === initial ? meta : undefined; // results of the album's search go into the album
  const shown = items.filter((x) => !filter || x.source === filter);
  const sources = [...new Set(items.map((x) => x.source))];
  const label = !isMobile ? 'YouTube · SoundCloud · Spotify' : !eng ? '' : eng.error ? t('Движок не запустился') : !eng.ready ? (eng.updating ? t('Обновляю yt-dlp…') : t('Запускаю движок…')) : 'YouTube · SoundCloud · ВК · Spotify';

  return (
    <div className="dlv">
      {label && <div className="dl-cap">{label}</div>}
      <div className="ptitle">{t('Скачать')}</div>
      <form className="dl-in" onSubmit={(e) => { e.preventDefault(); submit(input); }}>
        <input ref={inp} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('Ссылка или исполнитель — название')} enterKeyHint={isUrl ? 'go' : 'search'} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        {input && <button type="button" className="dl-clr" onClick={() => { setInput(''); inp.current?.focus(); }}><Icon n="x" s={15} /></button>}
        <button type="submit" className="dl-go" title={isUrl ? t('Скачать') : t('Найти')}><Icon n={isUrl ? 'download' : 'search'} s={18} /></button>
      </form>
      {ctx && <div className="dl-tip dl-alb"><Icon n="disc" s={13} />{t('Скачанное попадёт в альбом «{0}»', ctx.album)}</div>}
      <div className="dl-tip">{isMobile ? t('Можно «Поделиться» ссылкой из YouTube, SoundCloud или Spotify прямо в Teto') : t('Ссылка на YouTube / SoundCloud / Spotify скачивается сразу. Другие программы могут прислать ссылку через API (docs/API.md)')}</div>

      {jobs.length > 0 && <>
        <div className="dl-h"><span>{t('Загрузки')}</span>{jobs.some((j) => j.state === 'done' || j.state === 'failed') && <button onClick={clearFinished}>{t('Очистить')}</button>}</div>
        {jobs.map((j) => <JobRow key={j.id} j={j} />)}
      </>}

      {busy && <NetSkeleton n={6} />}
      {err && !busy && <div className="dl-err muted">{err}</div>}
      {!busy && items.length > 0 && <>
        <div className="dl-h"><span>{t('Результаты')}</span></div>
        {sources.length > 1 && (
          <div className="dl-chips">
            <button className={!filter ? 'on' : ''} onClick={() => setFilter(null)}>{t('Все')}</button>
            {sources.map((s) => <button key={s} className={filter === s ? 'on' : ''} onClick={() => setFilter(s)}>{t(SOURCE_LABEL[s])}</button>)}
          </div>
        )}
        <div className="nr-list">{shown.map((r, i) => <NetRow key={r.url} r={r} i={i} job={jobs.find((x) => x.url === r.url)} meta={ctx} />)}</div>
      </>}
    </div>
  );
}
