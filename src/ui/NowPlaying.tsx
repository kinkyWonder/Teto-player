import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArtistLinks } from '../core/artists';
import { api } from '../app/api';
import { Icon } from './icons';
import { getState, livePos, navigate, openMenu, setState, toast, useStore } from '../app/store';
import type { Album } from '../core/types';
import { newRecipe } from '../cover/draw';
import { coverPng } from '../cover/gen';
import { anotherVariant, applyRecipe, baseFor } from '../cover/actions';
import { genreLabel } from '../cover/palettes';
import { tagLabel } from '../core/tags';
import { Cover, recipeOf } from './Cover';
import { toggleViz } from '../app/actions';
import { Visualizer } from './Fx';
import { t as tr } from '../i18n';

/** Two stacked layers so a cover change crossfades (400 ms). */
function Cross({ a, size, cls }: { a: Album | null; size: number; cls: string }) {
  const rov = useStore((s) => (a ? s.rov[a.id] : undefined));
  const key = a ? `${a.id}:${JSON.stringify(rov ?? a.recipe)}:${a.cover}` : 'none';
  const [layers, setLayers] = useState<{ key: string; a: Album | null }[]>([{ key, a }]);
  useEffect(() => {
    setLayers((l) => (l[l.length - 1].key === key ? l : [...l.slice(-1), { key, a }]));
    const t = setTimeout(() => setLayers((l) => l.slice(-1)), 450);
    return () => clearTimeout(t);
  }, [key]);
  return <>{layers.map((l, i) => <Cover key={l.key} a={l.a} size={size} eager className={cls + (i === layers.length - 1 && layers.length > 1 ? ' fadein' : '')} />)}</>;
}

