//! namefix — «умная» очистка названий треков и распознавание «Исполнитель - Название».
//!
//! Чистое ядро без зависимостей (только std) — работает одинаково на Windows, Android и iOS.
//!
//! Что делает:
//! * вырезает из имён файлов и тегов домены сайтов (`(allmusic.kz)`, `hitmos.me`, `www.site.ru`, `https://…`),
//!   ID и хэши (`_81871761`, `_423141kjfkefjj13`), мусор вида `(official video)`, `320kbps`, `(1)`, `- копия`;
//!   при этом НЕ трогает текст, если без него ничего не останется (`Nyan.com` остаётся `Nyan.com`) и если
//!   этот текст уже известен библиотеке как исполнитель/трек;
//! * делит строку на исполнителя и название по соглашению hitmos (`Исполнитель - Название`, `_-_`),
//!   но сверяет ОБЕ части с уже добавленными исполнителями и их треками — если источник написал наоборот
//!   (`утекай - тёмный принц`), части меняются местами;
//! * сравнивает имена устойчиво к регистру, ё/е и транслиту (`tjomnyjj princ` = `tyomniy princ` = `тёмный принц`)
//!   и возвращает каноничное написание, уже существующее в библиотеке (без дублей исполнителей);
//! * восстанавливает кириллицу из транслита hitmos (`tjomnyjj_princ_-_utekajj_81871761` → `тёмный принц - утекай`);
//! * сообщает уверенность (`Confidence`) — UI может подсветить сомнительные треки «проверьте».
//!
//! Производительность: никаких regex и аллокаций сверх нескольких строк на трек; поиск по индексу — хэш-таблица,
//! нечёткий поиск только по корзине близкой длины с ограниченным Левенштейном. ~2–10 мкс на трек.

use std::collections::HashMap;

// ───────────────────────────── публичные типы ─────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Confidence {
    /// Догадка: разделить не удалось или нет никаких подтверждений — стоит показать пометку «проверьте».
    Guess = 0,
    /// Явный разделитель / соглашение hitmos, но без подтверждения библиотекой.
    Medium = 1,
    /// Теги файла или совпадение с уже известными исполнителем/треком.
    High = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// Взято из тегов как есть.
    Tags,
    /// Взято из тегов, но из них вырезан мусор / исправлено написание / восстановлено по библиотеке.
    TagsCleaned,
    /// Разобрано из имени файла.
    FileName,
}

/// Сырые данные: имя файла без расширения + то, что прочитано из тегов (пустые строки = тега нет).
#[derive(Clone, Debug, Default)]
pub struct Input<'a> {
    pub stem: &'a str,
    pub title: &'a str,
    pub artist: &'a str,
    pub album: &'a str,
    pub album_artist: &'a str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    pub title: String,
    /// Пусто = исполнитель действительно неизвестен.
    pub artist: String,
    /// Пусто = альбома нет (приложение подставит папку / «Без альбома»).
    pub album: String,
    pub album_artist: String,
    /// Номер трека, если он был в начале имени файла (`01 - …`), иначе 0.
    pub track_no: u32,
    pub confidence: Confidence,
    pub origin: Origin,
    /// Части были переставлены относительно порядка в источнике.
    pub swapped: bool,
}

// ───────────────────────────── индекс известных имён ─────────────────────────────

#[derive(Clone, Debug, Default)]
struct ArtistEntry {
    display: String,
    votes: HashMap<String, u32>,
    pinned: bool, // имя задано пользователем — не перевыбирать по голосам
    /// ключ названия -> (написание, альбом)
    titles: HashMap<String, (String, String)>,
}

/// Индекс уже добавленных исполнителей и треков. Строится один раз на сканирование и дополняется на лету.
#[derive(Clone, Debug, Default)]
pub struct Known {
    artists: HashMap<String, ArtistEntry>,
    by_len: HashMap<usize, Vec<String>>,
    titles_any: HashMap<String, u32>,
    /// Слова, которые ни в коем случае нельзя вырезать как мусор (известные имена целиком).
    protected: HashMap<String, ()>,
}

impl Known {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn artist_count(&self) -> usize {
        self.artists.len()
    }

    /// Учесть трек (из базы или только что надёжно распознанный).
    pub fn add_track(&mut self, artist: &str, title: &str, album: &str, weight: u32) {
        let artist = artist.trim();
        if artist.is_empty() || is_placeholder(artist) {
            return;
        }
        let ak = key(artist);
        if ak.is_empty() {
            return;
        }
        self.protect(artist);
        let is_new = !self.artists.contains_key(&ak);
        let e = self.artists.entry(ak.clone()).or_default();
        if is_new {
            e.display = artist.to_string();
        }
        let v = e.votes.entry(artist.to_string()).or_insert(0);
        *v += weight.max(1);
        let v = *v;
        if !e.pinned && e.display != artist && v > *e.votes.get(&e.display).unwrap_or(&0) {
            e.display = artist.to_string();
        }
        let title = title.trim();
        if !title.is_empty() {
            let tk = key(title);
            if !tk.is_empty() {
                let album = album.trim();
                let album = if is_placeholder(album) { "" } else { album };
                let slot = e.titles.entry(tk.clone()).or_insert_with(|| (title.to_string(), album.to_string()));
                if slot.1.is_empty() && !album.is_empty() {
                    slot.1 = album.to_string();
                }
                *self.titles_any.entry(tk).or_insert(0) += 1;
                self.protect(title);
            }
        }
        if is_new {
            self.by_len.entry(ak.chars().count()).or_default().push(ak);
        }
    }

    /// Пользователь глобально переименовал исполнителя: `from` (любое написание) теперь показывается как `to`.
    pub fn add_alias(&mut self, from: &str, to: &str) {
        let fk = key(from);
        let tk = key(to);
        if fk.is_empty() || tk.is_empty() {
            return;
        }
        self.add_track(to, "", "", 1);
        if let Some(e) = self.artists.get_mut(&tk) {
            e.display = to.trim().to_string();
            e.pinned = true;
        }
        if fk != tk {
            let mut entry = self.artists.get(&tk).cloned().unwrap_or_default();
            if let Some(old) = self.artists.remove(&fk) {
                for (k, v) in old.titles {
                    entry.titles.entry(k).or_insert(v);
                }
            }
            entry.display = to.trim().to_string();
            entry.pinned = true;
            self.artists.insert(fk.clone(), entry.clone());
            self.artists.insert(tk, entry);
            let l = fk.chars().count();
            let b = self.by_len.entry(l).or_default();
            if !b.contains(&fk) {
                b.push(fk);
            }
        }
    }

    fn protect(&mut self, s: &str) {
        let l = s.trim().to_lowercase();
        if !l.is_empty() {
            self.protected.insert(l, ());
        }
    }

