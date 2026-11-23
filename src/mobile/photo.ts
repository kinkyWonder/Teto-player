import { api, bumpCover, call } from '../app/api';
import { getState, setState, toast } from '../app/store';
import { t } from '../i18n';

async function refreshAlbum(albumId: number) {
  const al = await api.album(albumId);
  if (getState().currentAlbum?.id === albumId) setState({ currentAlbum: al });
}

/** Pick a photo from the gallery (desktop: any picture file), crop the centre square, save as the album cover. */
export function pickCover(albumId: number) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const S = 900, side = Math.min(bmp.width, bmp.height);
      const cv = document.createElement('canvas');
      cv.width = cv.height = Math.min(S, side);
      const g = cv.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, cv.width, cv.height);
      bmp.close();
      const data = cv.toDataURL('image/jpeg', 0.88).split(',')[1];
      await call('set_custom_cover', { albumId, data });
      bumpCover(albumId);
      setState((s) => ({ coverRev: s.coverRev + 1 }));
      await refreshAlbum(albumId);
      toast(t('Обложка заменена'));
    } catch (e) { toast(t('Не удалось открыть фото: ') + e); }
  };
  inp.click();
}

export async function resetCover(albumId: number) {
  await call('reset_cover', { albumId });
  bumpCover(albumId);
  setState((s) => ({ coverRev: s.coverRev + 1 }));
  await refreshAlbum(albumId);
}