export function NowPlaying() {
  const track = useStore((s) => s.player.track);
  const album = useStore((s) => s.currentAlbum);
  const showLyrics = useStore((s) => s.showLyrics);
  const rov = useStore((s) => (album ? s.rov[album.id] : undefined));
  const hov = useStore((s) => (album ? s.hov[album.id] : undefined));
  const bgBusy = useStore((s) => !!album && s.genBusy.includes(album.id));
  const autoGen = useStore((s) => s.settings.auto_gen);
  const [win, setWin] = useState(0);
  const [busy0, setBusy] = useState(false);
  const busy = busy0 || bgBusy;
  const a0 = album && rov !== undefined ? { ...album, recipe: rov } : album;
  const a = a0 && hov ? { ...a0, history: hov } : a0;

  // automatic background generation for albums without any cover
  useEffect(() => {
    if (a && !a.cover && !a.recipe && autoGen) {
      baseFor(a).then((base) => {
        const cur = getState().currentAlbum;
        if (cur?.id !== a.id || cur.recipe) return;
        const r = newRecipe(null, base);
        applyRecipe(a, r, [r]);
      });
    }
    setWin(0);
  }, [a?.id]);

  if (!track) {
    return (
      <div className="np"><div className="in">
        <div className="nph">{tr('Сейчас играет')}</div>
        <div className="npe"><Icon n="disc" s={40} style={{ strokeWidth: 1.2 }} />{tr('Ничего не играет')}<br />{tr('Выберите альбом или трек')}</div>
      </div></div>
    );
  }

  const isGen = !!a && (!!a.recipe || !a.cover);
  const badge = !a ? '' : isGen ? `${tr('Сгенерировано')} · ${(a.genre || track.genre ? tagLabel(genreLabel(a.genre || track.genre)) : tr('Без тэгов'))}` : a.cover === 'file' ? tr('Из файла') : a.cover_name || 'cover.jpg';
  const hist = a?.history ?? [];
  const shown = hist.slice(win, win + 4);
  const sel = a?.recipe;
  const doGen = async (n: number) => {
    if (!a || busy) return;
    setBusy(true);
    try { await anotherVariant(a, n); setWin(0); } finally { setBusy(false); }
  };
  const menu = (e: React.MouseEvent) => openMenu(e, [
    { label: tr('3D-визуализация'), onClick: () => toggleViz(true) },
    { label: tr('Другой вариант обложки'), onClick: () => doGen(1) },
    ...(a?.cover && a.recipe ? [{ label: tr('Вернуть обложку из файла'), onClick: async () => { await api.useRealCover(a.id); setState((s) => ({ rov: { ...s.rov, [a.id]: null }, currentAlbum: s.currentAlbum && { ...s.currentAlbum, recipe: null } })); } }] : []),
    ...(a && isGen ? [{ label: tr('Встроить в файлы альбома…'), onClick: () => embed(a) }] : []),
    { sep: true, label: '' },
    { label: tr('Перейти к альбому'), onClick: () => navigate({ kind: 'album', id: track.album_id }) },
    { label: tr('Скрыть панель'), onClick: () => api.setSettings({ show_np: false }).then((s) => setState({ settings: s })) },
  ]);

  return (
    <div className="np">
      <div className="glowc"><Cross a={a} size={64} cls="glow" /></div>
      <div className="in">
        <div className="nph">{tr('Сейчас играет')}<button onClick={menu}><Icon n="more" s={16} /></button></div>
        <div className="npc" onDoubleClick={() => toggleViz(true)} title={tr('Двойной щелчок — 3D-визуализация')}>
          <Cross a={a} size={300} cls="cv" />
          <Visualizer />
          {badge && <span className="badge">{badge}</span>}
          <button className={'gen' + (busy ? ' busy' : '')} onClick={() => doGen(1)} disabled={busy}><Icon n="refresh" />{busy ? tr('Создаю…') : tr('Другой вариант')}</button>
        </div>
        {isGen && (
          <div className="vars">
            {win > 0 && <button className="nv" onClick={() => setWin(Math.max(0, win - 4))}><Icon n="left" s={14} /></button>}
            {shown.map((r) => (
              <button key={r.seed} className={'v' + (sel && sel.seed === r.seed ? ' sel' : '')} onClick={() => a && applyRecipe(a, r, hist)}>
                <Cover a={{ id: -1, cover: null, recipe: r }} size={52} eager />
              </button>
            ))}
            {win + 4 < hist.length && <button className="nv" onClick={() => setWin(win + 4)}><Icon n="chev" s={14} /></button>}
            <button className="more" title={tr('Ещё 4 варианта')} onClick={() => doGen(4)}><Icon n="spark" s={16} /></button>
          </div>
        )}
        <div className="ti" key={track.id}>
          <div>
            <b title={track.title}>{track.title}</b>
            <span><ArtistLinks name={track.artist} /> · <a onClick={() => navigate({ kind: 'album', id: track.album_id })}>{track.album}</a></span>
          </div>
        </div>
        {showLyrics && <LyricsBlock />}
      </div>
    </div>
  );
}

function embed(a: Album) {
  setState({
    dialog: {
      title: tr('Встроить обложку в файлы?'),
      text: tr('Сгенерированная обложка будет записана в теги всех треков альбома «{0}». Это изменит ваши файлы.', a.title),
      ok: tr('Встроить'),
      onOk: async () => {
        const r = getState().rov[a.id] ?? a.recipe ?? recipeOf(a);
        if (!r) return;
        const png = await coverPng(r, 600, { title: a.title, artist: a.artist });
        try {
          const n = await api.embedCover(a.id, png);
          toast(tr('Обложка записана в файлы: {0}', n));
        } catch (e) { toast(tr('Ошибка записи: ') + e); }
      },
    },
  });
}