    fn is_protected(&self, tok: &str) -> bool {
        !self.protected.is_empty() && self.protected.contains_key(&tok.trim().to_lowercase())
    }

    /// Каноничное написание исполнителя, если он уже есть в библиотеке (точное совпадение ключа).
    pub fn canonical_artist(&self, name: &str) -> Option<&str> {
        self.artists.get(&key(name)).map(|e| e.display.as_str())
    }

    fn find_artist(&self, s: &str) -> Option<(f32, &ArtistEntry)> {
        if self.artists.is_empty() {
            return None;
        }
        let k = key(s);
        if k.is_empty() {
            return None;
        }
        if let Some(e) = self.artists.get(&k) {
            return Some((1.0, e));
        }
        // «A feat. B», «A, B», «A & B» — сверяем главного исполнителя
        let main = main_artist(s);
        if main.len() < s.len() {
            if let Some(e) = self.artists.get(&key(main)) {
                return Some((0.9, e));
            }
        }
        // нечётко: опечатки / разные схемы транслита
        let n = k.chars().count();
        if n < 5 {
            return None;
        }
        let maxd = if n >= 10 { 2 } else { 1 };
        let mut best: Option<(usize, &ArtistEntry)> = None;
        for l in n.saturating_sub(maxd)..=n + maxd {
            if let Some(list) = self.by_len.get(&l) {
                for cand in list {
                    if let Some(d) = lev_bounded(&k, cand, maxd) {
                        if best.map_or(true, |b| d < b.0) {
                            if let Some(e) = self.artists.get(cand) {
                                best = Some((d, e));
                            }
                        }
                    }
                }
            }
        }
        best.map(|(d, e)| (if d <= 1 { 0.8 } else { 0.7 }, e))
    }

    fn title_of<'k>(&self, e: &'k ArtistEntry, title: &str) -> Option<(f32, &'k (String, String))> {
        let k = key(title);
        if k.is_empty() {
            return None;
        }
        if let Some(t) = e.titles.get(&k) {
            return Some((1.0, t));
        }
        let n = k.chars().count();
        if n < 5 {
            return None;
        }
        let maxd = if n >= 10 { 2 } else { 1 };
        e.titles.iter().filter_map(|(tk, v)| lev_bounded(&k, tk, maxd).map(|d| (d, v))).min_by_key(|x| x.0).map(|(_, v)| (0.8, v))
    }

    fn title_known_any(&self, s: &str) -> bool {
        !self.titles_any.is_empty() && self.titles_any.contains_key(&key(s))
    }
}

// ───────────────────────────── главная функция ─────────────────────────────

/// Определить исполнителя/название/альбом трека. `known` — индекс библиотеки (может быть пустым).
pub fn resolve(inp: &Input, known: &Known) -> Output {
    let tag_title = clean_text(inp.title, known, Field::Tag);
    let tag_artist = clean_text(inp.artist, known, Field::Artist);
    let tag_album = clean_text(inp.album, known, Field::Album);
    let tag_aa = clean_text(inp.album_artist, known, Field::Artist);
    let tags_dirty = tag_title != inp.title.trim() || tag_artist != inp.artist.trim() || tag_album != inp.album.trim();

    let mut out = Output {
        title: String::new(),
        artist: String::new(),
        album: tag_album.clone(),
        album_artist: tag_aa.clone(),
        track_no: 0,
        confidence: Confidence::High,
        origin: if tags_dirty { Origin::TagsCleaned } else { Origin::Tags },
        swapped: false,
    };

    if !tag_title.is_empty() && !tag_artist.is_empty() {
        // 1) теги есть — доверяем им, но проверяем на явную перестановку
        out.artist = tag_artist;
        out.title = tag_title;
        if known.find_artist(&out.artist).is_none() {
            if let Some((_, e)) = known.find_artist(&out.title) {
                if known.title_of(e, &out.artist).is_some() {
                    std::mem::swap(&mut out.artist, &mut out.title);
                    out.swapped = true;
                    out.origin = Origin::TagsCleaned;
                }
            }
        }
    } else {
        // 2) тегов нет или они неполные — разбираем имя файла (или тег названия вида «A - B»)
        let (stem_text, style, no) = prep_stem(inp.stem);
        out.track_no = no;
        let stem_clean = clean_text(&stem_text, known, Field::Stem);
        let source: (&str, Style) = if tag_title.contains(" - ") && tag_artist.is_empty() {
            (tag_title.as_str(), Style::Plain)
        } else {
            (stem_clean.as_str(), style)
        };
        let p = split_best(source.0, source.1, known, &tag_artist);
        out.origin = if p.from_stem && source.0 == stem_clean.as_str() { Origin::FileName } else { Origin::TagsCleaned };
        out.confidence = p.conf;
        out.swapped = p.swapped;
        out.artist = if !tag_artist.is_empty() { tag_artist.clone() } else { p.artist };
        out.title = if !tag_title.is_empty() && !tag_title.contains(" - ") { tag_title.clone() } else { p.title };
        if out.title.is_empty() {
            out.title = if stem_clean.is_empty() { inp.stem.trim().to_string() } else { stem_clean.clone() };
            if out.artist.is_empty() {
                out.confidence = Confidence::Guess;
            }
        }
        if !tag_artist.is_empty() || !tag_title.is_empty() {
            out.confidence = out.confidence.max(Confidence::Medium);
        }
        // транслит hitmos -> кириллица (сначала исполнитель, затем название)
        if !out.artist.is_empty() && !has_cyr(&out.artist) && known.find_artist(&out.artist).is_none() && looks_translit_any(&out.artist, style) {
            out.artist = untranslit(&out.artist);
        }
        let cyr_artist = has_cyr(&out.artist) || known.find_artist(&out.artist).map_or(false, |(_, e)| has_cyr(&e.display));
        if !has_cyr(&out.title) && (cyr_artist || style == Style::Hitmos) && looks_translit_any(&out.title, style) {
            let known_title = known.find_artist(&out.artist).and_then(|(_, e)| known.title_of(e, &out.title)).is_some();
            if !known_title {
                out.title = untranslit(&out.title);
            }
        }
    }

    // 3) каноничные написания из библиотеки (ё/е, регистр, транслит) + альбом из уже известной копии трека
    if let Some((score, e)) = known.find_artist(&out.artist) {
        if score >= 1.0 || out.origin == Origin::FileName || !has_cyr(&out.artist) || score >= 0.8 && same_script(&out.artist, &e.display) {
            if score >= 0.9 || out.origin == Origin::FileName {
                if e.display != out.artist {
                    out.artist = e.display.clone();
                    if out.origin == Origin::Tags {
                        out.origin = Origin::TagsCleaned;
                    }
                }
            }
        }
        if let Some((_, (t, alb))) = known.title_of(e, &out.title) {
            if out.origin == Origin::FileName || !has_cyr(&out.title) && has_cyr(t) {
                out.title = t.clone();
            }
            if out.album.is_empty() && !alb.is_empty() {
                out.album = alb.clone();
            }
            out.confidence = Confidence::High;
        } else if out.origin == Origin::FileName && score >= 0.8 {
            out.confidence = out.confidence.max(Confidence::Medium);
        }
    }
    if !out.album_artist.is_empty() {
        if let Some(c) = known.canonical_artist(&out.album_artist) {
            out.album_artist = c.to_string();
        }
    }
    out.title = tidy(&out.title);
    out.artist = tidy(&out.artist);
    out
}

