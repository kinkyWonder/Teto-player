/** Monthly report: full-screen "stories" in the colours and fonts of the current theme / layout. */
import { useEffect, useRef, useState } from 'react';
import { Cover } from '../ui/Cover';
import { Icon } from '../ui/icons';
import { Logo } from '../ui/Logo';
import { albumHasCover, isMobile } from '../app/api';
import { toast } from '../app/store';
import { fmtNum, plural } from '../core/util';
import { t, isEn } from '../i18n';
import { closeReport, useReport } from './schedule';
import { WEEKDAYS, type Report as R } from './data';
import { copyReport, shareReport } from './share';
import '../styles/report.css';

const SLIDE_MS = 8000;
const cov = (id: number, title: string, artist: string, genre: string) => ({ id, cover: (!isMobile || albumHasCover(id) ? 'file' : null) as 'file' | null, recipe: null, title, artist, genre });
const hrs = (s: number) => (s / 3600 >= 10 ? Math.round(s / 3600) : (s / 3600).toLocaleString(isEn() ? 'en-US' : 'ru-RU', { maximumFractionDigits: 1 }));
const pct = (x: number) => Math.round(x * 100);
const nPlays = (n: number) => `${fmtNum(n)} ${plural(n, 'прослушивание', 'прослушивания', 'прослушиваний')}`;
const dayLabel = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString(isEn() ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long' });
const WD_SHORT = () => (isEn() ? ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] : ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
const animOff = () => document.documentElement.dataset.anim === 'off';
const d = (ms: number) => ({ animationDelay: ms + 'ms' });

function Count({ to, dur = 1300, delay = 150 }: { to: number; dur?: number; delay?: number }) {
  const [v, setV] = useState(() => (animOff() ? to : 0));
  useEffect(() => {
    if (animOff()) { setV(to); return; }
    let raf = 0; const t0 = performance.now() + delay;
    const f = (now: number) => { const k = Math.max(0, Math.min(1, (now - t0) / dur)); setV(Math.round(to * (1 - Math.pow(1 - k, 4)))); if (k < 1) raf = requestAnimationFrame(f); };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{fmtNum(v)}</>;
}

/** Donut: segments draw themselves one after another (stroke-dashoffset). */
function Ring({ parts, label, sub }: { parts: number[]; label?: React.ReactNode; sub?: string }) {
  const C = 2 * Math.PI * 40;
  let at = 0;
  return (
    <div className="rring">
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="40" className="trk" />
        {parts.map((p, i) => {
          const len = Math.max(0, p * C - (parts.length > 1 && p > 0.02 ? 2 : 0));
          const el = <circle key={i} cx="50" cy="50" r="40" className={'sg s' + i} style={{ strokeDasharray: `${len} ${C}`, ['--len' as string]: len, transform: `rotate(${-90 + (at / C) * 360}deg)`, animationDelay: 250 + i * 260 + 'ms' }} />;
          at += p * C;
          return el;
        })}
      </svg>
      {label != null && <div className="rrl"><b>{label}</b>{sub && <span>{sub}</span>}</div>}
    </div>
  );
}

function Delta({ now, before }: { now: number; before?: number }) {
  if (!before) return null;
  const k = Math.round(((now - before) / before) * 100);
  if (Math.abs(k) < 1) return <div className="rdelta">{t('Как в прошлом месяце')}</div>;
  return <div className={'rdelta ' + (k > 0 ? 'up' : 'dn')}><Icon n="chev" s={14} />{t('{0}% к прошлому месяцу', (k > 0 ? '+' : '−') + Math.abs(k))}</div>;
}

/** Days of the month as a calendar (Mon..Sun columns), brightness = minutes of music. */
function Calendar({ r }: { r: R }) {
  const lead = (new Date(r.month + '-01T12:00:00').getDay() + 6) % 7;
  const max = Math.max(1, ...r.daily);
  return (
    <div className="rcal">
      {WD_SHORT().map((w) => <em key={w}>{w}</em>)}
      {Array.from({ length: lead }, (_, i) => <span key={'x' + i} className="pad" />)}
      {r.daily.map((m, i) => <i key={i} className={m >= 1 ? 'on' : ''} style={{ ['--v' as string]: (0.25 + 0.75 * (m / max)).toFixed(2), ...d(200 + (i + lead) * 22) }}><s>{i + 1}</s></i>)}
    </div>
  );
}

function Heat({ r }: { r: R }) {
  const max = Math.max(1, ...r.grid);
  return (
    <div className="rheat">
      {WD_SHORT().map((w, wd) => (
        <div key={w} className="hr"><em>{w}</em>{r.grid.slice(wd * 8, wd * 8 + 8).map((v, b) => <i key={b} style={{ ['--v' as string]: v ? (0.15 + 0.85 * (v / max)).toFixed(2) : 0, ...d(150 + (wd + b) * 45) }} />)}</div>
      ))}
      <div className="hr lab"><em /><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
    </div>
  );
}

type Slide = { key: string; el: JSX.Element };
function slides(r: R): Slide[] {
  const a = r.topArtists[0], s = r.topTracks[0], al = r.topAlbums[0];
  const maxH = Math.max(...r.hours, 1);
  const mins = Math.round(r.secs / 60);
  const films = Math.round(r.secs / 7200);
  const out: Slide[] = [];
  out.push({ key: 'intro', el: <div className="rs intro">
    <div className="rl"><Logo s={44} /></div>
    <div className="rk">{t('Ваш месяц в Teto')}</div>
    <h1>{r.label}<br /><span>{r.year}</span></h1>
    <div className="rmini">
      <div><b><Count to={mins} /></b><span>{t('минут')}</span></div>
      <div><b><Count to={r.songs} /></b><span>{t('песен')}</span></div>
      <div><b><Count to={r.artists} /></b><span>{t('артистов')}</span></div>
    </div>
    <p className="hint">{t('Нажмите, чтобы листать. Удерживайте — пауза.')}</p>
  </div> });
  out.push({ key: 'time', el: <div className="rs time">
    <div className="rk">{t('Время с музыкой')}</div>
    <div className="big"><Count to={mins} /></div>
    <div className="bigl">{t('минут музыки')}</div>
    <Delta now={r.secs} before={r.prev?.secs} />
    <p>{t('{0} ч за месяц · в среднем {1} мин в день', hrs(r.secs), Math.round(mins / r.daysInMonth))}</p>
    {r.daily?.length > 0 && <Calendar r={r} />}
    <p className="sm">{t('Музыка звучала {0} из {1} дней', r.days, r.daysInMonth)}</p>
  </div> });
  if (a) out.push({ key: 'artist', el: <div className="rs artist">
    <div className="rk">{t('Исполнитель месяца')}</div>
    <div className="rhw"><Cover a={cov(a.album_id, a.album, a.name, a.genre)} size={300} className="cv rhero round" eager /><div className="rbadge">#1</div></div>
    <h2>{a.name}</h2>
    <p>{t('{0} ч · {1}', hrs(a.secs), nPlays(a.plays))}</p>
    <div className="rshare"><i style={{ ['--w' as string]: Math.max(3, pct(r.topShare ?? 0)) + '%' }} /><span>{t('{0}% всей вашей музыки', pct(r.topShare ?? 0))}</span></div>
    {r.topArtists.length > 1 && <ol className="rlist">{r.topArtists.slice(1, 5).map((x, i) => <li key={x.name} style={d(500 + i * 90)}><b>{i + 2}</b><span>{x.name}</span><em>{hrs(x.secs)} {t('ч')}</em></li>)}</ol>}
  </div> });
  if (s) out.push({ key: 'songs', el: <div className="rs songs">
    <div className="rk">{t('Песни месяца')}</div>
    <ol className="rsongs">{r.topTracks.map((x, i) => (
      <li key={x.id} style={{ ['--w' as string]: Math.round((x.plays / s.plays) * 100) + '%', ...d(120 + i * 110) }}>
        <Cover a={cov(x.album_id, x.album, x.artist, x.genre)} size={96} className="cv" eager />
        <div><b>{x.title}</b><span>{x.artist}</span></div><em>×{x.plays}</em>
      </li>))}</ol>
    {s.plays >= 3 && <p>{t('«{0}» вы включали {1} раз — это {2} мин.', s.title, s.plays, Math.round(s.secs / 60))}</p>}
  </div> });
  if (al) out.push({ key: 'album', el: <div className="rs album">
    <div className="rk">{t('Альбом месяца')}</div>
    <div className="rhw"><Cover a={cov(al.id, al.title, al.artist, al.genre)} size={300} className="cv rhero" eager /></div>
    <h2>{al.title}</h2><p>{al.artist} · {hrs(al.secs)} {t('ч')}</p>
    {r.tags.length > 0 && <><div className="rk2">{t('Ваши тэги')}</div><div className="rtags">{r.tags.slice(0, 4).map((x, i) => <span key={x.name} style={{ ['--w' as string]: Math.max(4, pct(x.share)) + '%', ...d(400 + i * 120) }}><b>{x.name}</b><em>{pct(x.share)}%</em></span>)}</div></>}
  </div> });
  const PARTS = [t('Утро'), t('День'), t('Вечер'), t('Ночь')];
  const best = r.parts?.length ? r.parts.indexOf(Math.max(...r.parts)) : -1;
  out.push({ key: 'clock', el: <div className="rs clock">
    <div className="rk">{t('Когда вы слушаете')}</div>
    <h2>{t('Пик — {0}:00', r.peakHour)}</h2>
    {best >= 0 && <div className="rday">
      <Ring parts={r.parts} label={pct(r.parts[best]) + '%'} sub={PARTS[best]} />
      <ul>{PARTS.map((p, i) => <li key={p} className={'s' + i} style={d(300 + i * 120)}><i /><span>{p}</span><b>{pct(r.parts[i])}%</b></li>)}</ul>
    </div>}
    <div className="hours">{r.hours.map((h, i) => <i key={i} style={{ height: Math.max(4, (h / maxH) * 100) + '%', ...d(500 + i * 28) }} className={i === r.peakHour ? 'pk' : ''} />)}</div>
    <div className="hlab"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
  </div> });
  if (r.grid?.length === 56) out.push({ key: 'week', el: <div className="rs week">
    <div className="rk">{t('Ритм недели')}</div>
    <h2>{t('Больше всего — по {0}', WEEKDAYS()[r.peakWeekday])}</h2>
    <Heat r={r} />
    <p>{[r.session >= 2 ? t('Самый долгий марафон — {0} ч подряд.', r.session) : '', t('{0}% музыки — на выходных.', pct(r.weekendShare))].filter(Boolean).join(' ')}</p>
  </div> });
  if (r.newSongs > 0 || r.newArtists > 0) out.push({ key: 'new', el: <div className="rs new">
    <div className="rk">{t('Открытия')}</div>
    <div className="rday">
      <Ring parts={[r.newSongs / Math.max(1, r.songs)]} label={pct(r.newSongs / Math.max(1, r.songs)) + '%'} sub={t('новое')} />
      <div className="rnew">
        <div><b><Count to={r.newSongs} /></b><span>{plural(r.newSongs, 'новая песня', 'новые песни', 'новых песен')}</span></div>
        {r.newArtists > 0 && <div><b><Count to={r.newArtists} /></b><span>{plural(r.newArtists, 'новый исполнитель', 'новых исполнителя', 'новых исполнителей')}</span></div>}
      </div>
    </div>
    <p>{r.plays ? t('Вы пропускаете {0}% песен в первые 30 секунд.', pct(r.skips / r.plays)) : ''}</p>
    {r.nightTrack && <div className="rnight"><Icon n="sparkle" s={18} /><div><span>{t('Песня ночи')}</span><b>{r.nightTrack.title}</b><em>{r.nightTrack.artist}</em></div></div>}
  </div> });
  out.push({ key: 'facts', el: <div className="rs facts">
    <div className="rk">{t('Факты')}</div>
    <div className="fgrid">
      <div style={d(100)}><b><Count to={r.plays} /></b><span>{t('прослушиваний')}</span></div>
      <div style={d(180)}><b>{r.streak}</b><span>{t('дней подряд — лучшая серия')}</span></div>
      {r.busiest && <div className="w" style={d(260)}><b>{dayLabel(r.busiest.d)}</b><span>{t('самый музыкальный день: {0} мин', Math.round(r.busiest.secs / 60))}</span></div>}
      <div style={d(340)}><b>{films || '<1'}</b><span>{t('фильмов — столько же по времени')}</span></div>
      <div style={d(420)}><b>{(r.secs / (r.daysInMonth * 864)).toLocaleString(isEn() ? 'en-US' : 'ru-RU', { maximumFractionDigits: 1 })}%</b><span>{t('всего месяца звучала музыка')}</span></div>
      {r.first && <div className="w" style={d(500)}><b>{r.first.title}</b><span>{t('первая песня месяца — {0}', r.first.artist)}</span></div>}
    </div>
  </div> });
  out.push({ key: 'sum', el: <div className="rs sum">
    <div className="rcard">
      <div className="rk">TETO · {r.label} {r.year}</div>
      <div className="big"><Count to={mins} /></div><div className="bigl">{t('минут музыки')}</div>
      {a && <div className="ra"><Cover a={cov(a.album_id, a.album, a.name, a.genre)} size={120} className="cv round" eager /><div><span>{t('Исполнитель месяца')}</span><b>{a.name}</b></div></div>}
      <ol>{r.topTracks.slice(0, 3).map((x) => <li key={x.id}><b>{x.title}</b> <span>— {x.artist}</span></li>)}</ol>
      <div className="rp"><b>{r.persona.title}</b><span>{r.persona.text}</span></div>
    </div>
  </div> });
  return out;
}

export function ReportHost() {
  const r = useReport();
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [hold, setHold] = useState(false);
  const press = useRef<{ t: number; timer: number } | null>(null);
  useEffect(() => setI(0), [r]);
  const list = r ? slides(r) : [];
  const n = list.length;
  useEffect(() => {
    if (!r) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeReport();
      else if (e.key === 'ArrowRight' || e.key === ' ') setI((x) => Math.min(n - 1, x + 1));
      else if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [r, n]);
  if (!r) return null;
  const act = (f: (r: R) => Promise<string>) => async (e: React.MouseEvent) => {
    e.stopPropagation(); setBusy(true);
    try { const m = await f(r); if (m) toast(m); } catch (err) { toast(String(err)); } finally { setBusy(false); }
  };
  const last = i === n - 1;
  const onBtn = (e: React.PointerEvent) => !!(e.target as Element).closest('button');
  return (
    <div className={'rep p-' + r.persona.key + (hold ? ' hold' : '')} style={{ ['--slide' as string]: SLIDE_MS + 'ms' }}
      onPointerDown={(e) => {
        if (onBtn(e)) return;
        const timer = window.setTimeout(() => setHold(true), 220);
        press.current = { t: performance.now(), timer };
      }}
      onPointerUp={(e) => {
        const p = press.current; press.current = null;
        if (!p) return;
        clearTimeout(p.timer);
        if (hold || performance.now() - p.t > 220) { setHold(false); return; }
        if (onBtn(e)) return;
        if (e.clientX / innerWidth < 0.3) setI(Math.max(0, i - 1)); else if (!last) setI(i + 1);
      }}
      onPointerCancel={() => { if (press.current) clearTimeout(press.current.timer); press.current = null; setHold(false); }}
      onContextMenu={(e) => e.preventDefault()}>
      <div className="rbg"><i /><i /><i /></div>
      <div className="rbar">{list.map((s, k) => <i key={s.key + (k === i ? '-on' : '')} className={k < i ? 'done' : k === i ? 'on' : ''}
        onAnimationEnd={k === i && !last ? () => setI((x) => (x === k ? Math.min(n - 1, x + 1) : x)) : undefined} />)}</div>
      <button className="rx" onClick={(e) => { e.stopPropagation(); closeReport(); }} title={t('Закрыть')}><Icon n="x" s={20} /></button>
      <div className={'rslide' + (last ? ' last' : '')} key={list[i].key}>{list[i].el}</div>
      {last && (
        <div className="racts" onClick={(e) => e.stopPropagation()}>
          <button className="btn pri" disabled={busy} onClick={act(shareReport)}><Icon n="download" />{isMobile ? t('Поделиться') : t('Сохранить картинку')}</button>
          {!isMobile && <button className="btn" disabled={busy} onClick={act(copyReport)}>{t('Копировать')}</button>}
          <button className="btn" onClick={() => closeReport()}>{t('Готово')}</button>
        </div>
      )}
    </div>
  );
}
