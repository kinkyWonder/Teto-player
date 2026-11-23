import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle, type PluginListenerHandle } from '@capacitor/core';

/** A file imported into the app's private storage, with tags read natively (MediaMetadataRetriever). */
export interface NativeTrack {
  path: string; name: string; size: number;
  title: string; artist: string; album: string; albumArtist: string; genre: string;
  year: number; no: number; disc: number; dur: number; mime: string; kbps: number; rate: number; bits: number;
  cover: string; // extracted embedded picture (jpeg path) or ''
  force?: boolean; // downloaded from an album page: these names are final (go into that album)
}
export interface DeviceAudio { uri: string; name: string; size: number; dur: number; artist: string; title: string; folder: string }
export interface SessionInfo { title: string; artist: string; album: string; art: string; playing: boolean; pos: number; dur: number }
export type MediaAction = 'play' | 'pause' | 'toggle' | 'next' | 'prev' | 'stop' | 'seek';

interface TetoPlugin {
  pickAudio(): Promise<void>;
  listMusic(): Promise<{ files: { path: string; size: number }[] }>;
  probe(o: { paths: string[] }): Promise<{ tracks: NativeTrack[] }>;
  deleteFile(o: { path: string }): Promise<void>;
  saveImage(o: { name: string; data: string }): Promise<{ path: string }>;
  session(o: SessionInfo): Promise<void>;
  stopSession(): Promise<void>;
  /** Android: every audio file in MediaStore at least `minMs` long (needs the audio permission). */
  scanDevice(o: { minMs: number }): Promise<{ items: DeviceAudio[] }>;
  /** Copies content:// files into the app (emits importing / imported like the share sheet). */
  importUris(o: { uris: string[] }): Promise<void>;
  openUrl(o: { url: string }): Promise<void>;
  /** Share a PNG (base64, no data: prefix) through the system share sheet. */
  shareImage(o: { data: string; name: string; title?: string }): Promise<void>;
  /** "Download" (yt-dlp + FFmpeg, as in Dot Player): YouTube + SoundCloud search. */
  ytSearch(o: { q: string }): Promise<{ items: { artist: string; title: string; url: string; dur: number; thumb: string; source: string }[] }>;
  /** Starts downloading a search result / link as MP3; progress → "dl" events, the file → "imported". */
  ytDownload(o: { id: string; url: string; artist: string; title: string; kbps: number; source?: string; thumb?: string; songAlbum?: string; album?: string; albumArtist?: string; no?: number; disc?: number; year?: number }): Promise<void>;
  dlCancel(o: { id: string }): Promise<void>;
  /** VK ID login window → VK Music token (Kate Mobile client). */
  vkLogin(): Promise<{ token: string; user: string }>;
  dlEngine(): Promise<{ ready: boolean; updating: boolean; version: string; error: string }>;
  /** iPhone downloads: writes (append = add to) a temporary file from base64; returns its path. */
  writeChunk(o: { name: string; data: string; append: boolean }): Promise<{ path: string }>;
  /** iPhone downloads: moves the temporary file into the library folder under this name (made unique). */
  finishFile(o: { tmp: string; name: string }): Promise<{ path: string }>;
  dlUpdate(): Promise<{ version: string }>;
  info(): Promise<{ version: string; storage: string; free: number }>;
  addListener(e: 'imported', f: (x: { tracks: NativeTrack[]; failed: number }) => void): Promise<PluginListenerHandle>;
  addListener(e: 'dl', f: (x: { id: string; state: string; progress: number; message: string; title?: string; artist?: string }) => void): Promise<PluginListenerHandle>;
  addListener(e: 'sharedText', f: (x: { text: string }) => void): Promise<PluginListenerHandle>;
  addListener(e: 'importing', f: (x: { done: number; total: number }) => void): Promise<PluginListenerHandle>;
  addListener(e: 'media', f: (x: { action: MediaAction; pos?: number }) => void): Promise<PluginListenerHandle>;
  addListener(e: 'focus', f: (x: { type: 'loss' | 'transient' | 'duck' | 'gain' | 'noisy' }) => void): Promise<PluginListenerHandle>;
}

const Teto = registerPlugin<TetoPlugin>('Teto');

export const native = {
  plugin: Teto,
  fileUrl: (path: string) => Capacitor.convertFileSrc(path),
  immersive(on: boolean) {
    (on ? SystemBars.hide() : SystemBars.show()).catch(() => {});
  },
  barsFor(light: boolean) {
    SystemBars.setStyle({ style: light ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(() => {});
  },
};
