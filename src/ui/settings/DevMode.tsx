/**
 * Developer mode (tap the version in Settings 7 times): everything the app knows about the listener —
 * Teto picks, crossed-out songs, play history, listening statistics, tags, preferences and local storage —
 * with resets. Nothing here leaves the device.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, call } from '../../app/api';
import { setState, toast } from '../../app/store';
import { allPicks, customGenres, resetTaste, setTetoSkip, tagOrder, tetoSkipList, useExtrasVersion } from '../../core/extras';
import { clearHistory, playHistory } from '../../core/mix';
import { prefs, setPrefs } from '../../core/prefs';
import { usePrefsLite } from '../../core/prefsHook';
import { PICK_SECS, TOP_A, TOP_B, tetoRanked } from '../../core/teto';
import type { Track } from '../../core/types';
import { fmtNum, fmtTime } from '../../core/util';
import { t } from '../../i18n';
import { showReport } from '../../report/schedule';
import { monthKey, monthName } from '../../report/data';
import { isMobile } from '../../app/api';
import { isIOS } from '../../app/platform';
import { VizQualityRow } from './SettingsView';
import { AnimRow, HintsRow, ListAlbumRow, LyricsCacheRow, LyricsNetRow, ReportArchiveRow, ReprocessRow, WebTagsRow, YtEngineRow } from './MoreSettings';

interface ListenRow { d: string; h: number; id: number; s: number; p: number; k: number; title: string; artist: string }

const Row = ({ title, d, children }: { title: string; d?: React.ReactNode; children?: React.ReactNode }) => (
  <div className="srow"><div><b>{title}</b>{d && <span>{d}</span>}</div>{children}</div>
);
const kb = (n: number) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB');
const when = (ms: number) => new Date(ms).toLocaleString();

/** Counts the version taps; the 7th one switches developer mode on (or off when it is on). */
let taps = 0, tapT = 0;
export function versionTap() {
  const now = Date.now();
  taps = now - tapT < 1500 ? taps + 1 : 1;
  tapT = now;
  const on = prefs().dev;
  if (taps >= 7) {
    taps = 0;
    setPrefs({ dev: !on });
    toast(on ? t('Режим разработчика выключен') : t('Режим разработчика включён'));
  } else if (taps >= 4 && !on) toast(t('Ещё {0} — и включится режим разработчика', 7 - taps));
}

function confirm(title: string, text: string, ok: () => void | Promise<void>) {
  setState({ dialog: { title, text, ok: t('Сбросить'), danger: true, onOk: async () => { await ok(); } } });
}

function List({ rows, empty }: { rows: React.ReactNode[]; empty?: string }) {
  if (!rows.length) return <div className="dev-empty muted">{empty ?? t('Пусто')}</div>;
  return <div className="dev-list">{rows}</div>;
}