/// Быстрая проверка: стоит ли перечитать уже сохранённый трек (в названиях есть мусор / неизвестный исполнитель).
pub fn looks_dirty(title: &str, artist: &str, album: &str) -> bool {
    let k = Known::new();
    is_placeholder(artist)
        || artist.trim().is_empty()
        || clean_text(title, &k, Field::Tag) != title.trim()
        || clean_text(artist, &k, Field::Artist) != artist.trim()
        || clean_text(album, &k, Field::Album) != album.trim()
        || title.contains('_')
        || title.contains(" - ") && artist.trim().is_empty()
}

/// Ключ сравнения имён: без регистра, ё=е, кириллица и любой транслит сводятся к одному «скелету».
/// `тёмный принц`, `Темный Принц`, `tjomnyjj princ`, `tyomniy-princ` → `temni princ`.
pub fn key(s: &str) -> String {
    let mut lat = String::with_capacity(s.len() + 8);
    for c in s.chars().flat_map(|c| c.to_lowercase()) {
        match c {
            'а' => lat.push('a'), 'б' => lat.push('b'), 'в' => lat.push('v'), 'г' => lat.push('g'), 'д' => lat.push('d'),
            'е' | 'ё' | 'э' | 'є' => lat.push('e'), 'ж' => lat.push('z'), 'з' => lat.push('z'), 'и' | 'й' | 'ы' | 'і' | 'ї' => lat.push('i'),
            'к' => lat.push('k'), 'л' => lat.push('l'), 'м' => lat.push('m'), 'н' => lat.push('n'), 'о' => lat.push('o'),
            'п' => lat.push('p'), 'р' => lat.push('r'), 'с' => lat.push('s'), 'т' => lat.push('t'), 'у' | 'ў' => lat.push('u'),
            'ф' => lat.push('f'), 'х' => lat.push('h'), 'ц' => lat.push('c'), 'ч' => lat.push('c'), 'ш' | 'щ' => lat.push('s'),
            'ъ' | 'ь' | '\'' | '’' | '`' | 'ʼ' => {}
            'ю' => lat.push('u'), 'я' => lat.push('a'),
            c if c.is_alphanumeric() => lat.push(c),
            _ => lat.push(' '),
        }
    }
    // латинские диграфы и варианты транслита
    let b: Vec<char> = lat.chars().collect();
    let mut o = String::with_capacity(b.len());
    let mut i = 0;
    let at = |i: usize, p: &str| -> bool { p.chars().enumerate().all(|(j, pc)| b.get(i + j) == Some(&pc)) };
    while i < b.len() {
        let (rep, n): (&str, usize) = if at(i, "shch") {
            ("s", 4)
        } else if at(i, "shh") || at(i, "sch") {
            ("s", 3)
        } else if at(i, "sh") {
            ("s", 2)
        } else if at(i, "ch") || at(i, "ts") || at(i, "tz") || at(i, "tc") {
            ("c", 2)
        } else if at(i, "zh") {
            ("z", 2)
        } else if at(i, "kh") {
            ("h", 2)
        } else if at(i, "ph") {
            ("f", 2)
        } else if at(i, "ck") {
            ("k", 2)
        } else if at(i, "eh") {
            ("e", 2)
        } else if at(i, "ya") || at(i, "ja") || at(i, "ia") {
            ("a", 2)
        } else if at(i, "yu") || at(i, "ju") || at(i, "iu") {
            ("u", 2)
        } else if at(i, "yo") || at(i, "jo") || at(i, "io") || at(i, "ye") || at(i, "je") || at(i, "ie") {
            ("e", 2)
        } else {
            match b[i] {
                'y' | 'j' => ("i", 1),
                'w' => ("v", 1),
                'q' => ("k", 1),
                'x' => ("ks", 1),
                _ => ("", 0),
            }
        };
        if n == 0 {
            o.push(b[i]);
            i += 1;
        } else {
            o.push_str(rep);
            i += n;
        }
    }
    // схлопнуть повторы букв и пробелов
    let mut r = String::with_capacity(o.len());
    let mut prev = ' ';
    for c in o.chars() {
        if c == prev {
            continue;
        }
        r.push(c);
        prev = c;
    }
    r.trim().to_string()
}

// ───────────────────────────── разбор имени файла ─────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Style {
    /// `artist_-_title_12345678` (hitmos): слева от тире всегда исполнитель.
    Hitmos,
    /// `artist-words-title-words` без пробелов: границы неизвестны.
    Slug,
    Plain,
}

/// Нормализовать имя файла: подчёркивания, тире, ID hitmos, номер трека в начале.
fn prep_stem(stem: &str) -> (String, Style, u32) {
    let mut s = stem.trim().replace("%20", " ");
    let mut style = Style::Plain;
    // ID hitmos в конце: _81871761
    if let Some(p) = s.rfind('_') {
        let tail = &s[p + 1..];
        if tail.len() >= 5 && tail.chars().all(|c| c.is_ascii_digit()) && p > 0 {
            s.truncate(p);
            style = Style::Hitmos;
        }
    }
    if s.contains("_-_") {
        style = Style::Hitmos;
    }
    s = s.replace("_-_", " - ");
    // в «слаге» скобки с сайтом обычно приклеены через дефис: tyomniy-princ-utekay-(allmusic.kz)
    s = s.replace("-(", " (").replace("_(", " (").replace(")-", ") ").replace(")_", ") ");
    s = s.replace('_', " ");
    for d in ["–", "—", "‒", "―", "−", "--"] {
        s = s.replace(d, "-");
    }
    // «A -B» / «A- B» -> «A - B»
    s = s.replace(" -", " - ").replace("- ", " - ");
    s = collapse_ws(&s);
    if style == Style::Plain {
        let core: String = strip_brackets_junk(&s, &Known::new()).trim().to_string();
        if !core.contains(' ') && core.matches('-').count() >= 2 {
            style = Style::Slug;
        } else if !core.contains(" - ") && core.matches('-').count() == 1 {
            // «Тёмный принц-Утекай»: дефис без пробелов между фразами — разделитель
            let (l, r) = core.split_once('-').unwrap();
            if (l.contains(' ') || r.contains(' ')) && l.trim().chars().count() >= 2 && r.trim().chars().count() >= 2 {
                s = s.replacen(&format!("{}-{}", l, r), &format!("{} - {}", l.trim(), r.trim()), 1);
            }
        }
    }
    // номер трека в начале: «01 - », «01. », «1_», «07 »
    let mut no = 0;
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if (1..=3).contains(&digits.len()) {
        let rest = &s[digits.len()..];
        let strip = if rest.starts_with(". ") || rest.starts_with(" - ") || rest.starts_with(".") && !rest.starts_with("..") {
            true
        } else {
            digits.len() == 2 && digits.starts_with('0') && rest.starts_with(' ')
        };
        let after = rest.trim_start_matches(['.', ' ', '-']).trim();
        if strip && !after.is_empty() {
            no = digits.parse().unwrap_or(0);
            s = after.to_string();
        }
    }
    (s, style, no)
}

