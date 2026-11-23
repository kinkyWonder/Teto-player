//! Genres from the internet for albums whose files have no genre tag.
//! iTunes Search API first (album, then a track, then the artist), Deezer as a fallback.
//! Both are free and need no key. Results (also "not found") are cached in `web_genre` by album key,
//! so every album is looked up once; misses are retried after 30 days.
use crate::db::{e, Db, Res};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use std::time::Duration;

pub enum Miss {
    NotFound,
    Network,
}

fn norm(s: &str) -> String {
    s.to_lowercase()
        .replace('ё', "е")
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Artist names match if one contains the other after normalisation ("Тёмный Принц" ~ "темный принц").
fn same_artist(a: &str, b: &str) -> bool {
    let (a, b) = (norm(a), norm(b));
    !a.is_empty() && !b.is_empty() && (a == b || a.contains(&b) || b.contains(&a))
}

fn useful(g: &str) -> Option<String> {
    let g = g.trim();
    if g.is_empty() || g.eq_ignore_ascii_case("music") || g.eq_ignore_ascii_case("музыка") {
        None
    } else {
        Some(g.to_string())
    }
}

fn get(agent: &ureq::Agent, url: &str, q: &[(&str, &str)]) -> Result<Value, Miss> {
    let mut r = agent.get(url);
    for (k, v) in q {
        r = r.query(k, v);
    }
    match r.call() {
        Ok(resp) => resp.into_json::<Value>().map_err(|_| Miss::Network),
        Err(ureq::Error::Status(404, _)) => Err(Miss::NotFound),
        Err(_) => Err(Miss::Network),
    }
}

fn itunes(agent: &ureq::Agent, term: &str, entity: &str, artist: &str, want: Option<&str>) -> Result<Option<String>, Miss> {
    let v = get(agent, "https://itunes.apple.com/search", &[("term", term), ("entity", entity), ("limit", "10"), ("media", "music")])?;
    let empty = vec![];
    let list = v.get("results").and_then(|x| x.as_array()).unwrap_or(&empty);
    let mut fallback = None;
    for r in list {
        let an = r.get("artistName").and_then(|x| x.as_str()).unwrap_or("");
        if !same_artist(an, artist) {
            continue;
        }
        let Some(g) = r.get("primaryGenreName").and_then(|x| x.as_str()).and_then(useful) else { continue };
        let name = r.get("collectionName").or_else(|| r.get("trackName")).and_then(|x| x.as_str()).unwrap_or("");
        match want {
            Some(w) if !norm(name).contains(&norm(w)) && !norm(w).contains(&norm(name)) => {
                fallback.get_or_insert(g);
            }
            _ => return Ok(Some(g)),
        }
    }
    Ok(fallback)
}

fn deezer(agent: &ureq::Agent, artist: &str, album: &str, title: &str) -> Result<Option<String>, Miss> {
    let q = if !album.is_empty() { format!("artist:\"{artist}\" album:\"{album}\"") } else { format!("artist:\"{artist}\" track:\"{title}\"") };
    let v = get(agent, "https://api.deezer.com/search", &[("q", &q), ("limit", "5")])?;
    let empty = vec![];
    for r in v.get("data").and_then(|x| x.as_array()).unwrap_or(&empty) {
        let an = r.pointer("/artist/name").and_then(|x| x.as_str()).unwrap_or("");
        if !same_artist(an, artist) {
            continue;
        }
        let Some(id) = r.pointer("/album/id").and_then(|x| x.as_i64()) else { continue };
        std::thread::sleep(Duration::from_millis(250));
        let a = get(agent, &format!("https://api.deezer.com/album/{id}"), &[])?;
        if let Some(g) = a.pointer("/genres/data/0/name").and_then(|x| x.as_str()).and_then(useful) {
            return Ok(Some(g));
        }
    }
    Ok(None)
}

/// Look up a genre for an album (or a single, then `title` is used).
pub fn lookup(agent: &ureq::Agent, artist: &str, album: &str, title: &str) -> Result<Option<String>, Miss> {
    let pause = || std::thread::sleep(Duration::from_millis(300)); // be polite: ~3 requests/s at most
    let single = album.is_empty() || album == crate::namefix_db::NO_ALBUM;
    if !single {
        if let Some(g) = itunes(agent, &format!("{artist} {album}"), "album", artist, Some(album))? {
            return Ok(Some(g));
        }
        pause();
    }
    if !title.is_empty() {
        if let Some(g) = itunes(agent, &format!("{artist} {title}"), "song", artist, None)? {
            return Ok(Some(g));
        }
        pause();
    }
    if let Some(g) = deezer(agent, artist, if single { "" } else { album }, title)? {
        return Ok(Some(g));
    }
    pause();
    itunes(agent, artist, "musicArtist", artist, None)
}

// ---------------------------------------------------------------- album track lists ("Hints")
// Same algorithm as src/mobile/backend/web.ts: iTunes (Russian store first for Russian names) → Deezer,
// fuzzy names (Кино ~ Kino, "(Deluxe)", "- EP", feat.), Latin names are also searched in Cyrillic.

fn lat(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        o.push_str(match c {
            'а' => "a", 'б' => "b", 'в' => "v", 'г' => "g", 'д' => "d", 'е' => "e", 'ж' => "zh", 'з' => "z", 'и' => "i", 'й' => "i",
            'к' => "k", 'л' => "l", 'м' => "m", 'н' => "n", 'о' => "o", 'п' => "p", 'р' => "r", 'с' => "s", 'т' => "t", 'у' => "u",
            'ф' => "f", 'х' => "h", 'ц' => "c", 'ч' => "ch", 'ш' => "sh", 'щ' => "sch", 'ъ' | 'ь' => "", 'ы' => "y", 'э' => "e",
            'ю' => "yu", 'я' => "ya",
            _ => {
                o.push(c);
                continue;
            }
        });
    }
    let o = o.replace("kh", "h").replace("ts", "c").replace("w", "v").replace("x", "ks").replace("q", "k");
    // "ya"/"ja" → "a", then the remaining j/y → i, then double letters → one
    let ch: Vec<char> = o.chars().collect();
    let mut t = String::new();
    let mut i = 0;
    while i < ch.len() {
        let c = ch[i];
        if (c == 'y' || c == 'j') && i + 1 < ch.len() && "auoe".contains(ch[i + 1]) {
            i += 1;
            continue;
        }
        t.push(if c == 'y' || c == 'j' { 'i' } else { c });
        i += 1;
    }
    let mut out = String::new();
    for c in t.chars() {
        if out.chars().last() != Some(c) {
            out.push(c);
        }
    }
    out
}

