import { defaultSettings } from './store';
// Browser-only mock backend (used when the UI runs outside Tauri, e.g. for design review).
import type { Album, Lyrics, PlayerState, Track, CoverRecipe } from '../core/types';
import { legacyMotif } from '../cover/draw';

type Cb = (p: unknown) => void;
const listeners = new Map<string, Set<Cb>>();
const emit = (e: string, p: unknown) => listeners.get(e)?.forEach((cb) => cb(p));

const rec = (seed: number, palette = 'ambient'): CoverRecipe => ({ seed, motif: legacyMotif(seed), palette, energy: 0.5, bpm: 100, bright: 0.5, valence: 0.5 });

const T: [string, string, string, boolean][] = [
  ['Low Tide', '4:12', 'FLAC 24/96', true], ['Glass Tides', '5:02', 'FLAC 24/96', true], ['Salt & Static', '3:48', 'FLAC 24/96', true],
  ['Undertow', '6:20', 'FLAC 24/96', true], ['Paper Moons', '4:01', 'FLAC 16/44', false], ['Where It Is Quiet', '5:33', 'FLAC 24/96', true],
  ['Mirror Lake', '3:57', 'FLAC 24/96', true], ['Driftwood', '4:44', 'MP3 320', false], ['Last Light', '6:05', 'FLAC 24/96', true],
];
const sec = (s: string) => { const [m, x] = s.split(':').map(Number); return m * 60 + x; };

const albums: Album[] = [
  { id: 1, title: 'Shallow Light', artist: 'Northern Lumen', year: 2023, genre: 'Ambient, Downtempo', tracks: 9, dur: 41 * 60 + 22, cover: null, cover_name: '', recipe: rec(1203), history: [rec(1203), rec(88), rec(4519), rec(301)], added: 5 },
];
const names = ['Coastline Memory', 'Polar Drift', 'Signal Garden', 'Lantern Field', 'Night Ferry', 'Velvet Static', 'Cold Harbour', 'Moss & Iron', 'Blue Hours', 'Subsurface', 'Paper Planets', 'Long Exposure'];
const artistsN = ['Northern Lumen', 'Kaito Mori', 'Fen Ward', 'Ola Brightwater', 'Tessellate', 'Sundial Club'];
const genres = ['Ambient', 'Techno', 'Folk', 'Electronic', 'Jazz', 'Indie Rock', 'Synthwave', 'Downtempo', 'Classical', 'Hip-Hop', 'Post-Rock', 'Lo-Fi'];
const pals = ['ambient', 'techno', 'folk', 'electronic', 'jazz', 'indie', 'synthwave', 'downtempo', 'classical', 'hiphop', 'postrock', 'lofi'];
names.forEach((n, i) => albums.push({ id: i + 2, title: n, artist: artistsN[i % artistsN.length], year: 2014 + (i % 10), genre: genres[i], tracks: 8 + (i % 5), dur: 2400 + i * 97, cover: null, cover_name: '', recipe: rec(500 + i * 37, pals[i]), history: [], added: i }));

const tracks: Track[] = [];
albums.forEach((a) => {
  const list = a.id === 1 ? T : Array.from({ length: a.tracks }, (_, k) => [`Track ${k + 1}`, `${3 + (k % 4)}:${(10 + k * 7) % 60}`.replace(/:(\d)$/, ':0$1'), k % 3 ? 'FLAC 16/44' : 'FLAC 24/96', k % 3 === 0] as [string, string, string, boolean]);
  list.forEach((t, k) => {
    const [codec, br] = t[2].split(' ');
    const [bits, rate] = br.includes('/') ? br.split('/').map(Number) : [0, 44];
    tracks.push({ id: tracks.length + 1, path: `D:\\Music\\${a.artist}\\${a.title}\\${k + 1}.flac`, title: t[0], artist: a.artist, album: a.title, album_id: a.id, disc: 1, no: k + 1, dur: sec(t[1]),
      codec, bits, rate: rate === 44 ? 44100 : rate * 1000, kbps: codec === 'MP3' ? 320 : 0, lossless: codec !== 'MP3', genre: a.genre, year: a.year, fav: k === 1 && a.id === 1 });
  });
});

const lyr: Lyrics = { kind: 'synced', source: 'LRCLIB', lines: [
  { t: 120, text: 'и свет уходит в воду' }, { t: 128, text: 'медленно, как будто знает путь' }, { t: 140, text: 'туда, где тише' },
  { t: 148, text: 'туда, где нас не ждут' }, { t: 158, text: 'и тени тают' }, { t: 170, text: 'в отражении стекла' }, { t: 182, text: 'и тишина' }] };