struct Parsed {
    artist: String,
    title: String,
    conf: Confidence,
    swapped: bool,
    from_stem: bool,
}

fn split_best(text: &str, style: Style, known: &Known, tag_artist: &str) -> Parsed {
    let text = text.trim();
    let mut cands: Vec<(String, String, bool)> = Vec::new(); // (left, right, explicit)
    if text.contains(" - ") {
        let mut from = 0;
        while let Some(p) = text[from..].find(" - ") {
            let p = from + p;
            let (l, r) = (text[..p].trim(), text[p + 3..].trim());
            if !l.is_empty() && !r.is_empty() {
                cands.push((l.to_string(), r.to_string(), true));
            }
            from = p + 3;
        }
    } else if style == Style::Slug {
        let words: Vec<&str> = text.split(|c: char| c == '-' || c == ' ').filter(|w| !w.is_empty()).collect();
        for k in 1..words.len() {
            cands.push((words[..k].join(" "), words[k..].join(" "), false));
        }
    }
    if cands.is_empty() {
        let t = if style == Style::Slug { text.replace('-', " ") } else { text.to_string() };
        return Parsed { artist: String::new(), title: t, conf: Confidence::Guess, swapped: false, from_stem: true };
    }
    // известный из тегов исполнитель: просто берём другую сторону
    if !tag_artist.is_empty() {
        let tk = key(tag_artist);
        for (l, r, _) in &cands {
            if key(l) == tk {
                return Parsed { artist: l.clone(), title: r.clone(), conf: Confidence::High, swapped: false, from_stem: true };
            }
            if key(r) == tk {
                return Parsed { artist: r.clone(), title: l.clone(), conf: Confidence::High, swapped: true, from_stem: true };
            }
        }
    }
    let prior = match style {
        Style::Hitmos => 4.0, // hitmos всегда пишет исполнителя слева — переставляем только при подтверждении трека
        _ => 0.5,
    };
    let score = |a: &str, t: &str| -> (f32, bool) {
        let mut s = 0.0;
        let mut combo = false;
        if let Some((sa, e)) = known.find_artist(a) {
            s += 3.0 * sa;
            if let Some((st, _)) = known.title_of(e, t) {
                s += 4.0 * st;
                combo = true;
            }
        }
        if known.title_known_any(t) {
            s += 0.75;
        }
        (s, combo)
    };
    let mut best: Option<(f32, usize, bool, bool)> = None; // (score, idx, swapped, combo)
    for (i, (l, r, explicit)) in cands.iter().enumerate() {
        let (sn, cn) = score(l, r);
        let (ss, cs) = score(r, l);
        let sn = sn + if *explicit { prior } else { 0.0 } - i as f32 * 0.01;
        let ss = ss - i as f32 * 0.01;
        for (s, sw, c) in [(sn, false, cn), (ss, true, cs)] {
            if !*explicit && s < 2.0 {
                continue; // слаг без подтверждения библиотекой не делим
            }
            if best.map_or(true, |b| s > b.0) {
                best = Some((s, i, sw, c));
            }
        }
    }
    let Some((s, i, sw, combo)) = best else {
        return Parsed { artist: String::new(), title: text.replace('-', " "), conf: Confidence::Guess, swapped: false, from_stem: true };
    };
    let (l, r, explicit) = &cands[i];
    let (a, t) = if sw { (r.clone(), l.clone()) } else { (l.clone(), r.clone()) };
    let conf = if combo || (s >= 3.0 && !sw && *explicit && s - prior >= 2.0) || (s >= 2.4 && !*explicit) {
        Confidence::High
    } else if *explicit {
        Confidence::Medium
    } else {
        Confidence::Guess
    };
    let conf = if sw && !combo { Confidence::Medium.min(conf) } else { conf };
    Parsed { artist: a, title: t, conf, swapped: sw, from_stem: true }
}

// ───────────────────────────── очистка мусора ─────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Stem,
    Tag,
    Artist,
    Album,
}

/// Сайты-источники: вырезаются всегда (если после этого что-то остаётся или поле — альбом/исполнитель).
const SITES: &[&str] = &[
    "hitmos", "hitmo", "hitmotop", "rus.hitmotop", "allmusic", "lmusic", "zaycev", "zaycev.net", "muzofond", "muzofond.fm", "mp3party",
    "muzmo", "drivemusic", "mp3uk", "luxmp3", "mp3cc", "ipleer", "pleer", "muzvon", "z1", "zvukm", "muzlo", "musify", "sefon", "mp3bob",
    "freemp3", "hotplayer", "tophit", "mp3xa", "muzofon", "mp3-tut", "mp3tut", "x-minus", "xminus", "vk", "vkontakte", "youtube", "youtu",
    "soundcloud", "t", "deezer", "spotify", "muzon", "muzati", "patefon", "irotaxi", "mzk", "best-muzon", "bestmuzon", "mp3crown", "mp3ex",
    "music7s", "muzic", "trendovaya", "hitster", "hydr0", "hydro", "mp3bit", "mp3-pesni", "mp3pesni", "muzrecord", "rmp3", "uzmuzon", "muzter",
    "mp3juice", "mp3juices", "mp3skull", "y2mate", "savefrom", "ytmp3", "flvto", "musicat", "mp3mn", "mp3iq", "mymp3", "ru-music", "rumusic",
];

const TLDS: &[&str] = &[
    "com", "net", "org", "info", "biz", "ru", "su", "kz", "ua", "by", "uz", "kg", "am", "az", "ge", "md", "tj", "me", "fm", "cc", "io", "to", "tv",
    "xyz", "top", "club", "online", "site", "pro", "mobi", "ws", "la", "eu", "de", "pl", "us", "in", "co", "cx", "nu", "ms", "website", "space",
    "store", "live", "life", "fun", "icu", "link", "click", "zone", "today", "world", "music", "audio", "media", "tk", "ml", "ga", "cf", "gq",
    "рф", "рус", "укр", "бел", "қаз",
];

