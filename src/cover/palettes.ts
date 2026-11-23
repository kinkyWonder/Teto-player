// genre -> palette [bg0, bg1, accent1, accent2, accent3]. All share the cold mint base of the app;
// only the accents change. Also exported as genre_palettes.json for the backend/designers.
export const PALETTES: Record<string, string[]> = {
  ambient: ['#06171a', '#0b2a30', '#5ff2d0', '#2a7fd6', '#1b8f8a'],
  downtempo: ['#07161b', '#0d2b33', '#56d6f0', '#3fae9a', '#2a6fd6'],
  chillout: ['#071619', '#0c2a2d', '#7ff0d8', '#4bb7e6', '#2e8c8f'],
  lofi: ['#0b1418', '#1a2a30', '#a4e8d6', '#c7a6e6', '#4f8f9a'],
  electronic: ['#081320', '#0f2a3f', '#56d6f0', '#5ff2d0', '#4a62e0'],
  techno: ['#0a1222', '#132a44', '#56d6f0', '#6a7dff', '#1e4f80'],
  house: ['#0b1220', '#1a2448', '#5ff2d0', '#a77bff', '#2f6fe0'],
  trance: ['#08122a', '#11265a', '#6ad8ff', '#8f6bff', '#2fd6c8'],
  dnb: ['#0a1018', '#14283a', '#6ff7c8', '#2fb6ff', '#d04aa8'],
  dubstep: ['#0c0f1c', '#1c2140', '#8b6bff', '#56d6f0', '#ff4f9a'],
  synthwave: ['#120c22', '#28164a', '#ff5fa8', '#56d6f0', '#8f5bff'],
  idm: ['#081418', '#122a30', '#cfeff0', '#56d6f0', '#7d6bff'],
  experimental: ['#0b1214', '#1c2a2c', '#e4f4f1', '#5ff2d0', '#c76bd8'],
  classical: ['#0e1514', '#22302c', '#e8e0c8', '#9be8c8', '#b9a06a'],
  soundtrack: ['#0a1216', '#1b2c34', '#a8d8e8', '#5ff2d0', '#d0b47a'],
  jazz: ['#11140f', '#2a2a1c', '#e0b870', '#5ff2d0', '#b46a4a'],
  blues: ['#0a1020', '#152446', '#4a7fd6', '#56d6f0', '#c79a5a'],
  soul: ['#140f12', '#2e1f26', '#e09a6a', '#5ff2d0', '#c76b7a'],
  rnb: ['#120f1a', '#2a1f3a', '#c78aff', '#5ff2d0', '#ff8aa8'],
  funk: ['#14100c', '#33241a', '#ffb45a', '#5ff2d0', '#ff6a8a'],
  hiphop: ['#0f1012', '#26262c', '#f0d06a', '#5ff2d0', '#e06a4a'],
  rap: ['#0e0f12', '#24252c', '#ff8a5a', '#56d6f0', '#d0d0d0'],
  pop: ['#0e1220', '#22284a', '#ff8ac8', '#5ff2d0', '#8ab0ff'],
  indie: ['#0d1514', '#20302c', '#c8e88a', '#5ff2d0', '#e0a0a0'],
  rock: ['#0d1216', '#232c34', '#b8c8d4', '#e04a4a', '#5f8fa8'],
  alternative: ['#0e1316', '#24302f', '#9fd8c8', '#d06a5a', '#6a8fb0'],
  punk: ['#120d10', '#2c1a20', '#ff4a6a', '#5ff2d0', '#f0e06a'],
  metal: ['#0a0c0e', '#1c2024', '#9aa4ac', '#c83a3a', '#4a5a6a'],
  postrock: ['#0a1416', '#1a2e32', '#b0d8e0', '#5ff2d0', '#7a8fb0'],
  shoegaze: ['#120f1c', '#2a2440', '#e0b0ff', '#8ad8f0', '#ff9ac8'],
  folk: ['#0d1714', '#203c33', '#9be8c8', '#e0c58a', '#3f8f73'],
  acoustic: ['#0f1612', '#25352a', '#c8e0a0', '#e0c58a', '#5ff2d0'],
  country: ['#14120c', '#30291a', '#e0c070', '#9be8c8', '#c0804a'],
  reggae: ['#0c140e', '#1c3020', '#6ae08a', '#f0d05a', '#e05a4a'],
  latin: ['#140e0c', '#33201a', '#ff9a5a', '#5ff2d0', '#ff5a8a'],
  world: ['#10140e', '#2a3020', '#d8c070', '#5ff2d0', '#c0705a'],
  newage: ['#08161a', '#123036', '#a0f0e0', '#c0b0ff', '#5ff2d0'],
  vocal: ['#0e1418', '#22303a', '#d8e8f0', '#5ff2d0', '#c8a0d8'],
  default: ['#06171a', '#0b2a30', '#5ff2d0', '#2a7fd6', '#1b8f8a'],
  // "Pick me" theme: every generated cover turns bubblegum pink
  pickme: ['#ff9ccc', '#ff6fb5', '#ffd3ea', '#ff3d9a', '#ffc2e2'],
};