const st: PlayerState = { track: tracks[1], playing: true, pos: 134, dur: 302, volume: 0.65, muted: false, shuffle: true, repeat: 'off', queue: tracks.slice(0, 9).map((t) => t.id), index: 1, output: 'FLAC 24/96', error: null };
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  if (st.playing && !new URLSearchParams(location.search).has('still')) {
    st.pos += (now - last) / 1000;
    if (st.pos >= st.dur) { st.index = (st.index + 1) % st.queue.length; setTrack(); }
    emit('player:pos', { pos: st.pos });
  }
  last = now;
}, 250);
function setTrack() { st.track = tracks.find((t) => t.id === st.queue[st.index]) ?? null; st.pos = 0; st.dur = st.track?.dur ?? 0; st.output = st.track ? fmt(st.track) : ''; emit('player:state', { ...st }); }
const fmt = (t: Track) => (t.lossless ? `${t.codec} ${t.bits}/${Math.round(t.rate / 1000)}` : `${t.codec} ${t.kbps}`);

const settings: Record<string, unknown> = defaultSettings() as unknown as Record<string, unknown>;
{ const th = new URLSearchParams(location.search).get('theme'); if (th) settings.theme = th; } // design review: ?theme=apple

const photos: Record<string, string> = {};
const review: Record<number, boolean> = { 3: false, 7: true };
const handlers: Record<string, (a: any) => unknown> = {
  stats: () => ({ albums: 186, artists: 94, tracks: 2418, favs: 212 }),
  albums: () => albums,
  recent_albums: () => albums.slice(0, 8),
  album: (a) => albums.find((x) => x.id === a.id) ?? null,
  album_tracks: (a) => tracks.filter((t) => t.album_id === a.id),
  artists: () => artistsN.map((n) => ({ name: n, albums: albums.filter((a) => a.artist === n).length, tracks: tracks.filter((t) => t.artist === n).length, album_id: albums.find((a) => a.artist === n)!.id, album_title: albums.find((a) => a.artist === n)!.title, cover: null, recipe: albums.find((a) => a.artist === n)!.recipe, genre: '' })),
  artist_albums: (a) => albums.filter((x) => x.artist === a.name),
  tracks: () => tracks,
  favorites: () => tracks.filter((t) => t.fav),
  search: (a) => { const q = String(a.q).toLowerCase(); return { tracks: tracks.filter((t) => (t.title + t.artist + t.album).toLowerCase().includes(q)).slice(0, 50), albums: albums.filter((x) => (x.title + x.artist).toLowerCase().includes(q)), artists: [] }; },
  set_fav: (a) => { const t = tracks.find((x) => x.id === a.id); if (t) t.fav = a.fav; },
  set_album_fav: () => undefined,
  folders: () => ['D:\\Music'],
  add_folder: () => undefined, remove_folder: () => undefined, rescan: () => undefined,
  scan_status: () => ({ state: 'idle', done: 0, total: 0, message: '' }),
  playlists: () => [{ id: 1, name: 'Ночной код', tracks: 24, album_id: 0, recipe: rec(21, 'ambient') }, { id: 2, name: 'Lo-fi FLAC', tracks: 31, album_id: 0, recipe: rec(5, 'techno') }, { id: 3, name: 'Дорога', tracks: 18, album_id: 0, recipe: rec(9, 'folk') }, { id: 4, name: 'Hi-Res', tracks: 40, album_id: 0, recipe: rec(14, 'ambient') }],
  create_playlist: () => 5, delete_playlist: () => undefined, rename_playlist: () => undefined,
  playlist_tracks: () => tracks.slice(0, 12), add_to_playlist: () => undefined, remove_from_playlist: () => undefined,
  play_mix: (a) => { st.queue = a.order; st.index = 0; st.playing = true; st.shuffle = true; setTrack(); },
  album_genres: () => [],
  rename_track: (a) => { const t = tracks.find((x) => x.id === a.id); if (t) { if (a.title) t.title = a.title; if (a.artist) t.artist = a.artist; if (a.album) t.album = a.album; delete review[t.id]; } emit('library', null); },
  swap_artist_title: (a) => { const t = tracks.find((x) => x.id === a.id); if (t) { [t.title, t.artist] = [t.artist, t.title]; delete review[t.id]; } emit('library', null); },
  rename_artist: (a) => { let n = 0; for (const t of tracks) if (t.artist === a.old) { t.artist = a.new; n++; } for (const x of albums) if (x.artist === a.old) x.artist = a.new; const i = artistsN.indexOf(a.old); if (i >= 0) artistsN[i] = a.new; emit('library', null); return n; },
  set_artist_photo: (a) => { if (a.jpeg) photos[a.name] = URL.createObjectURL(new Blob([new Uint8Array(a.jpeg)], { type: 'image/jpeg' })); else delete photos[a.name]; },
  artist_photo: (a) => photos[a.name] ?? null,
  names_to_review: () => Object.entries(review).map(([id, sw]) => [+id, 1, sw]),
  play_queue: (a) => { st.queue = a.trackIds; st.index = a.index; st.playing = true; setTrack(); },
  enqueue: (a) => { st.queue.push(...a.trackIds); emit('player:state', { ...st }); },
  toggle: () => { st.playing = !st.playing; emit('player:state', { ...st }); },
  next: () => { st.index = (st.index + 1) % st.queue.length; setTrack(); },
  prev: () => { st.index = Math.max(0, st.index - 1); setTrack(); },
  jump: (a) => { st.index = a.index; setTrack(); },
  remove_from_queue: (a) => { st.queue.splice(a.index, 1); emit('player:state', { ...st }); },
  seek: (a) => { st.pos = a.pos; emit('player:pos', { pos: st.pos }); },
  set_volume: (a) => { st.volume = a.v; emit('player:state', { ...st }); },
  set_muted: (a) => { st.muted = a.m; emit('player:state', { ...st }); },
  set_shuffle: (a) => { st.shuffle = a.on; emit('player:state', { ...st }); },
  set_repeat: (a) => { st.repeat = a.mode; emit('player:state', { ...st }); },
  player_state: () => ({ ...st }),
  queue_tracks: () => st.queue.map((id) => tracks.find((t) => t.id === id)!),
  devices: () => ['Динамики (Realtek High Definition Audio)', 'Наушники (USB DAC)'],
  lyrics: (a) => (a.id === 2 ? lyr : { kind: 'none', lines: [], source: '' }),
  lyrics_candidates: () => [], pick_lyrics: () => lyr, save_lrc: () => '',
  analyze_album: () => ({ genre: 'Ambient', energy: 0.4, bpm: 90, bright: 0.5, valence: 0.5 }),
  set_recipe: (a) => { const al = albums.find((x) => x.id === a.albumId); if (al) { al.recipe = a.recipe; al.history = a.history; } },
  use_real_cover: () => undefined, embed_cover: () => 9, save_gen_cover: () => undefined,
  settings: () => ({ ...settings }),
  level_stats: () => ({ done: 7, total: 12 }),
  set_settings: (a) => Object.assign(settings, a.patch),
  show_window: () => undefined, reveal_file: () => undefined,
  discord_status: () => ((settings.discord as { enabled: boolean }).enabled ? 'Подключено · demo' : 'Выключено'),
  discord_preview: () => null,
  clear_cache: () => undefined, hide_to_tray: () => undefined, restart_app: () => location.reload(),
  app_info: () => ({ version: '1.9.0 (preview)', data: 'C:\\Users\\you\\AppData\\Local\\Teto Player' }),
  has_custom_cover: () => false,
  delete_tracks: (a) => { for (const id of a.trackIds as number[]) { const i = tracks.findIndex((t) => t.id === id); if (i >= 0) tracks.splice(i, 1); } emit('library', null); },
  import_files: () => undefined,
  scan_device: () => ({ items: [
    { uri: 'content://1', name: 'Кино - Звезда по имени Солнце.mp3', size: 7340032, dur: 225, artist: 'Кино', title: 'Звезда по имени Солнце', folder: 'Telegram Audio' },
    { uri: 'content://2', name: 'voice_0412.ogg', size: 120000, dur: 14, artist: '', title: 'voice_0412', folder: 'Recordings' },
  ], unsupported: false }),
  import_uris: () => undefined,
  open_url: (a) => { window.open(a.url, '_blank'); },
  reprocess: () => new Promise((r) => setTimeout(r, 800)),
  // preview: fake search results and a download that "progresses" for a few seconds
  yt_search: (a) => { const q = String(a.q || 'song'); const src = ['youtube', 'vk', 'soundcloud', 'youtube', 'soundcloud', 'vk'] as const; return [0, 1, 2, 3, 4, 5].map((i) => ({ url: `https://example.com/${i}`, title: `${q} ${i ? '(Live)' : ''}`.trim(), artist: ['Northern Lumen', 'Sundial Club', 'Mira K.'][i % 3], dur: 180 + i * 17, thumb: '', source: src[i], song: i < 2, album: i < 2 ? 'Night Drive' : undefined })); },
  vk_status: () => ({ connected: false, name: '' }),
  vk_login: () => ({ connected: true, name: 'Preview User' }),
  vk_logout: () => null,
  yt_download: (a) => {
    const id = String(a.id);
    let p = 0;
    emit('dl', { id, state: 'running', progress: 0, message: 'Подготовка…' });
    const iv = setInterval(() => {
      p += 0.17;
      if (p >= 1) { clearInterval(iv); emit('dl', { id, state: 'done', progress: 1, message: 'Готово · в медиатеке', title: a.title, artist: a.artist }); return; }
      emit('dl', { id, state: 'running', progress: p, message: `Скачиваю ${Math.round(p * 100)}%` });
    }, 600);
    return undefined;
  },
  dl_cancel: () => undefined,
  // desktop extras (preview): now-playing API status, custom covers, the HTTPS proxy is not available here
  api_status: () => ({ running: !!(settings.api as { enabled?: boolean } | undefined)?.enabled, message: 'preview', port: 7710, clients: 0, pipe: '\\\\.\\pipe\\teto-player', files: 'C:\\Users\\you\\AppData\\Local\\Teto Player\\nowplaying' }),
  api_new_token: () => { settings.api = { ...(settings.api as object), token: Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14) }; return { ...settings }; },
  set_custom_cover: () => undefined, reset_cover: () => undefined,
  net_http: () => { throw new Error('preview: no network proxy'); },
  dl_engine: () => ({ ready: true, updating: false, version: '2026.09.30 (preview)', error: '' }),
  dl_update: () => ({ version: '2026.09.30 (preview)' }),
  listen_reset: () => undefined,
  save_png: () => undefined,
  listen_first: () => '2026-01-01',
  // demo listening log: a few songs every day, more in the evening (deterministic per month)
  listen_log: (a) => {
    const out = []; let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let d = new Date(a.from + 'T12:00:00'); d.toISOString().slice(0, 10) < a.to; d.setDate(d.getDate() + 1)) {
      if (rnd() < 0.15) continue;
      const day = d.toISOString().slice(0, 10);
      for (let k = 0; k < 4 + Math.floor(rnd() * 8); k++) {
        const tr = tracks[Math.floor(Math.pow(rnd(), 2.2) * tracks.length)];
        const h = [8, 13, 19, 21, 22, 23, 1][Math.floor(rnd() * 7)];
        out.push({ d: day, h, id: tr.id, s: tr.dur * (0.6 + rnd() * 0.4), p: 1, k: rnd() < 0.1 ? 1 : 0, title: tr.title, artist: tr.artist, album: tr.album, album_id: tr.album_id, genre: tr.genre, dur: tr.dur });
      }
    }
    return out;
  },
  album_tracklist: (a) => { const al = albums.find((x) => x.title === a.album); if (!al) return null; const own = tracks.filter((t) => t.album_id === al.id); return { album: al.title, tracks: [...own.map((t) => ({ no: t.no, disc: 1, title: t.title, dur: t.dur })), { no: own.length + 1, disc: 1, title: 'Бонус-трек (демо)', dur: 201 }, { no: own.length + 2, disc: 1, title: 'Ещё одна песня', dur: 187 }] }; },
  levels: () => Array.from({ length: 24 }, (_, i) => Math.max(0, Math.sin(performance.now() / (180 + i * 13) + i) * 0.5 + 0.35 - i * 0.008) * (st.playing ? 1 : 0)),
};

export const mock = {
  call: async (cmd: string, args?: Record<string, unknown>) => {
    const h = handlers[cmd];
    if (!h) throw new Error('mock: no handler ' + cmd);
    return structuredClone(h(args ?? {}));
  },
  on: async (event: string, cb: Cb) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb);
    return () => listeners.get(event)!.delete(cb);
  },
  coverUrl: (_id: number, _size: number) => '',
  pickFolder: async () => 'D:\\Music',
};