const JUNK_PHRASES: &[&str] = &[
    "official video", "official audio", "official music video", "official lyric video", "lyric video", "lyrics video", "lyrics", "lyric",
    "audio", "video", "hq", "hd", "4k", "mp3", "320", "320kbps", "320 kbps", "256kbps", "192kbps", "128kbps", "128 kbps", "kbps",
    "скачать", "скачать бесплатно", "бесплатно", "новинка", "премьера", "клип", "премьера клипа", "copy", "копия", "visualizer",
    "free download", "download", "music video", "full version", "официальное видео", "официальный клип", "аудио",
];

/// Очистить одно поле/имя файла. Никогда не возвращает пустую строку для непустого ввода, кроме
/// полей-альбомов/исполнителей, целиком состоящих из адреса сайта-источника.
fn clean_text(raw: &str, known: &Known, field: Field) -> String {
    let s0 = collapse_ws(raw.trim().trim_matches('\0'));
    if s0.is_empty() {
        return s0;
    }
    if known.is_protected(&s0) {
        return s0;
    }
    // 1) скобки с мусором
    let s = strip_brackets_junk(&s0, known);
    // 2) сегменты по « - »: выкидываем сегменты, целиком состоящие из адреса сайта
    let segs: Vec<String> = s.split(" - ").map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
    let junk_seg = |x: &str| -> Option<bool> {
        // Some(true) = сайт-источник / ссылка (вырезать смело), Some(false) = обычный домен
        let toks: Vec<&str> = x.split_whitespace().collect();
        if toks.is_empty() || known.is_protected(x) {
            return None;
        }
        if toks.iter().all(|t| token_junk(t, known).is_some() || is_junk_phrase(t)) {
            return Some(toks.iter().any(|t| token_junk(t, known) == Some(true)) || is_junk_phrase(x));
        }
        if is_junk_phrase(x) {
            return Some(true);
        }
        None
    };
    let kinds: Vec<Option<bool>> = segs.iter().map(|x| junk_seg(x)).collect();
    let clean_cnt = kinds.iter().filter(|k| k.is_none()).count();
    let mut kept: Vec<String> = Vec::with_capacity(segs.len());
    for (x, k) in segs.iter().zip(&kinds) {
        let drop = match k {
            None => false,
            Some(true) => clean_cnt >= 1 || matches!(field, Field::Album | Field::Artist),
            Some(false) => clean_cnt >= 2,
        };
        if !drop {
            kept.push(x.clone());
        }
    }
    let multi = kept.len() >= 2 || clean_cnt >= 2;
    // 3) мусорные слова по краям каждого сегмента
    let mut res: Vec<String> = Vec::with_capacity(kept.len());
    for seg in &kept {
        let mut toks: Vec<&str> = seg.split_whitespace().collect();
        loop {
            let n = toks.len();
            if n <= 1 {
                break;
            }
            let last = toks[n - 1];
            let rm = match token_junk(last, known) {
                Some(true) => true,
                Some(false) => multi || field != Field::Stem && field != Field::Tag || toks[..n - 1].iter().any(|t| *t == "-" || *t == "|"),
                None => is_edge_junk(last) || last == "-" || last == "|",
            };
            if rm {
                toks.pop();
            } else {
                break;
            }
        }
        while toks.len() > 1 {
            let first = toks[0];
            let rm = match token_junk(first, known) {
                Some(true) => true,
                Some(false) => multi,
                None => first == "-" || first == "|",
            };
            if rm {
                toks.remove(0);
            } else {
                break;
            }
        }
        // одиночный токен-сайт в поле альбома/исполнителя (`lmusic.kz`) — это не имя
        if toks.len() == 1 && matches!(field, Field::Album | Field::Artist) && token_junk(toks[0], known) == Some(true) && !known.is_protected(toks[0]) {
            toks.clear();
        }
        let j = toks.join(" ");
        let j = j.trim_matches(|c: char| c == '-' || c == '|' || c == '_' || c == ',' || c.is_whitespace()).to_string();
        if !j.is_empty() {
            res.push(j);
        }
    }
    let out = res.join(" - ");
    if out.is_empty() {
        // всё оказалось «мусором» — значит, это и есть название (Nyan.com), кроме сайта в альбоме/исполнителе
        if matches!(field, Field::Album | Field::Artist) && kinds.iter().all(|k| *k == Some(true)) {
            return String::new();
        }
        return s0;
    }
    out
}