const EXTRA_WORDS: [&str; 15] = ["deluxe", "remaster", "edition", "version", "expanded", "bonus", "anniversary", "explicit", "clean", "special", "reissue", "делюкс", "издание", "версия", "remastered"];

/// "Album (Deluxe Edition) - EP" → "Album".
fn strip_extra(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(['(', '[']) {
        let close = if rest[i..].starts_with('(') { ')' } else { ']' };
        match rest[i..].find(close) {
            Some(j) => {
                let inner = rest[i + 1..i + j].to_lowercase();
                out.push_str(&rest[..i]);
                if !EXTRA_WORDS.iter().any(|w| inner.contains(w)) && !["single", "ep"].contains(&inner.trim()) {
                    out.push_str(&rest[i..i + j + 1]);
                }
                rest = &rest[i + j + 1..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    let mut t = out.trim().to_string();
    for suf in [" - Single", " - EP", " - single", " - ep", " - Сингл", " - сингл"] {
        if let Some(x) = t.strip_suffix(suf) {
            t = x.trim().to_string();
        }
    }
    t
}

fn akey(s: &str) -> String {
    lat(&norm(&strip_extra(s)))
}

/// 3 = same album, 2 = one name starts with / contains the other, 0 = different.
fn album_score(cand: &str, want: &str) -> u8 {
    let (a, b) = (akey(cand), akey(want));
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    if a == b || norm(cand) == norm(want) {
        return 3;
    }
    let m = a.chars().count().min(b.chars().count());
    if m > 2 && (a.starts_with(&b) || b.starts_with(&a)) {
        return 2;
    }
    if m > 4 && (a.contains(&b) || b.contains(&a)) {
        return 2;
    }
    0
}

fn artist_parts(s: &str) -> Vec<String> {
    let l = s.to_lowercase();
    let mut l = format!(" {l} ");
    for sep in [",", "&", "/", " feat. ", " feat ", " ft. ", " ft ", " x ", " и ", " and "] {
        l = l.replace(sep, "\u{1}");
    }
    l.split('\u{1}').map(|x| lat(&norm(x))).filter(|x| x.chars().count() > 1).collect()
}

fn artist_ok(cand: &str, want: &str) -> bool {
    if same_artist(cand, want) {
        return true;
    }
    let (a, b) = (artist_parts(cand), artist_parts(want));
    a.iter().any(|x| b.iter().any(|y| x == y || (x.chars().count().min(y.chars().count()) > 3 && (x.contains(y.as_str()) || y.contains(x.as_str())))))
}

fn has_cyr(s: &str) -> bool {
    s.chars().any(|c| ('а'..='я').contains(&c) || ('А'..='Я').contains(&c) || c == 'ё' || c == 'Ё')
}

/// "Gruppa krovi" → "группа крови" (rough, only for searching).
fn to_cyr(s: &str) -> String {
    let mut x = s.to_lowercase();
    for (a, b) in [("shch", "щ"), ("sch", "щ"), ("zh", "ж"), ("ch", "ч"), ("sh", "ш"), ("kh", "х"), ("ts", "ц"), ("ya", "я"), ("ja", "я"), ("yu", "ю"), ("ju", "ю"), ("yo", "ё"), ("jo", "ё")] {
        x = x.replace(a, b);
    }
    x.chars()
        .map(|c| match c {
            'a' => "а".to_string(), 'b' => "б".into(), 'v' | 'w' => "в".into(), 'g' => "г".into(), 'd' => "д".into(), 'e' => "е".into(),
            'z' => "з".into(), 'i' => "и".into(), 'j' => "й".into(), 'k' | 'c' | 'q' => "к".into(), 'l' => "л".into(), 'm' => "м".into(),
            'n' => "н".into(), 'o' => "о".into(), 'p' => "п".into(), 'r' => "р".into(), 's' => "с".into(), 't' => "т".into(), 'u' => "у".into(),
            'f' => "ф".into(), 'h' => "х".into(), 'y' => "ы".into(), 'x' => "кс".into(),
            _ => c.to_string(),
        })
        .collect()
}

/// Best album among search results: highest score, then most tracks (deluxe ≥ standard).
fn best_of<'a>(list: &'a [Value], artist: &str, album: &str, f: impl Fn(&Value) -> (String, String, i64)) -> Option<(&'a Value, u8)> {
    let mut best: Option<(&Value, u8, i64)> = None;
    for r in list {
        let (an, title, n) = f(r);
        if !artist_ok(&an, artist) {
            continue;
        }
        let sc = album_score(&title, album);
        if sc == 0 {
            continue;
        }
        if best.map_or(true, |(_, bs, bn)| sc > bs || (sc == bs && n > bn)) {
            best = Some((r, sc, n));
        }
    }
    best.map(|(r, s, _)| (r, s))
}

fn is_ascii_latin(s: &str) -> bool {
    s.is_ascii() && !has_cyr(s)
}

fn itunes_tl(agent: &ureq::Agent, artist: &str, album: &str) -> Option<(Value, u8)> {
    let countries: &[&str] = if has_cyr(&format!("{artist}{album}")) { &["ru", "kz", "us"] } else { &["us", "ru"] };
    let a0 = strip_extra(album);
    let mut top: Option<(Value, u8)> = None;
    for c in countries {
        let mut terms = vec![format!("{artist} {a0}"), a0.clone(), artist.to_string()];
        if *c == "ru" && is_ascii_latin(&format!("{artist}{album}")) {
            terms.push(format!("{} {}", to_cyr(artist), to_cyr(&a0)));
        }
        for term in terms {
            // 403 = too many requests: stop, Deezer takes over
            let Ok(v) = get(agent, "https://itunes.apple.com/search", &[("term", &term), ("entity", "album"), ("limit", "50"), ("media", "music"), ("country", c)]) else { return top };
            let empty = vec![];
            let res = v["results"].as_array().unwrap_or(&empty);
            if let Some((hit, sc)) = best_of(res, artist, album, |r| {
                (r["artistName"].as_str().unwrap_or("").to_string(), r["collectionName"].as_str().unwrap_or("").to_string(), r["trackCount"].as_i64().unwrap_or(0))
            }) {
                if sc > top.as_ref().map_or(0, |t| t.1) {
                    if let Some(id) = hit["collectionId"].as_i64() {
                        if let Ok(l) = get(agent, "https://itunes.apple.com/lookup", &[("id", &id.to_string()), ("entity", "song"), ("country", c)]) {
                            let tracks: Vec<Value> = l["results"]
                                .as_array()
                                .unwrap_or(&empty)
                                .iter()
                                .filter(|r| r["wrapperType"].as_str() == Some("track") && r["trackName"].is_string())
                                .map(|r| {
                                    serde_json::json!({
                                        "no": r["trackNumber"].as_i64().unwrap_or(0),
                                        "disc": r["discNumber"].as_i64().unwrap_or(1),
                                        "title": r["trackName"].as_str().unwrap_or(""),
                                        "dur": r["trackTimeMillis"].as_i64().unwrap_or(0) / 1000,
                                    })
                                })
                                .collect();
                            if !tracks.is_empty() {
                                top = Some((serde_json::json!({ "album": hit["collectionName"].as_str().unwrap_or(album), "tracks": tracks }), sc));
                            }
                        }
                    }
                }
            }
            if top.as_ref().map_or(0, |t| t.1) == 3 {
                return top;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    top
}

fn deezer_tl(agent: &ureq::Agent, artist: &str, album: &str) -> Option<(Value, u8)> {
    let a0 = strip_extra(album);
    let mut qs = vec![format!("artist:\"{artist}\" album:\"{a0}\""), format!("{artist} {a0}"), a0.clone()];
    if is_ascii_latin(&format!("{artist}{album}")) {
        qs.push(format!("{} {}", to_cyr(artist), to_cyr(&a0)));
    }
    let mut pick: Option<(Value, u8)> = None;
    for q in qs {
        if let Ok(v) = get(agent, "https://api.deezer.com/search/album", &[("q", &q), ("limit", "25")]) {
            let empty = vec![];
            let res = v["data"].as_array().unwrap_or(&empty);
            if let Some((hit, sc)) = best_of(res, artist, album, |r| {
                (r.pointer("/artist/name").and_then(|x| x.as_str()).unwrap_or("").to_string(), r["title"].as_str().unwrap_or("").to_string(), r["nb_tracks"].as_i64().unwrap_or(0))
            }) {
                if sc > pick.as_ref().map_or(0, |p| p.1) {
                    pick = Some((hit.clone(), sc));
                }
            }
        }
        if pick.as_ref().map_or(0, |p| p.1) == 3 {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let (hit, sc) = pick?;
    let id = hit["id"].as_i64()?;
    let l = get(agent, &format!("https://api.deezer.com/album/{id}/tracks"), &[("limit", "300")]).ok()?;
    let tracks: Vec<Value> = l["data"]
        .as_array()?
        .iter()
        .enumerate()
        .filter(|(_, r)| r["title"].is_string())
        .map(|(i, r)| {
            serde_json::json!({
                "no": r["track_position"].as_i64().unwrap_or(i as i64 + 1),
                "disc": r["disk_number"].as_i64().unwrap_or(1),
                "title": r["title"].as_str().unwrap_or(""),
                "dur": r["duration"].as_i64().unwrap_or(0),
            })
        })
        .collect();
    if tracks.is_empty() {
        return None;
    }
    Some((serde_json::json!({ "album": hit["title"].as_str().unwrap_or(album), "tracks": tracks }), sc))
}

/// Full track list of an album: `{ album, tracks: [{ no, disc, title, dur }] }` (iTunes, then Deezer).
pub fn tracklist(agent: &ureq::Agent, artist: &str, album: &str) -> Option<Value> {
    let mut hit = itunes_tl(agent, artist, album);
    if hit.as_ref().map_or(0, |h| h.1) < 3 {
        if let Some(d) = deezer_tl(agent, artist, album) {
            if d.1 > hit.as_ref().map_or(0, |h| h.1) {
                hit = Some(d);
            }
        }
    }
    let (mut v, _) = hit?;
    if let Some(t) = v["tracks"].as_array_mut() {
        t.sort_by_key(|t| (t["disc"].as_i64().unwrap_or(1), t["no"].as_i64().unwrap_or(0)));
    }
    Some(v)
}

/// Next album without a tag genre and without a (fresh) web lookup: (key, artist, album, one track title).
pub fn next_missing(db: &Db) -> Option<(String, String, String, String)> {
    let now = now();
    db.conn
        .lock()
        .query_row(
            "SELECT a.key, a.artist, a.title, coalesce((SELECT t.title FROM tracks t WHERE t.album_id=a.id ORDER BY t.no LIMIT 1),'')
             FROM albums a LEFT JOIN web_genre w ON w.key=a.key
             WHERE coalesce(a.genre,'')='' AND a.artist<>?1 AND (w.key IS NULL OR (w.genre='' AND w.at < ?2))
             ORDER BY a.played DESC, a.added DESC LIMIT 1",
            params![crate::namefix_db::UNKNOWN_ARTIST, now - 30 * 86400],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .ok()
        .flatten()
}

/// Album that still has no genre after the internet lookup (or when lookups are off / the artist is
/// unknown) and was not analysed yet — its genre will be guessed by the sound (dsp::analyze).
pub fn next_unanalysed(db: &Db, web: bool) -> Option<i64> {
    db.conn
        .lock()
        .query_row(
            "SELECT a.id FROM albums a LEFT JOIN web_genre w ON w.key=a.key
             WHERE coalesce(a.genre,'')='' AND a.analysis IS NULL
               AND (?1=0 OR a.artist=?2 OR (w.key IS NOT NULL AND w.genre=''))
             ORDER BY a.played DESC, a.added DESC LIMIT 1",
            params![web as i64, crate::namefix_db::UNKNOWN_ARTIST],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

pub fn save(db: &Db, key: &str, genre: &str) -> Res<()> {
    db.conn
        .lock()
        .execute(
            "INSERT INTO web_genre(key,genre,at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET genre=excluded.genre, at=excluded.at",
            params![key, genre, now()],
        )
        .map_err(e)?;
    Ok(())
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn artist_match() {
        assert!(same_artist("тёмный принц", "Темный Принц"));
        assert!(same_artist("Radiohead", "radiohead"));
        assert!(!same_artist("Radiohead", "Muse"));
    }
    #[test]
    fn fuzzy_albums() {
        assert!(album_score("Группа крови", "Gruppa krovi") > 0);
        assert!(album_score("Vendetta (Deluxe Edition)", "Vendetta") > 0);
        assert!(album_score("Abbey Road", "Help!") == 0);
        assert!(artist_ok("Кино", "Kino"));
        assert!(artist_ok("Земфира feat. X", "Земфира"));
        assert_eq!(to_cyr("Gruppa krovi"), "группа крови");
    }
    #[test]
    #[ignore] // network
    fn live() {
        let a = crate::lyrics::agent();
        for (ar, al, t) in [("Radiohead", "OK Computer", "Airbag"), ("тёмный принц", "MILITANTUM", "утекай"), ("Кино", "Группа крови", "Группа крови"), ("Aphex Twin", "Без альбома", "Avril 14th")] {
            let g = lookup(&a, ar, al, t).ok().flatten();
            println!("{ar} / {al} -> {g:?}");
        }
    }
}
