import { useEffect, useRef, useState } from 'react';
import { api, windowCtl } from '../app/api';
import { Icon } from './icons';
import { getState, goBack, goFwd, navigate, openMenu, setState, useStore, type View } from '../app/store';
import { fmtNum } from '../core/util';
import { newPlaylist } from '../app/actions';
import { Cover } from './Cover';
import { Logo } from './Logo';
import { GenreDialog } from './TagDialog';
import { ReportHost } from '../report/Report';
import { t } from '../i18n';
import { orderPlaylists, useExtrasVersion } from '../core/extras';
import { playlistCoverUrl } from '../cover/playlist';
import { askNet } from './views/SearchOnline';

export function TitleBar() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    const f = () => setMax(window.outerWidth >= screen.availWidth && window.outerHeight >= screen.availHeight);
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return (
    <div className="title">
      <div className="drag" data-tauri-drag-region onDoubleClick={() => windowCtl('max')}>
        <Logo s={17} /><span className="brand" data-tauri-drag-region>teto</span>
      </div>
      <div className="ctl">
        <button onClick={() => windowCtl('min')} title={t('Свернуть')}><Icon n="min" s={14} /></button>
        <button onClick={() => windowCtl('max')} title={max ? t('Восстановить') : t('Развернуть')}><Icon n={max ? 'restore' : 'max'} s={12} /></button>
        <button className="cls" onClick={() => windowCtl('close')} title={t('Закрыть')}><Icon n="x" s={14} /></button>
      </div>
    </div>
  );
}

function Nav({ icon, label, count, v }: { icon: string; label: string; count?: number; v: View }) {
  const on = useStore((s) => s.view.kind === v.kind || (v.kind === 'albums' && s.view.kind === 'album') || (v.kind === 'artists' && s.view.kind === 'artist') || (v.kind === 'genres' && s.view.kind === 'genre'));
  return (
    <button className={'nav' + (on ? ' on' : '')} onClick={() => navigate(v)}>
      <Icon n={icon} />{t(label)}{count !== undefined && count > 0 && <span className="c">{fmtNum(count)}</span>}
    </button>
  );
}

export function Sidebar() {
  const st = useStore((s) => s.stats);
  useExtrasVersion();
  const pls = orderPlaylists(useStore((s) => s.playlists));
  const scan = useStore((s) => s.scan);
  const view = useStore((s) => s.view);
  const busy = scan.state === 'scanning';
  return (
    <div className="side">
      <Nav icon="home" label="Главная" v={{ kind: 'home' }} />
      <Nav icon="grid" label="Каталог" count={pls.length} v={{ kind: 'catalog' }} />
      <Nav icon="disc" label="Альбомы" count={st.albums} v={{ kind: 'albums' }} />
      <Nav icon="user" label="Исполнители" count={st.artists} v={{ kind: 'artists' }} />
      <Nav icon="lib" label="Все треки" count={st.tracks} v={{ kind: 'tracks' }} />
      <Nav icon="genre" label="Тэги" v={{ kind: 'genres' }} />
      <Nav icon="heart" label="Любимое" count={st.favs} v={{ kind: 'favs' }} />
      <Nav icon="folder" label="Папки" v={{ kind: 'folders' }} />
      <Nav icon="download" label="Скачать" v={{ kind: 'download' }} />
      <div className="cap">{t('Плейлисты')}<button title={t('Новый плейлист')} onClick={() => newPlaylist()}><Icon n="plus" s={14} /></button></div>
      <div className="pls">
        {pls.map((p) => (
          <button key={p.id} className={'pl' + (view.kind === 'playlist' && view.id === p.id ? ' on' : '')} onClick={() => navigate({ kind: 'playlist', id: p.id })}>
            {playlistCoverUrl(p.id) ? <img className="cv" src={playlistCoverUrl(p.id)} alt="" style={{ width: 28, height: 28 }} />
              : <Cover a={p.recipe ? { id: 0, cover: null, recipe: p.recipe } : { id: p.album_id, cover: null, recipe: null, title: p.name }} size={28} />}
            <span>{p.name}</span>
          </button>
        ))}
      </div>
      <div className="sstat">
        {(busy || scan.state === 'error') && <>
          <span className={'dot' + (busy ? ' busy' : '')} style={scan.state === 'error' ? { background: '#ff8a80' } : undefined} />
          <span className="sl">{busy ? `${t('Сканирование')} ${scan.total ? Math.round((scan.done / scan.total) * 100) + '%' : '…'}` : t('Ошибка сканирования')}</span>
        </>}
        <button title={t('Настройки')} className={view.kind === 'settings' ? 'on' : ''} onClick={() => navigate({ kind: 'settings' })}><Icon n="gear" s={15} /></button>
        {busy && <div className="pr" style={{ flexBasis: '100%' }}><b style={{ width: scan.total ? (scan.done / scan.total) * 100 + '%' : '8%' }} /></div>}
      </div>
    </div>
  );
}

const SORTS: Record<string, string> = { artist: 'По исполнителю', title: 'По названию', year: 'По году', added: 'По дате добавления' };
const sortName = (k: string) => t(SORTS[k] ?? SORTS.artist);

