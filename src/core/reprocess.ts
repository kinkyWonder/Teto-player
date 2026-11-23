/**
 * Settings → "Reprocess all files": covers of albums without a real picture are generated again, every song is
 * read and its names parsed again, genres (tags) are looked up again. Manual edits — renames, own covers,
 * own tags, favourites, playlists — are kept. The heavy part runs in the backend (Rust scanner / phone backend).
 */
import { call } from '../app/api';
import { getState, setState } from '../app/store';
import { refreshLibrary } from '../app/actions';
import { clearGenCovers } from '../cover/gen';
import { forgetAnalysis } from '../cover/actions';

export async function reprocessAll(): Promise<void> {
  await clearGenCovers();
  forgetAnalysis();
  setState({ rov: {}, hov: {}, coverRev: Date.now(), currentAlbum: getState().currentAlbum ? { ...getState().currentAlbum!, recipe: null, history: [] } : null });
  await call('reprocess', {});
  await refreshLibrary();
}
