import { api, call, isMobile, pickFolder } from './api';
import { getState, navigate, openMenu, setState, toast, type MenuItem } from './store';
import type { Track } from '../core/types';
import { regenerateCover } from '../cover/actions';
import { smartShuffle } from '../core/mix';
import { armPick, setSrc, tetoOrder } from '../core/teto';
import { editMenu, refreshReview } from '../core/names';
import { t } from '../i18n';
import { plural } from '../core/util';
import { orderPlaylists, setTetoSkip } from '../core/extras';

export async function refreshLibrary() {
  const [stats, playlists] = await Promise.all([api.stats(), api.playlists()]);
  setState((s) => ({ stats, playlists, libVersion: s.libVersion + 1, albumsCache: null }));
  refreshReview();
}

export async function refreshPlaylists() {
  setState({ playlists: await api.playlists() });
}

export function playTracks(list: Track[], index: number, shuffle = false) {
  if (shuffle) return playMix(list);
  setSrc(null);
  const ids = list.filter((t) => !t.missing).map((t) => t.id);
  if (!ids.length) return;
  const start = list[index] && !list[index].missing ? ids.indexOf(list[index].id) : 0;
  api.playQueue(ids, Math.max(0, start), shuffle).catch((e) => toast(String(e)));
}

/** Smart shuffle: no near repeats, artists/albums kept apart, recently heard tracks pushed back. */
export function playMix(list: Track[], first?: Track, src: string | null = null) {
  const pool = list.filter((t) => !t.missing);
  if (!pool.length) return;
  setSrc(src);
  const order = smartShuffle(pool, first);
  api.playMix(pool.map((t) => t.id), order.map((t) => t.id)).catch((e) => toast(String(e)));
}

export async function playAlbum(id: number, shuffle = false) {
  const t = await api.albumTracks(id);
  playTracks(t, 0, shuffle);
}

export function toggleViz(on?: boolean) {
  setState((s) => ({ viz: on ?? !s.viz }));
}

export async function addFolder() {
  const p = await pickFolder();
  if (!p) return;
  await api.addFolder(p);
  toast(t('Папка добавлена — идёт сканирование'));
}

export async function toggleFav(t: Track): Promise<boolean> {
  const fav = !t.fav;
  await api.setFav(t.id, fav);
  t.fav = fav;
  const s = getState();
  if (s.player.track?.id === t.id) setState({ player: { ...s.player, track: { ...s.player.track, fav } } });
  setState((st) => ({ stats: { ...st.stats, favs: st.stats.favs + (fav ? 1 : -1) }, libVersion: st.libVersion + 1 }));
  return fav;
}

export function newPlaylist(trackIds: number[] = []) {
  setState({
    dialog: {
      title: t('Новый плейлист'), text: t('Введите название плейлиста'), ok: t('Создать'), input: '',
      onOk: async () => {
        const name = (getState().dialog?.input ?? '').trim() || t('Новый плейлист');
        const id = await api.createPlaylist(name);
        if (trackIds.length) await api.addToPlaylist(id, trackIds);
        await refreshPlaylists();
        if (!trackIds.length) navigate({ kind: 'playlist', id });
        else toast(t('Добавлено в «{0}»', name));
      },
    },
  });
}

/** A song the user starts by hand (tap / double click on its row) — counted for the Teto mix. */
export function playPicked(list: Track[], index: number) {
  const tr = list[index];
  playTracks(list, index);
  if (tr && !tr.missing) armPick(tr.id);
}

/** The Teto button: top-10 hand-picked songs shuffled, then picks 11–20 shuffled, then everything else at random. */
export async function playTeto(list?: Track[]) {
  const all = (list ?? (await api.tracks('artist'))).filter((x) => !x.missing);
  if (!all.length) return;
  const order = tetoOrder(all);
  if (!order.length) { toast(t('Все песни вычеркнуты из Teto')); return; }
  setSrc('teto');
  api.playMix(order.map((x) => x.id), order.map((x) => x.id)).catch((e) => toast(String(e)));
  showPlaying(true);
}

/** Teto mode ✕: never play this song in Teto again, skip it now. */
export function tetoCross(tr: Track) {
  setTetoSkip(tr.id, true);
  toast(t('«{0}» больше не будет играть в Teto', tr.title));
  api.next();
}

/** Tag tile: start its mix, or pause / resume when this tag is already playing. */
export function playTag(key: string, list: Track[]) {
  const s = getState();
  if (s.src === 'tag:' + key && s.player.track) { togglePlay(); return; }
  playMix(list, undefined, 'tag:' + key);
  showPlaying(true);
}

/** Play / pause; the icons switch at once instead of waiting for the player to report back. */
export function togglePlay() {
  const p = getState().player;
  if (p.track) showPlaying(!p.playing);
  api.toggle();
}
function showPlaying(on: boolean) {
  setState((s) => ({ player: { ...s.player, playing: on } }));
}

