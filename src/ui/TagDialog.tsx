import { useMemo, useState } from 'react';
import { Icon } from './icons';
import { setState, useStore } from '../app/store';
import { t } from '../i18n';
import { addCustomGenre, customGenres, genresOf, hasOwnGenres, setGenres, useExtrasVersion } from '../core/extras';
import { canonGenre, splitGenres, tagLabel, RUSSIAN, FOREIGN } from '../core/tags';
import { api } from '../app/api';
import { groupGenres } from '../core/mix';
import type { Track } from '../core/types';

/** Common genres offered even when the library has none of them yet. */
const COMMON = ['Pop', 'Rock', 'Hip-Hop', 'Rap', 'Electronic', 'Dance', 'House', 'Techno', 'Ambient', 'Indie', 'Alternative', 'Metal', 'Punk',
  'R&B', 'Soul', 'Jazz', 'Blues', 'Classical', 'Soundtrack', 'Folk', 'Country', 'Reggae', 'Lo-Fi', 'Phonk', 'K-Pop', 'J-Pop', 'Anime', 'Vocaloid', 'Chanson', 'Russian Rock', 'Russian Pop'];

let libGenres: string[] = [];
let libFor = -1;
/** Genres already used in the library (cached per library version). */
function useLibGenres() {
  const ver = useStore((s) => s.libVersion);
  const [, force] = useState(0);
  if (libFor !== ver) {
    libFor = ver;
    api.tracks('artist').then((all) => { libGenres = groupGenres(all).list.map((g) => g.name); force((x) => x + 1); }).catch(() => {});
  }
  return libGenres;
}

/** "Edit → Genres…": several genres per song, own genres, back to the tags. */
export function GenreDialog() {
  const sel = useStore((s) => s.genreEdit);
  return sel ? <Inner sel={sel} key={sel.map((x) => x.id).join(',')} /> : null;
}

function Inner({ sel }: { sel: Track[] }) {
  useExtrasVersion();
  const lib = useLibGenres();
  const start = useMemo(() => {
    // genres every selected song has
    const lists = sel.map((x) => genresOf(x));
    return lists[0]?.filter((g) => lists.every((l) => l.some((y) => y.toLowerCase() === g.toLowerCase()))) ?? [];
  }, [sel]);
  const [on, setOn] = useState<string[]>(start);
  const [q, setQ] = useState('');
  const all = useMemo(() => {
    const out: string[] = [];
    const add = (g: string) => { if (g && !out.some((y) => y.toLowerCase() === g.toLowerCase())) out.push(g); };
    on.forEach(add); add(RUSSIAN); add(FOREIGN); customGenres().forEach(add); lib.forEach(add); COMMON.forEach(add);
    return out;
  }, [lib, on]);
  const has = (g: string) => on.some((y) => y.toLowerCase() === g.toLowerCase());
  const toggle = (g: string) => setOn(has(g) ? on.filter((y) => y.toLowerCase() !== g.toLowerCase()) : [...on, g]);
  const close = () => setState({ genreEdit: null });
  const create = () => {
    const names = q.split(/[;,/]/).map((x) => x.trim()).filter(Boolean);
    if (!names.length) return;
    const made = names.map((n) => addCustomGenre(n));
    setOn([...on, ...made.filter((g) => !has(g))]);
    setQ('');
  };
  const own = sel.some((x) => hasOwnGenres(x.id));
  const tags = [...new Set(sel.flatMap((x) => splitGenres(x.genre)))];
  const shown = q.trim() ? all.filter((g) => g.toLowerCase().includes(q.trim().toLowerCase()) || tagLabel(g).toLowerCase().includes(q.trim().toLowerCase()) || g.toLowerCase().includes((canonGenre(q) || q).toLowerCase())) : all;
  const exact = q.trim() && all.some((g) => g.toLowerCase() === (canonGenre(q) || q.trim()).toLowerCase());
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form className="dlg gdlg" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { if (exact) { const g = all.find((x) => x.toLowerCase() === (canonGenre(q) || q.trim()).toLowerCase())!; if (!has(g)) toggle(g); setQ(''); } else create(); return; } setGenres(sel.map((x) => x.id), on); close(); }}>
        <h4>{t('Тэги')}</h4>
        <p>{sel.length === 1 ? `${sel[0].artist} — ${sel[0].title}` : t('Выбрано треков: {0}', sel.length)}</p>
        <label className="g-q"><Icon n="search" s={15} />
          <input value={q} placeholder={t('Найти или создать тэг')} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          {q.trim() && !exact && <button type="button" className="btn pri" onClick={create}><Icon n="plus" s={14} />{t('Создать')}</button>}
        </label>
        <div className="g-chips">
          {shown.map((g) => (
            <button type="button" key={g} className={'g-chip' + (has(g) ? ' on' : '')} onClick={() => toggle(g)}>{has(g) && <Icon n="check" s={13} />}{tagLabel(g)}</button>
          ))}
          {!shown.length && <span className="muted">{t('Нажмите «Создать», чтобы добавить свой тэг')}</span>}
        </div>
        {(own || tags.length > 0) && (
          <div className="note2">
            {tags.length ? t('В тегах файла: {0}', tags.join(', ')) : t('В файле тэгов нет')}
            {own && <> · <a onClick={() => { setGenres(sel.map((x) => x.id), null); close(); }}>{t('Вернуть тэги из файла')}</a></>}
          </div>
        )}
        <div className="b">
          <button type="button" className="btn" onClick={close}>{t('Отмена')}</button>
          <button type="submit" className="btn pri">{t('Сохранить')}</button>
        </div>
      </form>
    </div>
  );
}