const KEYS: [RegExp, string][] = [
  [/ambient|drone|эмбиент/, 'ambient'],
  [/down ?tempo|trip.?hop/, 'downtempo'],
  [/chill|lounge/, 'chillout'],
  [/lo.?fi/, 'lofi'],
  [/drum.?(n|and|&).?bass|dnb|jungle|breakbeat/, 'dnb'],
  [/dubstep|bass music|grime/, 'dubstep'],
  [/techno|minimal|industrial/, 'techno'],
  [/house|garage|disco/, 'house'],
  [/trance|psy/, 'trance'],
  [/synth.?wave|retro.?wave|outrun|vapor/, 'synthwave'],
  [/idm|glitch/, 'idm'],
  [/electro|edm|dance|electronica|электрон/, 'electronic'],
  [/experimental|avant|noise/, 'experimental'],
  [/classical|baroque|orchestr|opera|piano|chamber|классик/, 'classical'],
  [/soundtrack|score|ost|cinematic|game/, 'soundtrack'],
  [/jazz|bebop|swing|fusion|джаз/, 'jazz'],
  [/blues/, 'blues'],
  [/soul|gospel/, 'soul'],
  [/r&b|rnb|r'n'b|rhythm/, 'rnb'],
  [/funk/, 'funk'],
  [/hip.?hop|trap|boom.?bap/, 'hiphop'],
  [/rap|рэп/, 'rap'],
  [/post.?rock|math.?rock/, 'postrock'],
  [/shoegaze|dream.?pop/, 'shoegaze'],
  [/punk|hardcore|emo/, 'punk'],
  [/metal|metalcore|doom|black|death/, 'metal'],
  [/alternative|grunge|альтерн/, 'alternative'],
  [/indie|инди/, 'indie'],
  [/rock|рок/, 'rock'],
  [/pop|поп|k-pop|j-pop/, 'pop'],
  [/folk|фолк/, 'folk'],
  [/acoustic|singer.?songwriter|bard|бард/, 'acoustic'],
  [/country|americana|bluegrass/, 'country'],
  [/reggae|dub|ska/, 'reggae'],
  [/latin|salsa|bossa|samba|reggaeton/, 'latin'],
  [/world|ethnic|african|celtic/, 'world'],
  [/new.?age|meditat|relax/, 'newage'],
  [/vocal|chanson|шансон|эстрада/, 'vocal'],
];

export function paletteFor(genre: string): string {
  const g = (genre || '').toLowerCase();
  if (!g) return 'default';
  for (const [re, k] of KEYS) if (re.test(g)) return k;
  return 'default';
}

export function genreLabel(genre: string): string {
  const first = (genre || '').split(/[;,/]/)[0].trim();
  return first || 'Без тэгов';
}