export function LyricsBlock() {
  const ly = useStore((s) => s.lyrics);
  const trackId = useStore((s) => s.player.track?.id ?? 0);
  const offline = useStore((s) => s.settings.offline);
  const [cur, setCur] = useState(-1);
  const sc = useRef<HTMLDivElement>(null);
  const userScroll = useRef(0);
  const synced = ly?.kind === 'synced';

  // no per-frame polling: sleep exactly until the next line is due (re-armed on seek / pause)
  const playing = useStore((s) => s.player.playing);
  const pos0 = useStore((s) => s.pos);
  useEffect(() => {
    if (!synced || !ly) return;
    let t = 0;
    const L = ly.lines;
    const step = () => {
      const p = livePos(getState()) + 0.15;
      let i = -1, lo = 0, hi = L.length - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= p) { i = m; lo = m + 1; } else hi = m - 1; }
      setCur((c) => (c === i ? c : i));
      if (!getState().player.playing || i + 1 >= L.length) return;
      t = window.setTimeout(step, Math.max(40, (L[i + 1].t - p) * 1000 + 10));
    };
    step();
    return () => clearTimeout(t);
  }, [ly, synced, playing, pos0]);

  useLayoutEffect(() => {
    const el = sc.current;
    if (!el || !synced || cur < 0 || Date.now() - userScroll.current < 3000) return;
    const p = el.children[cur] as HTMLElement | undefined;
    if (p) el.scrollTo({ top: p.offsetTop - el.offsetTop - 26, behavior: 'smooth' });
  }, [cur, synced]);
  useEffect(() => { sc.current?.scrollTo({ top: 0 }); setCur(-1); }, [ly]);

  const wrong = async (e: React.MouseEvent) => {
    const items = [
      { label: tr('Неверный текст — другие варианты'), onClick: async () => {
        try {
          const c = await api.lyricsCandidates(trackId);
          if (!c.length) return toast(tr('Других вариантов не найдено'));
          openMenu(e, c.slice(0, 12).map((x) => ({ label: (x.synced ? '⏱ ' : '') + x.label, onClick: async () => setState({ lyrics: await api.pickLyrics(trackId, x.id) }) })));
        } catch (er) { toast(String(er)); }
      } },
      { label: tr('Сохранить рядом с файлом как .lrc'), disabled: !ly || ly.kind === 'none' || ly.source === '.lrc', onClick: async () => { try { toast('Сохранено: ' + (await api.saveLrc(trackId))); } catch (er) { toast(String(er)); } } },
      { label: tr('Искать заново'), onClick: async () => setState({ lyrics: await api.lyrics(trackId) }) },
    ];
    openMenu(e, items);
  };

  const head = ly?.kind === 'synced' ? tr('Текст · синхронизирован') : tr('Текст');
  return (
    <div className={'lyr' + (synced ? ' syn' : '')}>
      <div className="h">{head}
        {ly && ly.source && <span className="src"><Icon n={ly.source === 'LRCLIB' ? 'globe' : 'file'} s={12} />{ly.source}</span>}
        <button onClick={wrong} title={tr('Действия с текстом')}><Icon n="more" s={14} /></button>
      </div>
      {!ly ? <div className="empty">{tr('Ищем текст…')}</div>
        : ly.kind === 'none' ? <div className="empty">{tr('Текст не найден')}{offline ? tr(' · офлайн-режим') : ''}</div>
        : ly.kind === 'error' ? <div className="empty"><span><Icon n="wifioff" s={14} style={{ verticalAlign: -2, marginRight: 6 }} />{tr('Ошибка сети — не удалось загрузить текст')}</span>
            <button className="btn" onClick={async () => setState({ lyrics: await api.lyrics(trackId) })}><Icon n="refresh" />{tr('Повторить')}</button></div>
        : (
          <div className="sc" ref={sc} onWheel={() => (userScroll.current = Date.now())} onTouchMove={() => (userScroll.current = Date.now())}>
            {ly.lines.map((l, i) => (
              <p key={i} className={synced ? (i === cur ? 'cur' : '') : 'plain'} onClick={synced ? () => api.seek(l.t) : undefined}>{l.text || '\u00a0'}</p>
            ))}
          </div>
        )}
    </div>
  );
}
