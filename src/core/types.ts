export interface Track {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  album_id: number;
  disc: number;
  no: number;
  dur: number;
  codec: string;
  bits: number;
  rate: number;
  kbps: number;
  lossless: boolean;
  genre: string;
  year: number;
  fav: boolean;
  missing?: boolean;
}

export interface Album {
  id: number;
  title: string;
  artist: string;
  year: number;
  genre: string;
  tracks: number;
  dur: number;
  cover: 'file' | 'folder' | 'custom' | null; // real cover source ('custom' = a picture chosen by the user), null => generated
  cover_name: string; // e.g. cover.jpg for folder covers
  recipe: CoverRecipe | null; // chosen generated cover
  history: CoverRecipe[];
  added: number;
}

export interface Artist { name: string; albums: number; tracks: number; album_id: number; album_title: string; cover: 'file' | 'folder' | 'custom' | null; recipe: CoverRecipe | null; genre: string }

export interface Playlist { id: number; name: string; tracks: number; album_id: number; recipe?: CoverRecipe | null }

export interface Stats { albums: number; artists: number; tracks: number; favs: number }

export interface ScanStatus { state: 'idle' | 'scanning' | 'error'; done: number; total: number; message: string }

export interface CoverRecipe {
  seed: number;
  motif: number;
  palette: string;
  energy: number; // 0..1
  bpm: number;
  bright: number; // 0..1
  valence: number; // 0..1
  sym?: string; // v3: picture symbol (moon, sun, heart…)
  style?: string; // v4: "viz:<scene>" = a still frame of a 3D-visualizer scene; absent = 2D artwork
}

export type Repeat = 'off' | 'all' | 'one';

export interface PlayerState {
  track: Track | null;
  playing: boolean;
  pos: number;
  dur: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  queue: number[];
  index: number;
  output: string; // e.g. "FLAC 24/96"
  error: string | null;
}

export interface LyricLine { t: number; text: string }
export interface Lyrics {
  kind: 'synced' | 'plain' | 'none' | 'error';
  lines: LyricLine[];
  source: string; // "Из тегов" | ".lrc" | "LRCLIB" | ...
  message?: string;
}

export interface Settings {
  offline: boolean;
  replaygain: 'off' | 'track' | 'album';
  eq_on: boolean;
  eq: number[]; // 10 bands, dB
  eq_preset: string;
  device: string; // '' = default
  show_np: boolean;
  theme: string;
  anim: 'full' | 'reduced' | 'off';
  anim_speed: number;
  glow: boolean;
  blur: boolean;
  ui_scale: number;
  lyrics_size: number;
  visualizer: boolean;
  cover_quality: 'high' | 'fast';
  gpu: boolean;
  close_to_tray: boolean;
  start_minimized: boolean;
  autostart: boolean;
  low_power_tray: boolean;
  resume_on_start: boolean;
  remember_pos: boolean;
  xf_mode: number;
  xf_ms: number;
  xf_keep_album: boolean;
  fade_ms: number;
  skip_fade: boolean;
  auto_gen: boolean;
  bg_analysis: boolean;
  web_genres: boolean;
  write_protect: boolean;
  discord: DiscordCfg;
  /** desktop: «Трансляция для других программ» — local now-playing API (docs/API.md) */
  api?: ApiCfg;
}

export interface ApiCfg {
  enabled: boolean;
  port: number;
  files: boolean;
  pipe: boolean;
  control: boolean;
  allow_web: boolean;
  token: string;
}

export interface DiscordCfg {
  enabled: boolean;
  client_id: string;
  details: string;
  state: string;
  large_text: string;
  large_image: 'itunes' | 'asset' | 'none';
  asset_key: string;
  small: 'state' | 'none';
  play_key: string;
  pause_key: string;
  timestamps: 'progress' | 'elapsed' | 'none';
  paused: 'show' | 'clear';
  status_display: number;
  buttons: { label: string; url: string }[];
  idle_min: number;
}

export interface SearchResult { tracks: Track[]; albums: Album[]; artists: Artist[] }