export function DevSection() {
  const p = usePrefsLite();
  useExtrasVersion();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [listen, setListen] = useState<ListenRow[] | null>(null);
  const [rev, setRev] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.tracks('title').then(setTracks).catch(() => {}); }, [rev]);
  useEffect(() => {
    // the whole archive: from the first day with statistics up to tomorrow
    const to = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    call<string | null>('listen_first').then((from) => (from ? call<ListenRow[]>('listen_log', { from, to }) : []))
      .then(setListen).catch(() => setListen([]));
  }, [rev]);
  const byId = useMemo(() => new Map(tracks.map((x) => [x.id, x])), [tracks]);
  const name = (id: number) => { const x = byId.get(id); return x ? `${x.artist} — ${x.title}` : `#${id}`; };

  const picks = Object.entries(allPicks()).map(([id, n]) => [+id, n] as const).sort((a, b) => b[1] - a[1]);
  const skip = tetoSkipList();
  const hist = playHistory();
  const order = tagOrder();
  const custom = customGenres();
  const ranked = tetoRanked(tracks);
  const favs = tracks.filter((x) => x.fav).length;

  const agg = useMemo(() => {
    const per = new Map<number, { s: number; p: number; k: number; title: string; artist: string }>();
    const days = new Set<string>();
    let s = 0, pl = 0, k = 0;
    for (const r of listen ?? []) {
      s += r.s; pl += r.p; k += r.k; days.add(r.d);
      const o = per.get(r.id) ?? { s: 0, p: 0, k: 0, title: r.title, artist: r.artist };
      o.s += r.s; o.p += r.p; o.k += r.k;
      per.set(r.id, o);
    }
    return { s, p: pl, k, days: days.size, rows: listen?.length ?? 0, top: [...per.entries()].sort((a, b) => b[1].s - a[1].s).slice(0, 30), first: [...days].sort()[0] ?? '' };
  }, [listen]);

  const storage = useMemo(() => {
    const out: [string, number][] = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; out.push([k, (localStorage.getItem(k) ?? '').length * 2]); } } catch { /* ignore */ }
    return out.sort((a, b) => b[1] - a[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, open]);

  const dump = () => JSON.stringify({
    picks: Object.fromEntries(picks.map(([id, n]) => [name(id), n])),
    tetoSkip: skip.map(name),
    tetoNow: ranked.slice(0, TOP_A + TOP_B).map((x) => `${x.artist} — ${x.title}`),
    history: hist.slice(-300).map(([id, at]) => [new Date(at).toISOString(), name(id)]),
    listening: { hours: Math.round(agg.s / 36) / 100, plays: agg.p, skips: agg.k, days: agg.days, since: agg.first, top: agg.top.map(([id, o]) => ({ track: o.artist ? `${o.artist} — ${o.title}` : name(id), secs: Math.round(o.s), plays: o.p, skips: o.k })) },
    tags: { custom, order },
    prefs: p,
  }, null, 2);

  const sec = (k: string, title: string, d: React.ReactNode, body: React.ReactNode) => (
    <>
      <Row title={title} d={d}><button className="btn" onClick={() => setOpen(open === k ? null : k)}>{open === k ? t('Скрыть') : t('Показать')}</button></Row>
      {open === k && <div className="dev-box">{body}</div>}
    </>
  );

  return (
    <>
      <h3>{t('Режим разработчика')}</h3>
      <Row title={t('Режим разработчика')} d={t('Тонкие настройки и всё, что приложение знает о ваших вкусах. Данные не покидают устройство')}>
        <button className="btn" onClick={() => setPrefs({ dev: false })}>{t('Выключить')}</button>
      </Row>

      {isMobile && <>
        <h3>{t('Разработчик · интерфейс')}</h3>
        <AnimRow />
        <VizQualityRow />
        <ListAlbumRow />
        <HintsRow />

        <h3>{t('Разработчик · интернет')}</h3>
        <WebTagsRow />
        <LyricsNetRow />
        <LyricsCacheRow />
        {!isIOS && <YtEngineRow />}

        <h3>{t('Разработчик · медиатека')}</h3>
        <ReprocessRow />
      </>}

      <h3>{t('Разработчик · итоги месяца')}</h3>
      <Row title={t('Итоги месяца заранее')} d={t('Карточки отчёта за текущий месяц ({0}) — по данным на сегодня', monthName(monthKey(new Date())))}>
        <button className="btn" onClick={() => showReport(monthKey(new Date()), true).then((ok) => { if (!ok) toast(t('За этот месяц почти ничего не прослушано')); })}>{t('Показать')}</button>
      </Row>
      <ReportArchiveRow />

      <h3>{t('Разработчик · данные')}</h3>
      {sec('picks', t('Выборы Teto'), t('Песен: {0} · старт вручную и ≥ {1} с · блоки {2} + {3}', picks.length, PICK_SECS, TOP_A, TOP_B),
        <List rows={picks.slice(0, 100).map(([id, n], i) => <div key={id} className="dev-li"><span className="mono">{i + 1}</span><span className="dev-n">{name(id)}</span><b className="mono">{n}</b></div>)} />)}
      {sec('skip', t('Вычеркнутые в режиме Teto'), t('Песен: {0}', skip.length),
        <List rows={skip.map((id) => <div key={id} className="dev-li"><span className="dev-n">{name(id)}</span><button className="btn" onClick={() => setTetoSkip(id, false)}>{t('Вернуть')}</button></div>)} />)}
      {sec('order', t('Порядок Teto сейчас'), t('Блок 1: {0} · блок 2: {1} · дальше случайно: {2} · в любимом: {3}', Math.min(TOP_A, ranked.length), Math.max(0, Math.min(TOP_B, ranked.length - TOP_A)), Math.max(0, tracks.filter((x) => !x.missing).length - skip.length - Math.min(ranked.length, TOP_A + TOP_B)), favs),
        <List empty={t('Пока нет выборов и любимого — Teto играет всё случайно')} rows={ranked.slice(0, TOP_A + TOP_B).map((x, i) => (
          <div key={x.id} className="dev-li">
            <span className="mono">{i < TOP_A ? 'A' : 'B'}{(i % TOP_A) + 1}</span>
            <span className="dev-n">{x.artist} — {x.title}{x.fav ? ' ♥' : ''}</span>
            <b className="mono">{allPicks()[x.id] ?? 0}</b>
          </div>))} />)}
      {sec('hist', t('История воспроизведения'), t('Записей: {0} (для умной перемешки)', hist.length),
        <List rows={hist.slice().reverse().slice(0, 150).map(([id, at], i) => <div key={i} className="dev-li"><span className="mono dev-t">{when(at)}</span><span className="dev-n">{name(id)}</span></div>)} />)}
      {sec('listen', t('Статистика прослушиваний'), listen === null ? t('Загрузка…') : t('{0} ч слушания · {1} прослушиваний · {2} пропусков · {3} дн.', fmtNum(Math.round(agg.s / 360) / 10), fmtNum(agg.p), fmtNum(agg.k), agg.days),
        <>
          <div className="dev-kv"><span>{t('Записей')}</span><b className="mono">{fmtNum(agg.rows)}</b></div>
          <div className="dev-kv"><span>{t('С какого дня')}</span><b className="mono">{agg.first || '—'}</b></div>
          <List rows={agg.top.map(([id, o]) => <div key={id} className="dev-li"><span className="dev-n">{o.artist ? `${o.artist} — ${o.title}` : name(id)}</span><span className="mono">{fmtTime(o.s)} · {o.p}▶ · {o.k}⏭</span></div>)} />
        </>)}
      {sec('tags', t('Тэги'), t('Своих тэгов: {0} · порядок задан для {1}', custom.length, order.length),
        <>
          <div className="dev-kv"><span>{t('Свои тэги')}</span><b>{custom.join(', ') || '—'}</b></div>
          <div className="dev-kv"><span>{t('Порядок')}</span><b>{order.join(' · ') || '—'}</b></div>
        </>)}
      {sec('prefs', t('Настройки устройства'), t('Значения, которые хранятся только на этом устройстве'),
        <pre className="dev-pre">{JSON.stringify(p, null, 2)}</pre>)}
      {sec('ls', t('Локальное хранилище'), t('Ключей: {0} · {1}', storage.length, kb(storage.reduce((a, b) => a + b[1], 0))),
        <List rows={storage.map(([k, n]) => <div key={k} className="dev-li"><span className="dev-n mono">{k}</span><span className="mono">{kb(n)}</span></div>)} />)}

      {sec('json', t('Все данные одним файлом'), t('Выборы, вычеркнутые, история, статистика, тэги и настройки — JSON'),
        <>
          <button className="btn" style={{ marginBottom: 8 }} onClick={() => { navigator.clipboard?.writeText(dump()).then(() => toast(t('Скопировано')), () => toast(t('Не удалось скопировать'))); }}>{t('Скопировать')}</button>
          <pre className="dev-pre">{dump()}</pre>
        </>)}

      <h3>{t('Разработчик · сброс')}</h3>
      <Row title={t('Сбросить вкусы Teto')} d={t('Выборы и вычеркнутые песни — режим Teto начнёт с чистого листа')}>
        <button className="btn danger" onClick={() => confirm(t('Сбросить вкусы Teto?'), t('Выборы и вычеркнутые песни будут забыты.'), () => { resetTaste(); toast(t('Готово')); })}>{t('Сбросить')}</button>
      </Row>
      <Row title={t('Очистить историю')} d={t('История воспроизведения для умной перемешки')}>
        <button className="btn danger" onClick={() => confirm(t('Очистить историю?'), t('Умная перемешка забудет, что вы слушали недавно.'), () => { clearHistory(); setRev((x) => x + 1); toast(t('Готово')); })}>{t('Сбросить')}</button>
      </Row>
      <Row title={t('Сбросить статистику прослушиваний')} d={t('Ежемесячные отчёты тоже начнутся заново')}>
        <button className="btn danger" onClick={() => confirm(t('Сбросить статистику прослушиваний?'), t('Секунды, прослушивания и пропуски будут удалены. Прошлые отчёты станут пустыми.'), async () => { await call('listen_reset'); setRev((x) => x + 1); toast(t('Готово')); })}>{t('Сбросить')}</button>
      </Row>
      <Row title={t('Сбросить всё')} d={t('Вкусы, история и статистика. Медиатека, любимое, плейлисты и тэги остаются')}>
        <button className="btn danger" onClick={() => confirm(t('Сбросить всё?'), t('Вкусы Teto, история и статистика прослушиваний будут удалены.'), async () => { resetTaste(); clearHistory(); await call('listen_reset').catch(() => {}); setRev((x) => x + 1); toast(t('Готово')); })}>{t('Сбросить')}</button>
      </Row>
    </>
  );
}
