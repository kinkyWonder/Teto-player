/**
 * Tags of a song. Genres from the file / the internet / the sound are tags, plus automatic tags ("Russian")
 * and the user's own ones. Canonical names are English, one spelling per tag ("рок", "ROCK", "Rock" -> "Rock").
 */
import { t, isEn } from '../i18n';

// Russian (and a few common variant) spellings -> English
const RU: [RegExp, string][] = [
  [/^(русск\w*|russian)$/, 'Russian'], [/^русск\w* рок$/, 'Russian Rock'], [/^русск\w* рэп$|^русск\w* хип.?хоп$/, 'Russian Rap'], [/^русск\w* поп\w*$/, 'Russian Pop'],
  [/^(рок|rock)$/, 'Rock'], [/^поп\w*$/, 'Pop'], [/^(рэп|реп)$/, 'Rap'], [/^хип.?хоп$/, 'Hip-Hop'], [/^электрон\w*$/, 'Electronic'],
  [/^танцев\w*$/, 'Dance'], [/^джаз\w*$/, 'Jazz'], [/^блюз$/, 'Blues'], [/^класси\w*$/, 'Classical'], [/^инди\w*$/, 'Indie'],
  [/^альтернатив\w*$/, 'Alternative'], [/^фолк\w*$/, 'Folk'], [/^(метал|металл)$/, 'Metal'], [/^панк\w*$/, 'Punk'], [/^шансон$/, 'Chanson'],
  [/^эстрада$/, 'Pop'], [/^саундтрек\w*$|^музыка из (фильм|игр)\w*/, 'Soundtrack'], [/^детск\w*/, 'Kids'], [/^регги$/, 'Reggae'],
  [/^кантри$/, 'Country'], [/^диско$/, 'Disco'], [/^хаус$/, 'House'], [/^техно$/, 'Techno'], [/^транс$/, 'Trance'], [/^эмбиент$/, 'Ambient'],
  [/^соул$/, 'Soul'], [/^фанк$/, 'Funk'], [/^лоу.?фай$/, 'Lo-Fi'], [/^авторск\w* песн\w*$|^бард\w*$/, 'Singer-Songwriter'],
  [/^романс\w*$/, 'Romance'], [/^(ритм.?н.?блюз|r ?& ?b|rnb|r'n'b)$/, 'R&B'], [/^(hip ?hop|hiphop|hip-hop)$/, 'Hip-Hop'],
  [/^(lo.?fi)$/, 'Lo-Fi'], [/^(edm)$/, 'EDM'], [/^(dnb|d&b|drum ?(n|and|&|'n') ?bass)$/, 'Drum & Bass'], [/^(k.?pop)$/, 'K-Pop'], [/^(j.?pop)$/, 'J-Pop'],
  [/^(ost)$/, 'Soundtrack'], [/^(alt\.? ?rock|alternative rock)$/, 'Alternative Rock'], [/^(синти.?поп)$/, 'Synth-Pop'], [/^(пост.?панк)$/, 'Post-Punk'],
  [/^(шугейз)$/, 'Shoegaze'], [/^(трэп|треп)$/, 'Trap'], [/^(фонк)$/, 'Phonk'], [/^(вокал\w*)$/, 'Vocal'], [/^(инструментал\w*)$/, 'Instrumental'],
];
const KEEP_UPPER = new Set(['edm', 'idm', 'ost', 'uk', 'us', 'dj', 'r&b', 'ebm']);

