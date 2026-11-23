// Manual name fixes (namefix): rename a track, swap artist/title, rename an artist everywhere, artist photos.
// Manual edits always win over the automatic cleanup and survive rescans; audio files are never modified.
import { api } from '../app/api';
import { getState, navigate, setState, toast, type MenuItem } from '../app/store';
import type { Track } from './types';
import { refreshLibrary } from '../app/actions';
import { t as tr } from '../i18n';
import { isMobile } from '../app/platform';

/** Reload the "check this name" marks (cheap: one indexed query). */
export async function refreshReview() {
  const list = await api.namesToReview().catch(() => [] as [number, number, boolean][]);
  const review: Record<number, 1 | 2> = {};
  for (const [id, , swapped] of list) review[id] = swapped ? 2 : 1;
  setState({ review });
}

async function after(msg: string) {
  await refreshLibrary(); // also reloads the review marks
  toast(msg);
}

export function renameTrackDialog(t: Track) {
  setState({
    dialog: {
      title: tr('Переименовать трек'), text: '', ok: tr('Сохранить'),
      fields: [
        { label: tr('Название'), value: t.title },
        { label: tr('Исполнитель'), value: t.artist },
        { label: tr('Альбом'), value: t.album },
      ],
      note: tr('Сохраняется в медиатеке и переживает пересканирование. Сам файл не изменяется.'),
      onOk: async () => {
        const f = getState().dialog?.fields ?? [];
        const v = (i: number, old: string) => { const x = (f[i]?.value ?? '').trim(); return x && x !== old ? x : undefined; };
        const title = v(0, t.title), artist = v(1, t.artist), album = v(2, t.album);
        if (!title && !artist && !album) return;
        try { await api.renameTrack(t.id, title, artist, album); await after(tr('Трек переименован')); } catch (e) { toast(tr('Не удалось: ') + e); }
      },
    },
  });
}

export async function swapArtistTitle(t: Track) {
  try { await api.swapArtistTitle(t.id); await after(tr('Теперь: «{0}» — {1}', t.artist, t.title)); } catch (e) { toast(tr('Не удалось: ') + e); }
}

export async function renameArtistDialog(name: string) {
  const all = await api.artists().catch(() => []);
  const low = (s: string) => s.trim().toLowerCase().replace(/ё/g, 'е');
  setState({
    dialog: {
      title: tr('Переименовать исполнителя'), text: tr('Новое имя применится ко всем трекам «{0}» и к будущим сканированиям.', name) + ' ' + tr(MERGE_HINT), ok: tr('Переименовать'),
      input: name,
      onOk: async () => {
        const nn = (getState().dialog?.input ?? '').trim();
        if (!nn || nn === name) return;
        const other = all.find((a) => low(a.name) === low(nn) && a.name !== name);
        const go = async () => {
          try {
            const n = await api.renameArtist(name, other?.name ?? nn);
            if (getState().view.kind === 'artist') navigate({ kind: 'artist', name: other?.name ?? nn });
            await after(other ? tr('Исполнители объединены ({0} тр.)', n) : tr('Переименовано: {0} тр.', n));
          } catch (e) { toast(tr('Не удалось: ') + e); }
        };
        if (other) {
          // merging is irreversible in one click — confirm explicitly
          setTimeout(() => setState({
            dialog: {
              title: tr('Объединить исполнителей?'), text: tr('«{0}» уже есть в медиатеке ({1} тр.). Треки «{2}» перейдут к нему, и исполнитель будет один.', other.name, other.tracks, name),
              ok: tr('Объединить'), danger: true, onOk: go,
            },
          }), 0);
        } else await go();
      },
    },
  });
}
// the rename dialog uses `input`, so the merge hint is shown as text
export const MERGE_HINT = 'Если ввести имя уже существующего исполнителя, они объединятся.';

/** Pick an image, crop the centre square to 600 px JPEG. */
export function pickSquareJpeg(size = 600): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      try {
        const bmp = await createImageBitmap(f);
        const side = Math.min(bmp.width, bmp.height);
        const cv = document.createElement('canvas');
        cv.width = cv.height = Math.min(size, side);
        const g = cv.getContext('2d')!;
        g.imageSmoothingQuality = 'high';
        g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, cv.width, cv.height);
        bmp.close();
        const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/jpeg', 0.88));
        resolve(blob ? new Uint8Array(await blob.arrayBuffer()) : null);
      } catch (e) { toast(tr('Не удалось открыть картинку: ') + e); resolve(null); }
    };
    inp.click();
  });
}

export async function setArtistPhoto(name: string) {
  const jpeg = await pickSquareJpeg(600);
  if (!jpeg) return;
  try {
    await api.setArtistPhoto(name, Array.from(jpeg));
    setState((s) => ({ photoRev: s.photoRev + 1 }));
    toast(tr('Фото исполнителя установлено'));
  } catch (e) { toast(tr('Не удалось: ') + e); }
}

export async function removeArtistPhoto(name: string) {
  await api.setArtistPhoto(name, null).catch(() => {});
  setState((s) => ({ photoRev: s.photoRev + 1 }));
}

/** "Редактировать" submenu for a single track. Phones also get the cover photo here. */
export function editMenu(t: Track, o: { cover?: boolean; customCover?: boolean } = {}): MenuItem {
  return {
    label: tr('Редактировать'),
    sub: [
      { label: tr('Переименовать трек…'), onClick: () => renameTrackDialog(t) },
      { label: tr('Тэги…'), onClick: () => setState({ genreEdit: [t] }) },
      { label: tr('Поменять местами исполнителя и название'), onClick: () => swapArtistTitle(t) },
      { label: tr('Переименовать исполнителя везде…'), onClick: () => renameArtistDialog(t.artist) },
      ...(o.cover ? [
        { label: isMobile ? tr('Заменить обложку фото…') : tr('Заменить обложку картинкой…'), onClick: () => import('../mobile/photo').then((m) => m.pickCover(t.album_id)) },
        ...(o.customCover ? [{ label: tr('Вернуть исходную обложку'), onClick: () => import('../mobile/photo').then((m) => m.resetCover(t.album_id)) }] : []),
      ] : []),
    ],
  };
}

export function artistMenu(name: string, hasPhoto: boolean): MenuItem[] {
  return [
    { label: tr('Установить фото…'), onClick: () => setArtistPhoto(name) },
    ...(hasPhoto ? [{ label: tr('Убрать фото'), onClick: () => removeArtistPhoto(name) }] : []),
    { sep: true, label: '' },
    { label: tr('Переименовать исполнителя…'), onClick: () => renameArtistDialog(name) },
  ];
}
