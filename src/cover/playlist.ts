/** Own pictures for playlists (phone and desktop). */
import { isMobile } from '../app/platform';
import { pickSquareJpeg } from '../core/names';
import { playlistCover, setPlaylistCover } from '../core/extras';
import { toast } from '../app/store';
import { t } from '../i18n';

const b64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

export async function pickPlaylistCover(id: number) {
  const jpeg = await pickSquareJpeg(500);
  if (!jpeg) return;
  try {
    if (isMobile) {
      const { native } = await import('../mobile/native');
      const old = playlistCover(id);
      const { path } = await native.plugin.saveImage({ name: `playlist_${id}_${Date.now()}.jpg`, data: b64(jpeg) });
      setPlaylistCover(id, path);
      if (old && !old.startsWith('data:')) native.plugin.deleteFile({ path: old }).catch(() => {});
    } else setPlaylistCover(id, 'data:image/jpeg;base64,' + b64(jpeg));
    toast(t('Обложка плейлиста установлена'));
  } catch (e) { toast(t('Не удалось: ') + e); }
}

export async function resetPlaylistCover(id: number) {
  const old = playlistCover(id);
  setPlaylistCover(id, null);
  if (isMobile && old && !old.startsWith('data:')) (await import('../mobile/native')).native.plugin.deleteFile({ path: old }).catch(() => {});
}

/** URL to show, or '' when the playlist uses a generated cover. */
export function playlistCoverUrl(id: number): string {
  const v = playlistCover(id);
  if (!v) return '';
  if (v.startsWith('data:')) return v;
  const cap = (window as unknown as { Capacitor?: { convertFileSrc?: (p: string) => string } }).Capacitor;
  return cap?.convertFileSrc?.(v) ?? v;
}