fn strip_brackets_junk(s: &str, known: &Known) -> String {
    let mut out = String::with_capacity(s.len());
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut removed_any = false;
    while i < cs.len() {
        let c = cs[i];
        let close = match c {
            '(' => Some(')'),
            '[' => Some(']'),
            '{' => Some('}'),
            '【' => Some('】'),
            _ => None,
        };
        if let Some(cl) = close {
            if let Some(j) = cs[i + 1..].iter().position(|&x| x == cl) {
                let inner: String = cs[i + 1..i + 1 + j].iter().collect();
                let inner_t = inner.trim();
                let before: String = out.trim().to_string();
                let after: String = cs[i + 2 + j..].iter().collect::<String>();
                let rest_empty = before.is_empty() && after.trim().is_empty();
                let is_copy = inner_t.len() <= 2 && inner_t.chars().all(|c| c.is_ascii_digit()) && after.trim().is_empty() && !before.is_empty();
                let junk = !known.is_protected(inner_t)
                    && (is_copy
                        || is_junk_phrase(inner_t)
                        || inner_t.split_whitespace().any(|t| token_junk(t, known).is_some()) && inner_t.split_whitespace().all(|t| token_junk(t, known).is_some() || is_junk_word(t))
                        || inner_t.split_whitespace().any(|t| token_junk(t, known) == Some(true)));
                if junk && !rest_empty {
                    i += j + 2;
                    removed_any = true;
                    if !out.ends_with(' ') {
                        out.push(' ');
                    }
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    if !removed_any {
        return s.to_string();
    }
    collapse_ws(&out)
}

/// Some(true) — ссылка/сайт-источник/ID, Some(false) — «обычный» домен (может быть названием), None — не мусор.
fn token_junk(tok: &str, known: &Known) -> Option<bool> {
    let t = tok.trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';' | ':' | '!' | '"' | '\'' | '«' | '»' | '|'));
    if t.is_empty() || known.is_protected(t) {
        return None;
    }
    let l = t.to_lowercase();
    if l.starts_with("http://") || l.starts_with("https://") || l.starts_with("www.") {
        return Some(true);
    }
    if let Some(base) = domain_base(&l) {
        let site = SITES.iter().any(|s| base == *s || base.starts_with(s) && base.len() <= s.len() + 3 || l.starts_with(&format!("{s}.")));
        return Some(site);
    }
    if is_hash(t) {
        return Some(true);
    }
    if SITES.iter().any(|s| s.len() >= 5 && l == *s) {
        return Some(true);
    }
    None
}

/// `rus.hitmotop.com/x` → Some("hitmotop"); `Nyan.com` → Some("nyan"); `Vol.2` → None.
fn domain_base(l: &str) -> Option<String> {
    let host = l.split('/').next().unwrap_or(l);
    let host = host.trim_end_matches('.');
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return None;
    }
    if labels.iter().any(|x| x.is_empty() || !x.chars().all(|c| c.is_alphanumeric() || c == '-')) {
        return None;
    }
    let tld = *labels.last().unwrap();
    if !TLDS.contains(&tld) {
        return None;
    }
    let base = labels[labels.len() - 2];
    if base.chars().all(|c| c.is_ascii_digit()) || base.chars().count() < 1 {
        return None;
    }
    Some(base.to_string())
}

/// Хэш/ID: `423141kjfkefjj13`, `a3f9b2c1d4`, `81871761`. Не трогает `Blink182`, `50cent`, `1999`, `2pac`.
fn is_hash(t: &str) -> bool {
    if !t.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    let n = t.len();
    let digits = t.chars().filter(|c| c.is_ascii_digit()).count();
    if digits == n {
        return n >= 6;
    }
    if n < 6 || digits < 2 || n - digits < 2 {
        return false;
    }
    let mut trans = 0;
    let cs: Vec<bool> = t.chars().map(|c| c.is_ascii_digit()).collect();
    for w in cs.windows(2) {
        if w[0] != w[1] {
            trans += 1;
        }
    }
    trans >= 2 || digits >= 5
}

fn is_junk_word(t: &str) -> bool {
    let l = t.to_lowercase();
    matches!(l.as_str(), "скачать" | "бесплатно" | "mp3" | "download" | "free" | "with" | "from" | "с" | "на" | "via" | "by" | "от" | "сайта" | "сайт" | "site" | "source" | "источник")
}

fn is_junk_phrase(t: &str) -> bool {
    let l = t.to_lowercase();
    let l = l.trim_matches(|c: char| !c.is_alphanumeric());
    JUNK_PHRASES.contains(&l)
}

fn is_edge_junk(t: &str) -> bool {
    let l = t.to_lowercase();
    matches!(l.as_str(), "mp3" | "320kbps" | "256kbps" | "192kbps" | "128kbps" | "kbps")
}

// ───────────────────────────── транслит ─────────────────────────────

fn looks_translit_any(s: &str, style: Style) -> bool {
    if has_cyr(s) || s.is_empty() {
        return false;
    }
    let l = s.to_lowercase();
    if !l.chars().all(|c| c.is_ascii_lowercase() || c == ' ' || c == '\'' || c.is_ascii_digit()) {
        return false; // есть заглавные/символы — скорее настоящее латинское имя
    }
    l.contains("jj") || l.contains("shh") || l.contains("zh") || l.contains("kh") || style == Style::Hitmos && (l.contains("ju") || l.contains("ja") || l.contains("jo") || l.contains("y") || l.contains("eh"))
}

/// Обратный транслит по схеме hitmos (ГОСТ 7.79-2000, вариант Б): `tjomnyjj princ` → `тёмный принц`.
pub fn untranslit(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let mut o = String::with_capacity(s.len() * 2);
    let mut i = 0;
    let at = |i: usize, p: &str| -> bool { p.chars().enumerate().all(|(j, pc)| b.get(i + j).map(|c| c.to_ascii_lowercase()) == Some(pc)) };
    while i < b.len() {
        let up = b[i].is_ascii_uppercase();
        let (rep, n): (&str, usize) = if at(i, "shh") {
            ("щ", 3)
        } else if at(i, "''") {
            ("ъ", 2)
        } else if at(i, "jo") {
            ("ё", 2)
        } else if at(i, "ju") {
            ("ю", 2)
        } else if at(i, "ja") {
            ("я", 2)
        } else if at(i, "jj") {
            ("й", 2)
        } else if at(i, "zh") {
            ("ж", 2)
        } else if at(i, "kh") {
            ("х", 2)
        } else if at(i, "ch") {
            ("ч", 2)
        } else if at(i, "sh") {
            ("ш", 2)
        } else if at(i, "eh") {
            ("э", 2)
        } else {
            let r = match b[i].to_ascii_lowercase() {
                'a' => "а", 'b' => "б", 'v' | 'w' => "в", 'g' => "г", 'd' => "д", 'e' => "е", 'z' => "з", 'i' => "и", 'j' => "й",
                'k' | 'q' => "к", 'l' => "л", 'm' => "м", 'n' => "н", 'o' => "о", 'p' => "п", 'r' => "р", 's' => "с", 't' => "т",
                'u' => "у", 'f' => "ф", 'h' => "х", 'c' => "ц", 'y' => "ы", 'x' => "кс", '\'' => "ь",
                _ => "",
            };
            if r.is_empty() {
                o.push(b[i]);
                i += 1;
                continue;
            }
            (r, 1)
        };
        if up {
            o.extend(rep.chars().flat_map(|c| c.to_uppercase()));
        } else {
            o.push_str(rep);
        }
        i += n;
    }
    o
}

// ───────────────────────────── несколько исполнителей ─────────────────────────────

/// Группы, в чьём названии есть запятая, — их не делим.
const COMMA_NAMES: &[&str] = &[
    "earth, wind & fire", "crosby, stills, nash & young", "crosby, stills & nash", "tyler, the creator",
    "emerson, lake & palmer", "blood, sweat & tears", "peter, paul and mary", "ты, я и он",
];
const ARTIST_SEPS: &[&str] = &[" featuring ", " feat. ", " feat ", " ft. ", " ft ", ",", ";", "/"];
/// Названия с одиночной косой чертой, которые не являются списком исполнителей.
const SLASH_NAMES: &[&str] = &["ac/dc", "au/ra", "n/a"];

/// «A, B feat. C» → [("A", ", "), ("B", " feat. "), ("C", "")] — части и разделитель после каждой.
/// «A / B» и «A/B» — тоже два исполнителя, но «слово//слово» (двойная черта) — одно имя.
pub fn artist_parts(s: &str) -> Vec<(String, String)> {
    let whole = s.trim();
    let low = whole.to_lowercase();
    if whole.is_empty() || COMMA_NAMES.contains(&low.as_str()) || SLASH_NAMES.contains(&low.as_str()) {
        return vec![(whole.to_string(), String::new())];
    }
    let b = whole.as_bytes();
    let mut out: Vec<(String, String)> = Vec::new();
    let (mut start, mut i) = (0usize, 0usize);
    while i < b.len() {
        let hit = ARTIST_SEPS.iter().find(|sep| {
            let n = sep.len();
            if i + n > b.len() || !b[i..i + n].eq_ignore_ascii_case(sep.as_bytes()) {
                return false;
            }
            // одиночная «/» делит, «//» — часть имени
            **sep != "/" || ((i == 0 || b[i - 1] != b'/') && (i + 1 >= b.len() || b[i + 1] != b'/'))
        });
        if let Some(sep) = hit {
            let mut end = i + sep.len();
            while end < b.len() && b[end] == b' ' {
                end += 1;
            }
            let mut st = i;
            while st > start && b[st - 1] == b' ' {
                st -= 1;
            }
            out.push((whole[start..st].trim().to_string(), whole[st..end].to_string()));
            start = end;
            i = end;
        } else {
            i += 1;
        }
    }
    out.push((whole[start..].trim().to_string(), String::new()));
    // «A,» / «,B» / однобуквенные куски — скорее не список исполнителей
    if out.len() > 1 && out.iter().any(|(p, _)| p.chars().count() < 2) {
        return vec![(whole.to_string(), String::new())];
    }
    out
}

/// Исполнители по отдельности: «Баста, Скриптонит» → ["Баста", "Скриптонит"].
pub fn split_artists(s: &str) -> Vec<String> {
    artist_parts(s).into_iter().map(|x| x.0).filter(|x| !x.is_empty()).collect()
}

/// Лучшее написание из вариантов одного исполнителя: кириллица (если исполнитель уже есть по-русски),
/// затем нормальный регистр («Кино», а не «КИНО»/«кино»), затем самое частое.
pub fn best_spelling<'a>(variants: impl Iterator<Item = (&'a str, u32)>) -> Option<&'a str> {
    let nice = |s: &str| {
        let letters: Vec<char> = s.chars().filter(|c| c.is_alphabetic()).collect();
        let up = letters.iter().any(|c| c.is_uppercase());
        let low = letters.iter().any(|c| c.is_lowercase());
        letters.len() <= 3 || up && low
    };
    variants.max_by(|a, b| {
        (has_cyr(a.0), nice(a.0), a.1).cmp(&(has_cyr(b.0), nice(b.0), b.1)).then_with(|| b.0.cmp(a.0))
    }).map(|x| x.0)
}