const TR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const translit = (s: string) => s.replace(/[а-яё]/g, (c) => TR[c] ?? c);
const title = (s: string) => s.replace(/(^|[\s\-/(])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase())
  .split(' ').map((w) => (KEEP_UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w)).join(' ');

/** One raw genre -> its English display name ('' for nothing useful). */
export function canonGenre(raw: string): string {
  let g = (raw || '').replace(/^\(\d+\)/, '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
  if (!g || g === 'без жанра' || g === 'other' || g === 'unknown' || g === 'music' || g === 'музыка' || g === 'genre') return '';
  for (const [re, en] of RU) if (re.test(g)) return en;
  if (/[а-я]/.test(g)) g = translit(g);
  return title(g);
}

/** A tag may hold several genres: "Rock; Indie / Pop". */
export function splitGenres(raw: string): string[] {
  const out: string[] = [];
  for (const p of (raw || '').split(/\s*[;,|/\\]\s*|\s+\u2022\s+/)) {
    const c = canonGenre(p);
    if (c && !out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c);
  }
  return out;
}

/** Automatic tag: songs with a Russian (Cyrillic) title or artist, or a "Russian …" genre. */
export const RUSSIAN = 'Russian';
const CYR = /[а-яё]/i;
export function isRussian(x: { title?: string; artist?: string; genre?: string }): boolean {
  return CYR.test(x.title || '') || CYR.test(x.artist || '') || /^russian\b|русск/i.test(x.genre || '');
}
/** Automatic tag: everything with letters in the title / artist that is not Russian (English, K-Pop, Spanish…). */
export const FOREIGN = 'Foreign';
const LETTER = /\p{L}/u;
export function isForeign(x: { title?: string; artist?: string; genre?: string }): boolean {
  return !isRussian(x) && (LETTER.test(x.title || '') || LETTER.test(x.artist || ''));
}
/** Russian names of the canonical (English) tags: genres from files, iTunes / Deezer and the sound analysis. */
const RU_NAMES: Record<string, string> = {
  'rock': 'Рок', 'pop': 'Поп', 'rap': 'Рэп', 'hip-hop': 'Хип-хоп', 'hip hop': 'Хип-хоп', 'electronic': 'Электроника', 'electronica': 'Электроника', 'dance': 'Танцевальная',
  'jazz': 'Джаз', 'blues': 'Блюз', 'classical': 'Классика', 'indie': 'Инди', 'alternative': 'Альтернатива', 'folk': 'Фолк', 'metal': 'Метал', 'punk': 'Панк',
  'chanson': 'Шансон', 'soundtrack': 'Саундтрек', 'kids': 'Детская', "children's music": 'Детская', 'reggae': 'Регги', 'country': 'Кантри', 'disco': 'Диско',
  'house': 'Хаус', 'techno': 'Техно', 'trance': 'Транс', 'ambient': 'Эмбиент', 'soul': 'Соул', 'funk': 'Фанк', 'lo-fi': 'Лоу-фай', 'singer-songwriter': 'Авторская песня',
  'singer': 'Авторская песня', 'songwriter': 'Авторская песня', 'romance': 'Романс', 'drum & bass': 'Драм-н-бейс', 'alternative rock': 'Альтернативный рок',
  'synth-pop': 'Синти-поп', 'post-punk': 'Пост-панк', 'shoegaze': 'Шугейз', 'trap': 'Трэп', 'phonk': 'Фонк', 'vocal': 'Вокал', 'instrumental': 'Инструментал',
  'acoustic': 'Акустика', 'russian rock': 'Русский рок', 'russian rap': 'Русский рэп', 'russian pop': 'Русский поп', 'indie rock': 'Инди-рок', 'indie pop': 'Инди-поп',
  'post-rock': 'Пост-рок', 'hard rock': 'Хард-рок', 'punk rock': 'Панк-рок', 'pop rock': 'Поп-рок', 'pop/rock': 'Поп-рок', 'synthwave': 'Синтвейв', 'downtempo': 'Даунтемпо',
  'dubstep': 'Дабстеп', 'latin': 'Латина', 'world': 'Музыка мира', 'new age': 'Нью-эйдж', 'opera': 'Опера', 'easy listening': 'Лёгкая музыка', 'anime': 'Аниме',
  'video game': 'Музыка из игр', 'game': 'Музыка из игр', 'grunge': 'Гранж', 'emo': 'Эмо', 'hardcore': 'Хардкор', 'heavy metal': 'Хэви-метал', 'progressive rock': 'Прог-рок',
  'psychedelic': 'Психоделика', 'psychedelic rock': 'Психоделический рок', 'garage': 'Гараж', 'breakbeat': 'Брейкбит', 'chillout': 'Чиллаут', 'chill': 'Чилл', 'lounge': 'Лаунж',
  'experimental': 'Эксперимент', 'industrial': 'Индастриал', 'gothic': 'Готика', 'ska': 'Ска', 'bossa nova': 'Босса-нова', 'swing': 'Свинг', 'rock & roll': 'Рок-н-ролл',
  "rock'n'roll": 'Рок-н-ролл', 'dance pop': 'Дэнс-поп', 'electropop': 'Электропоп', 'dream pop': 'Дрим-поп', 'k-pop': 'K-pop', 'j-pop': 'J-pop', 'j-rock': 'J-rock',
  'r&b': 'R&B', 'edm': 'EDM', 'idm': 'IDM', 'film': 'Музыка из фильмов', 'musical': 'Мюзикл', 'spoken word': 'Аудиокниги', 'comedy': 'Юмор', 'christmas': 'Новогодняя',
  'holiday': 'Праздничная', 'fitness & workout': 'Для спорта', 'electro': 'Электро', 'deep house': 'Дип-хаус', 'drill': 'Дрилл', 'grime': 'Грайм', 'cloud rap': 'Клауд-рэп',
  'emo rap': 'Эмо-рэп', 'pop punk': 'Поп-панк', 'nu metal': 'Ню-метал', 'metalcore': 'Металкор', 'black metal': 'Блэк-метал', 'death metal': 'Дэт-метал',
  'trip-hop': 'Трип-хоп', 'trip hop': 'Трип-хоп', 'neoclassical': 'Неоклассика', 'piano': 'Фортепиано', 'orchestral': 'Оркестровая', 'soft rock': 'Софт-рок',
  'new wave': 'Нью-вейв', 'dark wave': 'Дарквейв', 'darkwave': 'Дарквейв', 'witch house': 'Уич-хаус', 'hyperpop': 'Гиперпоп', 'vaporwave': 'Вейпорвейв', 'city pop': 'Сити-поп',
  'afrobeat': 'Афробит', 'afrobeats': 'Афробит', 'reggaeton': 'Реггетон', 'flamenco': 'Фламенко', 'celtic': 'Кельтская', 'gospel': 'Госпел', 'christian': 'Христианская',
  'downbeat': 'Даунбит', 'future bass': 'Фьюче-бейс', 'hardstyle': 'Хардстайл', 'eurodance': 'Евродэнс', 'italo disco': 'Итало-диско', 'europop': 'Европоп', 'bard': 'Бардовская',
};
/** Display name of a tag in the interface language (canonical names are English; the automatic ones are translated). */
export const tagLabel = (g: string) => {
  if (g === RUSSIAN) return t('Русское');
  if (g === FOREIGN) return t('Иностранное');
  if (isEn()) return g;
  return RU_NAMES[g.toLowerCase()] ?? g;
};