export function TopBar({ searchRef }: { searchRef: React.RefObject<HTMLInputElement> }) {
  const back = useStore((s) => s.back.length);
  const fwd = useStore((s) => s.fwd.length);
  const view = useStore((s) => s.view);
  const sort = useStore((s) => s.sort);
  const [q, setQ] = useState(view.kind === 'search' ? view.q : '');
  const tm = useRef<number>();
  useEffect(() => { if (view.kind !== 'search') setQ(''); }, [view.kind]);
  const onQ = (v: string) => {
    setQ(v);
    clearTimeout(tm.current);
    // every letter searches the library right away (a short pause only before leaving the current page)
    const go = () => {
      const s = getState();
      if (!v.trim()) { if (s.view.kind === 'search') goBack(); return; }
      if (s.view.kind === 'search') setState({ view: { kind: 'search', q: v } });
      else navigate({ kind: 'search', q: v });
    };
    if (getState().view.kind === 'search') go(); else tm.current = window.setTimeout(go, 60);
  };
  return (
    <div className="top">
      <button className="hb" disabled={!back} onClick={goBack} title={t('Назад')}><Icon n="chev" s={16} style={{ transform: 'rotate(180deg)' }} /></button>
      <button className="hb" disabled={!fwd} onClick={goFwd} title={t('Вперёд')}><Icon n="chev" s={16} /></button>
      <label className="srch">
        <Icon n="search" />
        <input ref={searchRef} value={q} placeholder={t('Треки, альбомы, исполнители')} onChange={(e) => onQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { onQ(''); e.currentTarget.blur(); } else if (e.key === 'Enter' && q.trim()) { onQ(q); askNet(q); } }} spellCheck={false} />
        {!q && <kbd>Ctrl K</kbd>}
        {q && <button onClick={() => onQ('')} style={{ display: 'flex', color: 'var(--t3)' }}><Icon n="x" s={14} /></button>}
      </label>
      {['albums', 'tracks'].includes(view.kind) && (
        <button style={{ marginLeft: 'auto' }} className="hb" title={t('Сортировка: ') + sortName(sort).toLowerCase()}
          onClick={(e) => openMenu(e, Object.entries(SORTS).map(([k, l]) => ({ label: (k === sort ? '✓ ' : '\u2003') + t(l), onClick: () => setState({ sort: k }) })))}>
          <Icon n="sort" s={16} />
        </button>
      )}
    </div>
  );
}

export function Overlays() {
  const menu = useStore((s) => s.menu);
  const toastMsg = useStore((s) => s.toast);
  const dialog = useStore((s) => s.dialog);
  const mref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return setPos(null);
    const el = mref.current;
    const w = el?.offsetWidth ?? 220, h = el?.offsetHeight ?? 200;
    setPos({ x: Math.min(menu.x, innerWidth - w - 8), y: menu.y + h > innerHeight - 8 ? Math.max(8, menu.y - h) : menu.y });
    const close = (e: Event) => { if (!el?.contains(e.target as Node)) setState({ menu: null }); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setState({ menu: null });
    setTimeout(() => { addEventListener('mousedown', close); addEventListener('blur', close); }, 0);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc); removeEventListener('blur', close); };
  }, [menu]);
  return (
    <>
      {menu && (
        <div ref={mref} className="menu" style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}>
          {menu.items.map((it, i) => it.sep ? (i > 0 && i < menu.items.length - 1 && !menu.items[i - 1].sep ? <hr key={i} /> : null) : (
            <button key={i} className={(it.danger ? 'danger' : '') + (it.sub ? ' sub' : '')} disabled={it.disabled} onClick={() => {
              if (it.sub) { const parent = menu; setState({ menu: { ...menu, items: [{ label: it.label, back: true, onClick: () => setState({ menu: parent }) }, { sep: true, label: '' }, ...it.sub] } }); return; }
              if (it.back) { it.onClick?.(); return; }
              setState({ menu: null }); it.onClick?.();
            }}>{it.back ? <><Icon n="chev" s={12} style={{ transform: 'rotate(180deg)', marginRight: 6, verticalAlign: -1 }} />{it.label}</> : it.label}{it.sub && <Icon n="chev" s={12} />}</button>
          ))}
        </div>
      )}
      {toastMsg && <div className="toast">{toastMsg}</div>}
      <GenreDialog />
      <ReportHost />
      {dialog && (
        <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setState({ dialog: null })}>
          <form className="dlg" onSubmit={(e) => {
            e.preventDefault();
            // onOk reads the typed value from the store, so close the dialog only after it started
            const d = getState().dialog ?? dialog;
            d.onOk();
            if (getState().dialog === d) setState({ dialog: null });
          }}>
            <h4>{dialog.title}</h4>
            {dialog.text && <p>{dialog.text}</p>}
            {dialog.input !== undefined && <input autoFocus value={dialog.input} onChange={(e) => setState({ dialog: { ...dialog, input: e.target.value } })} />}
            {dialog.fields?.map((f, i) => (
              <label key={i} className="fld"><span>{f.label}</span>
                <input autoFocus={i === 0} value={f.value} placeholder={f.placeholder} spellCheck={false}
                  onChange={(e) => { const fields = dialog.fields!.slice(); fields[i] = { ...f, value: e.target.value }; setState({ dialog: { ...dialog, fields } }); }} /></label>
            ))}
            {dialog.note && <p className="note2">{dialog.note}</p>}
            <div className="b">
              <button type="button" className="btn" onClick={() => setState({ dialog: null })}>{t('Отмена')}</button>
              <button type="submit" className={'btn pri' + (dialog.danger ? ' dng' : '')} autoFocus={dialog.input === undefined && !dialog.fields}>{dialog.ok}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

export { api };