/// Карта «ключ → каноничное имя» для всех написаний исполнителей: регистр, ё/е, транслит
/// («Kino» = «Кино»), плюс латиница, отличающаяся от русского имени одной буквой (≥ 6 букв).
pub fn canonical_names(votes: &HashMap<String, HashMap<String, u32>>, pinned: &HashMap<String, String>) -> HashMap<String, String> {
    let mut canon: HashMap<String, String> = HashMap::new();
    for (k, sp) in votes {
        let name = pinned.get(k).cloned().or_else(|| best_spelling(sp.iter().map(|(s, n)| (s.as_str(), *n))).map(|s| s.to_string()));
        if let Some(n) = name {
            canon.insert(k.clone(), n);
        }
    }
    let cyr: Vec<(String, String)> = canon.iter().filter(|(_, v)| has_cyr(v)).map(|(k, v)| (k.clone(), v.clone())).collect();
    let lat: Vec<String> = canon.iter().filter(|(k, v)| !has_cyr(v) && !pinned.contains_key(*k) && k.chars().count() >= 6).map(|(k, _)| k.clone()).collect();
    for k in lat {
        let mut hits = cyr.iter().filter(|(ck, _)| lev_bounded(&k, ck, 1).is_some());
        if let (Some(h), None) = (hits.next(), hits.next()) {
            canon.insert(k, h.1.clone());
        }
    }
    canon
}

/// Переписать строку исполнителей каноничными именами, сохранив разделители.
pub fn rewrite_artists(s: &str, canon: &HashMap<String, String>) -> String {
    let parts = artist_parts(s);
    let mut o = String::with_capacity(s.len());
    for (p, sep) in parts {
        let c = canon.get(&key(&p)).map(|x| x.as_str()).unwrap_or(p.as_str());
        o.push_str(c);
        o.push_str(&sep);
    }
    o.trim().to_string()
}

// ───────────────────────────── утилиты ─────────────────────────────

const PLACEHOLDERS: &[&str] = &["неизвестный исполнитель", "без альбома", "unknown artist", "unknown album", "unknown", "<unknown>", "various", "n/a"];

pub(crate) fn is_placeholder(s: &str) -> bool {
    let l = s.trim().to_lowercase();
    PLACEHOLDERS.contains(&l.as_str())
}

fn main_artist(s: &str) -> &str {
    let l = s.to_lowercase();
    let mut cut = s.len();
    for sep in [" feat. ", " feat ", " ft. ", " ft ", " featuring ", ", ", " & ", " x ", " и ", " vs ", " vs. ", " при уч. ", ";", " / "] {
        if let Some(p) = l.find(sep) {
            // индексы lower-строки совпадают с исходной для ASCII-разделителей только если до них нет «растущих» символов
            if p < cut && s.is_char_boundary(p) {
                cut = p;
            }
        }
    }
    s[..cut].trim()
}

fn collapse_ws(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    let mut sp = false;
    for c in s.chars() {
        if c.is_whitespace() {
            sp = true;
        } else {
            if sp && !o.is_empty() {
                o.push(' ');
            }
            sp = false;
            o.push(c);
        }
    }
    o
}

fn tidy(s: &str) -> String {
    let t = collapse_ws(s);
    t.trim_matches(|c: char| c == '-' || c == '_' || c == '|' || c == ',' || c.is_whitespace()).to_string()
}

pub(crate) fn has_cyr(s: &str) -> bool {
    s.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c))
}

fn same_script(a: &str, b: &str) -> bool {
    has_cyr(a) == has_cyr(b)
}