export const addToPlaylist = (id: number, name: string, ids: number[]) =>
  api.addToPlaylist(id, ids).then(() => { refreshPlaylists(); toast(t('Добавлено в «{0}»', name)); });

export function addToFavs(sel: Track[]) {
  const off = sel.filter((x) => !x.fav);
  return Promise.all(off.map((x) => toggleFav(x))).then(() => toast(off.length ? t('В любимом: +{0}', off.length) : t('Уже в любимом')));
}

/** Playlist picker for several tracks (phone selection bar, "⋯"). */
export function playlistMenu(e: { clientX: number; clientY: number }, ids: number[]) {
  const pls = orderPlaylists(getState().playlists);
  openMenu(e, [
    { label: t('Новый плейлист…'), onClick: () => newPlaylist(ids) },
    ...(pls.length ? [{ sep: true, label: '' }] : []),
    ...pls.map((p) => ({ label: p.name, onClick: () => addToPlaylist(p.id, p.name, ids) })),
  ]);
}

export async function trackMenu(e: React.MouseEvent, sel: Track[], extra: MenuItem[] = []) {
  e.preventDefault();
  const pt = { clientX: e.clientX, clientY: e.clientY };
  const ids = sel.map((x) => x.id);
  const one = sel.length === 1 ? sel[0] : null;
  const pls = orderPlaylists(getState().playlists);
  const custom = one ? await call<boolean>('has_custom_cover', { albumId: one.album_id }).catch(() => false) : false;
  const items: MenuItem[] = [
    ...(isMobile ? [] : [{ label: t('Воспроизвести'), onClick: () => playTracks(sel, 0) }]),
    { label: t('Играть следующим'), onClick: () => api.enqueue(ids, true).then(() => toast(t('Будет играть следующим'))) },
    { label: t('Добавить в очередь'), onClick: () => api.enqueue(ids, false).then(() => toast(t('В очереди: +{0}', ids.length))) },
    { sep: true, label: '' },
    ...(one ? [{ label: one.fav ? t('Убрать из любимого') : t('Добавить в любимое'), onClick: () => toggleFav(one) }] : [{ label: t('Добавить в любимое'), onClick: () => addToFavs(sel) }]),
    { label: t('Новый плейлист…'), onClick: () => newPlaylist(ids) },
    ...pls.slice(0, 12).map((p) => ({ label: t('В плейлист «{0}»', p.name), onClick: () => addToPlaylist(p.id, p.name, ids) })),
    ...extra,
    { sep: true, label: '' },
    one ? editMenu(one, { cover: true, customCover: custom }) : { label: t('Редактировать'), sub: [{ label: t('Тэги…'), onClick: () => setState({ genreEdit: sel }) }] },
    ...(isMobile ? [] : [{ sep: true, label: '' }, ...[...new Set(sel.map((x) => x.album_id))].slice(0, 1).map((aid) => ({
      label: getState().genBusy.includes(aid) ? t('Обложка создаётся…') : t('Пересоздать обложку'),
      disabled: getState().genBusy.includes(aid),
      onClick: () => regenerateCover(aid),
    }))]),
    { sep: true, label: '' },
    ...(one ? [
      { label: t('Перейти к альбому'), onClick: () => navigate({ kind: 'album', id: one.album_id }) },
      ...(isMobile ? [] : [
        { label: t('Перейти к исполнителю'), onClick: () => navigate({ kind: 'artist', name: one.artist }) },
        { label: t('Показать в проводнике'), onClick: () => api.revealFile(one.path) },
      ]),
    ] : []),
    { sep: true, label: '' },
    isMobile
      ? { label: sel.length > 1 ? t('Удалить {0} из медиатеки', sel.length) : t('Удалить из медиатеки'), danger: true, onClick: () => deleteTracks(sel) }
      : { label: sel.length > 1 ? t('Удалить {0} в корзину', sel.length) : t('Удалить в корзину'), danger: true, onClick: () => deleteTracks(sel) },
  ];
  openMenu(pt, items);
}

/** Phones: tracks live inside the app, so removing them also frees the space. Desktop: the files go to the Recycle Bin. */
export function deleteTracks(sel: Track[], after?: () => void) {
  setState({
    dialog: {
      title: sel.length > 1 ? t('Удалить {0} {1}?', sel.length, plural(sel.length, 'трек', 'трека', 'треков')) : t('Удалить трек?'),
      text: isMobile ? t('Файлы будут удалены из памяти приложения. Оригиналы в других приложениях не пострадают.') : t('Файлы будут перемещены в корзину Windows — их можно восстановить оттуда.'), ok: t('Удалить'), danger: true,
      onOk: async () => {
        try { await call('delete_tracks', { trackIds: sel.map((x) => x.id) }); } catch (e) { toast(String((e as Error)?.message ?? e)); return; }
        after?.(); await refreshLibrary(); toast(t('Удалено'));
      },
    },
  });
}