/// Левенштейн с отсечкой: None, если расстояние > max.
pub(crate) fn lev_bounded(a: &str, b: &str, max: usize) -> Option<usize> {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > max {
        return None;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        let mut row_min = cur[0];
        for j in 1..=b.len() {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            row_min = row_min.min(cur[j]);
        }
        if row_min > max {
            return None;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    (prev[b.len()] <= max).then_some(prev[b.len()])
}

// ───────────────────────────── тесты ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn r(stem: &str, k: &Known) -> Output {
        resolve(&Input { stem, ..Default::default() }, k)
    }
    fn rt<'a>(stem: &'a str, title: &'a str, artist: &'a str, album: &'a str, k: &Known) -> Output {
        resolve(&Input { stem, title, artist, album, album_artist: "" }, k)
    }

    #[test]
    fn keys_match_translit() {
        let k = key("тёмный принц");
        assert_eq!(k, key("Темный Принц"));
        assert_eq!(k, key("tjomnyjj princ"));
        assert_eq!(k, key("tyomniy princ"));
        assert_eq!(k, key("temnyjj princ"));
        assert_eq!(key("утекай"), key("utekajj"));
        assert_eq!(key("утекай"), key("utekay"));
    }

    #[test]
    fn domains_cleaned_but_not_names() {
        let k = Known::new();
        assert_eq!(r("Nya", &k).title, "Nya");
        assert_eq!(r("Nyan.com", &k).title, "Nyan.com");
        let o = r("Artist - Nyan.com", &k);
        assert_eq!((o.artist.as_str(), o.title.as_str()), ("Artist", "Nyan.com"));
        let o = r("темный принц - утекай_423141kjfkefjj13", &k);
        assert_eq!((o.artist.as_str(), o.title.as_str()), ("темный принц", "утекай"));
        let o = r("Artist - Song (zaycev.net)", &k);
        assert_eq!(o.title, "Song");
        let o = r("Artist - Song - hitmos.me", &k);
        assert_eq!(o.title, "Song");
        let o = r("www.muzofond.fm Artist - Song", &k);
        assert_eq!((o.artist.as_str(), o.title.as_str()), ("Artist", "Song"));
        let o = r("Artist - Song [Official Video] (1)", &k);
        assert_eq!(o.title, "Song");
        let o = r("Blink-182 - All the Small Things", &k);
        assert_eq!((o.artist.as_str(), o.title.as_str()), ("Blink-182", "All the Small Things"));
        let o = r("01. Artist - Song 2", &k);
        assert_eq!((o.artist.as_str(), o.title.as_str(), o.track_no), ("Artist", "Song 2", 1));
        let o = r("Vol.2", &k);
        assert_eq!(o.title, "Vol.2");
    }

    #[test]
    fn hitmos_no_tags_no_library() {
        let k = Known::new();
        let o = r("tjomnyjj_princ_-_utekajj_81871761", &k);
        assert_eq!((o.artist.as_str(), o.title.as_str()), ("тёмный принц", "утекай"));
    }

    #[test]
    fn tags_cleaned_album_site() {
        let k = Known::new();
        let o = rt("утекай - тёмный принц", "утекай", "тёмный принц", "lmusic.kz", &k);
        assert_eq!((o.artist.as_str(), o.title.as_str(), o.album.as_str()), ("тёмный принц", "утекай", ""));
        let o = rt("x", "Nyan.com", "Nyan Cat", "Nyan.com", &k);
        assert_eq!((o.title.as_str(), o.album.as_str()), ("Nyan.com", "Nyan.com"));
    }

    #[test]
    fn library_aware() {
        let mut k = Known::new();
        k.add_track("тёмный принц", "утекай", "MILITANTUM", 3);
        // источник поставил исполнителя справа
        let o = r("утекай - тёмный принц", &k);
        assert_eq!((o.artist.as_str(), o.title.as_str(), o.album.as_str()), ("тёмный принц", "утекай", "MILITANTUM"));
        assert!(o.swapped);
        assert_eq!(o.confidence, Confidence::High);
        // слаг без разделителя + транслит
        let o = r("tyomniy-princ-utekay-(allmusic.kz)", &k);
        assert_eq!((o.artist.as_str(), o.title.as_str()), ("тёмный принц", "утекай"));
        // другое написание в тегах -> каноничное
        let o = rt("temnyjj-princ-utekajj", "Утекай", "темный принц", "", &k);
        assert_eq!(o.artist, "тёмный принц");
        assert_eq!(o.album, "MILITANTUM");
        // песня с названием «тёмный принц» у другого исполнителя (hitmos: слева всегда исполнитель)
        let o = r("novyjj_artist_-_tjomnyjj_princ_12345678", &k);
        assert_eq!(o.title, "тёмный принц");
        assert!(!o.swapped);
        // перепутанные теги
        let o = rt("x", "тёмный принц", "утекай", "", &k);
        assert_eq!((o.artist.as_str(), o.title.as_str()), ("тёмный принц", "утекай"));
    }

    #[test]
    fn alias() {
        let mut k = Known::new();
        k.add_track("темный принц", "утекай", "", 1);
        k.add_alias("темный принц", "Тёмный Принц");
        let o = r("temnyjj princ - drugaja pesnja", &k);
        assert_eq!(o.artist, "Тёмный Принц");
    }

    #[test]
    fn speed() {
        let mut k = Known::new();
        for i in 0..5000 {
            k.add_track(&format!("Artist number {i}"), &format!("Song {i}"), "Album", 1);
        }
        let t = std::time::Instant::now();
        for i in 0..20000 {
            let s = format!("artist_number_{}_-_song_{}_81871761", i % 5000, i);
            let _ = r(&s, &k);
        }
        let per = t.elapsed().as_secs_f64() / 20000.0 * 1e6;
        eprintln!("namefix: {per:.1} µs/track");
        assert!(per < 500.0);
    }

    #[test]
    fn many_artists() {
        assert_eq!(split_artists("Баста, Скриптонит"), vec!["Баста", "Скриптонит"]);
        assert_eq!(split_artists("Ania feat. Boris; Cleo"), vec!["Ania", "Boris", "Cleo"]);
        assert_eq!(split_artists("Баста / Скриптонит"), vec!["Баста", "Скриптонит"]);
        assert_eq!(split_artists("Баста/Скриптонит"), vec!["Баста", "Скриптонит"]);
        assert_eq!(split_artists("слово//слово"), vec!["слово//слово"]);
        assert_eq!(split_artists("AC/DC"), vec!["AC/DC"]);
        assert_eq!(rewrite_artists("Баста / Скриптонит", &HashMap::new()), "Баста / Скриптонит");
        assert_eq!(split_artists("Earth, Wind & Fire"), vec!["Earth, Wind & Fire"]);
        assert_eq!(split_artists("Simon & Garfunkel"), vec!["Simon & Garfunkel"]);
        let mut votes: HashMap<String, HashMap<String, u32>> = HashMap::new();
        for (n, c) in [("Kino", 5), ("КИНО", 2), ("Кино", 1), ("zemfira", 3), ("Земфира", 1), ("Bastaa", 1), ("Баста", 4), ("Radiohead", 2), ("RADIOHEAD", 1)] {
            *votes.entry(key(n)).or_default().entry(n.to_string()).or_default() += c;
        }
        let canon = canonical_names(&votes, &HashMap::new());
        assert_eq!(rewrite_artists("Kino", &canon), "Кино");
        assert_eq!(rewrite_artists("zemfira, RADIOHEAD", &canon), "Земфира, Radiohead");
        assert_eq!(rewrite_artists("КИНО feat. Bastaa", &canon), "Кино feat. Баста");
    }
}
