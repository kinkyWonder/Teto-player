//! namefix_db — связка `namefix` с базой Teto Player (SQLite) и сканером.
//!
//! * `migrate` — новые таблицы + одноразовая пометка «грязных» треков на перечитывание.
//! * `Ctx` — контекст одного сканирования: индекс известных исполнителей/треков, ручные правки, алиасы.
//! * Ручное переименование: `set_track_names`, `swap_artist_title`, `rename_artist` (глобально),
//!   `set_artist_photo` / `artist_photo`, `needs_review`.
//!
//! Ручные правки пользователя хранятся отдельно (`name_overrides`, `artist_aliases`) и всегда
//! имеют приоритет над автоматикой — пересканирование их не откатывает. Сами аудиофайлы не изменяются.
use crate::db::{e, Db, Meta, Res};
use crate::namefix::{self, Confidence, Input, Known, Origin, Output};
use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;

pub const UNKNOWN_ARTIST: &str = "Неизвестный исполнитель";
pub const NO_ALBUM: &str = "Без альбома";
/// Поднимите версию, если правила очистки сильно изменились — «грязные» треки перечитаются один раз.
const VERSION: &str = "1";

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS name_overrides(path TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT, updated INTEGER);
CREATE TABLE IF NOT EXISTS artist_aliases(key TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS name_guess(path TEXT PRIMARY KEY, confidence INTEGER NOT NULL, origin TEXT NOT NULL, swapped INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS artist_info(key TEXT PRIMARY KEY, name TEXT NOT NULL, photo TEXT);
"#;

/// Вызвать один раз после `Db::open`.
pub fn migrate(db: &Db) -> Res<()> {
    db.conn.lock().execute_batch(SCHEMA).map_err(e)?;
    if db.kv_get("namefix_version").as_deref() != Some(VERSION) {
        let dirty: Vec<i64> = {
            let c = db.conn.lock();
            let mut st = c.prepare("SELECT id, coalesce(title,''), coalesce(artist,''), coalesce(album,'') FROM tracks").map_err(e)?;
            let rows = st
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))
                .map_err(e)?;
            rows.filter_map(|x| x.ok()).filter(|(_, t, a, al)| namefix::looks_dirty(t, a, if al == NO_ALBUM { "" } else { al })).map(|x| x.0).collect()
        };
        if !dirty.is_empty() {
            let mut c = db.conn.lock();
            let tx = c.transaction().map_err(e)?;
            {
                let mut st = tx.prepare("UPDATE tracks SET mtime=-1 WHERE id=?").map_err(e)?;
                for id in &dirty {
                    st.execute([id]).map_err(e)?;
                }
            }
            tx.commit().map_err(e)?;
        }
        db.kv_set("namefix_version", VERSION);
    }
    Ok(())
}

#[derive(Clone, Debug, Default)]
struct Ov {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
}

/// Контекст сканирования. Создать один раз в начале `Scanner::run`.
pub struct Ctx {
    pub known: Known,
    overrides: HashMap<String, Ov>,
    /// (путь, размер индекса на момент разбора) — сомнительные треки, которые стоит разобрать повторно в конце.
    recheck: Vec<(String, usize)>,
    guesses: Vec<(String, Option<(Confidence, Origin, bool)>)>,
}

impl Ctx {
    pub fn load(db: &Db) -> Ctx {
        let mut known = Known::new();
        let mut overrides = HashMap::new();
        let c = db.conn.lock();
        if let Ok(mut st) = c.prepare(
            "SELECT artist, title, album, count(*) FROM tracks WHERE artist IS NOT NULL AND artist<>'' AND artist<>?1 GROUP BY artist, title, album",
        ) {
            if let Ok(rows) = st.query_map([UNKNOWN_ARTIST], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(), r.get::<_, Option<String>>(2)?.unwrap_or_default(), r.get::<_, u32>(3)?))
            }) {
                for (a, t, al, n) in rows.flatten() {
                    known.add_track(&a, &t, if al == NO_ALBUM { "" } else { &al }, n);
                }
            }
        }
        if let Ok(mut st) = c.prepare("SELECT key, name FROM artist_aliases") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                for (k, n) in rows.flatten() {
                    known.add_alias(&k, &n);
                }
            }
        }
        if let Ok(mut st) = c.prepare("SELECT path, title, artist, album FROM name_overrides") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, Ov { title: r.get(1)?, artist: r.get(2)?, album: r.get(3)? }))) {
                for (p, o) in rows.flatten() {
                    overrides.insert(p, o);
                }
            }
        }
        Ctx { known, overrides, recheck: Vec::new(), guesses: Vec::new() }
    }

    /// Разобрать пачку только что прочитанных (`tags::read_raw`) метаданных. Сначала учатся надёжные
    /// треки с тегами, затем разбираются остальные — так новые исполнители из той же пачки уже известны.
    pub fn apply(&mut self, metas: &mut [Meta]) {
        self.apply_inner(metas, true)
    }

    fn apply_inner(&mut self, metas: &mut [Meta], first_pass: bool) {
        let mut done: Vec<Option<Output>> = vec![None; metas.len()];
        for (i, m) in metas.iter().enumerate() {
            if !m.title.trim().is_empty() && !m.artist.trim().is_empty() && !self.overrides.contains_key(&m.path) {
                let o = namefix::resolve(&input(m, &stem(&m.path)), &self.known);
                self.known.add_track(&o.artist, &o.title, &o.album, 1);
                done[i] = Some(o);
            }
        }
        // альбом-мусор (`lmusic.kz`) мог вычиститься до того, как в индекс попала копия трека с альбомом
        for (i, m) in metas.iter().enumerate() {
            if done[i].as_ref().map_or(false, |o| o.album.is_empty()) {
                done[i] = Some(namefix::resolve(&input(m, &stem(&m.path)), &self.known));
            }
        }
        for (i, m) in metas.iter_mut().enumerate() {
            let o = match done[i].take() {
                Some(o) => o,
                None => {
                    let o = namefix::resolve(&input(m, &stem(&m.path)), &self.known);
                    // учимся только на уверенных результатах — иначе догадка подтверждала бы сама себя
                    if o.confidence == Confidence::High && !o.artist.is_empty() {
                        self.known.add_track(&o.artist, &o.title, &o.album, 1);
                    }
                    if first_pass && (o.confidence < Confidence::High) {
                        self.recheck.push((m.path.clone(), self.known.artist_count()));
                    }
                    o
                }
            };
            let ov = self.overrides.get(&m.path).cloned();
            apply_output(m, &o);
            let mut user = false;
            if let Some(ov) = ov {
                if let Some(t) = ov.title.filter(|s| !s.is_empty()) {
                    m.title = t;
                    user = true;
                }
                if let Some(a) = ov.artist.filter(|s| !s.is_empty()) {
                    m.artist = a;
                    user = true;
                }
                if let Some(al) = ov.album.filter(|s| !s.is_empty()) {
                    m.album = al;
                    user = true;
                }
            }
            let flag = if user {
                None
            } else if o.confidence == Confidence::High && o.origin == Origin::Tags && !o.swapped {
                None
            } else {
                Some((o.confidence, o.origin, o.swapped))
            };
            self.guesses.push((m.path.clone(), flag));
        }
    }

    /// Пути, которые стоит перечитать в конце сканирования: индекс с тех пор пополнился.
    pub fn take_recheck(&mut self) -> Vec<String> {
        let n = self.known.artist_count();
        std::mem::take(&mut self.recheck).into_iter().filter(|(_, at)| *at < n).map(|x| x.0).collect()
    }

    /// Повторный разбор (без новой очереди на перепроверку).
    pub fn apply_final(&mut self, metas: &mut [Meta]) {
        self.apply_inner(metas, false)
    }

    /// Сохранить пометки уверенности (для значка «проверьте» в UI). Вызвать в конце сканирования.
    pub fn flush(&mut self, db: &Db) -> Res<()> {
        if self.guesses.is_empty() {
            return Ok(());
        }
        let mut c = db.conn.lock();
        let tx = c.transaction().map_err(e)?;
        {
            let mut del = tx.prepare_cached("DELETE FROM name_guess WHERE path=?").map_err(e)?;
            let mut ins = tx.prepare_cached("INSERT OR REPLACE INTO name_guess(path,confidence,origin,swapped) VALUES(?,?,?,?)").map_err(e)?;
            for (p, f) in self.guesses.drain(..) {
                match f {
                    None => {
                        del.execute([&p]).map_err(e)?;
                    }
                    Some((c, o, s)) => {
                        let o = match o {
                            Origin::Tags => "tags",
                            Origin::TagsCleaned => "tags_cleaned",
                            Origin::FileName => "filename",
                        };
                        ins.execute(params![p, c as i64, o, s as i64]).map_err(e)?;
                    }
                }
            }
        }
        tx.commit().map_err(e)
    }
}

fn stem(path: &str) -> String {
    Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn input<'a>(m: &'a Meta, stem: &'a str) -> Input<'a> {
    Input { stem, title: &m.title, artist: &m.artist, album: &m.album, album_artist: &m.album_artist }
}

/// Записать результат в Meta и подставить стандартные заглушки приложения.
pub fn apply_output(m: &mut Meta, o: &Output) {
    m.title = o.title.clone();
    m.artist = o.artist.clone();
    m.album = o.album.clone();
    m.album_artist = o.album_artist.clone();
    if m.no == 0 {
        m.no = o.track_no;
    }
    if m.title.is_empty() {
        m.title = stem(&m.path);
    }
    if m.artist.is_empty() {
        m.artist = if m.album_artist.is_empty() { UNKNOWN_ARTIST.into() } else { m.album_artist.clone() };
    }
    if m.album.is_empty() {
        let folder = Path::new(&m.path).parent().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        m.album = if folder.is_empty() { NO_ALBUM.into() } else { folder };
    }
}

/// Для одиночного чтения вне сканера (CLI и т.п.): разбор без индекса библиотеки.
pub fn finalize_one(m: &mut Meta) {
    let o = namefix::resolve(&input(m, &stem(&m.path)), &Known::new());
    apply_output(m, &o);
}

// ───────────────────────────── ручное переименование ─────────────────────────────

fn refresh_fts(tx: &rusqlite::Connection, id: i64) -> Res<()> {
    tx.execute("DELETE FROM fts WHERE rowid=?", [id]).map_err(e)?;
    tx.execute(
        "INSERT INTO fts(rowid,title,artist,album) SELECT id, title,
           CASE WHEN album_artist IS NULL OR album_artist='' OR album_artist=artist THEN artist ELSE artist||' '||album_artist END, album
         FROM tracks WHERE id=?",
        [id],
    )
    .map_err(e)?;
    Ok(())
}

/// Переименовать один трек (None = поле не трогать). Правка запоминается и переживает пересканирование.
pub fn set_track_names(db: &Db, id: i64, title: Option<&str>, artist: Option<&str>, album: Option<&str>) -> Res<()> {
    let norm = |x: Option<&str>| x.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let (title, artist, album) = (norm(title), norm(artist), norm(album));
    {
        let mut c = db.conn.lock();
        let tx = c.transaction().map_err(e)?;
        let path: String = tx.query_row("SELECT path FROM tracks WHERE id=?", [id], |r| r.get(0)).map_err(e)?;
        tx.execute(
            "INSERT INTO name_overrides(path,title,artist,album,updated) VALUES(?1,?2,?3,?4,strftime('%s','now'))
             ON CONFLICT(path) DO UPDATE SET title=coalesce(excluded.title,title), artist=coalesce(excluded.artist,artist),
             album=coalesce(excluded.album,album), updated=excluded.updated",
            params![path, title, artist, album],
        )
        .map_err(e)?;
        tx.execute(
            "UPDATE tracks SET title=coalesce(?1,title), artist=coalesce(?2,artist), album=coalesce(?3,album) WHERE id=?4",
            params![title, artist, album, id],
        )
        .map_err(e)?;
        tx.execute("DELETE FROM name_guess WHERE path=?", [&path]).map_err(e)?;
        refresh_fts(&tx, id)?;
        tx.commit().map_err(e)?;
    }
    db.rebuild_albums()
}

/// «Поменять местами исполнителя и название».
pub fn swap_artist_title(db: &Db, id: i64) -> Res<()> {
    let (t, a): (String, String) = db.conn.lock().query_row("SELECT title, artist FROM tracks WHERE id=?", [id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
    set_track_names(db, id, Some(&a), Some(&t), None)
}

/// Глобально переименовать исполнителя (все треки, альбомы, будущие сканирования). Переименование в уже
/// существующее имя объединяет исполнителей. Возвращает число изменённых треков.
pub fn rename_artist(db: &Db, old: &str, new: &str) -> Res<usize> {
    let new = new.trim();
    if new.is_empty() {
        return Err("пустое имя".into());
    }
    let old_l = old.trim().to_lowercase();
    let n;
    {
        let mut c = db.conn.lock();
        let tx = c.transaction().map_err(e)?;
        let rows: Vec<(i64, String, String, String)> = {
            let mut st = tx.prepare("SELECT id, path, coalesce(artist,''), coalesce(album_artist,'') FROM tracks").map_err(e)?;
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(e)?.filter_map(|x| x.ok()).collect();
            v
        };
        let mut cnt = 0;
        for (id, path, a, aa) in rows {
            let hit_a = a.to_lowercase() == old_l;
            let hit_aa = aa.to_lowercase() == old_l;
            if !hit_a && !hit_aa {
                continue;
            }
            if hit_a {
                tx.execute("UPDATE tracks SET artist=? WHERE id=?", params![new, id]).map_err(e)?;
                tx.execute("UPDATE name_overrides SET artist=? WHERE path=? AND artist IS NOT NULL", params![new, path]).map_err(e)?;
            }
            if hit_aa {
                tx.execute("UPDATE tracks SET album_artist=? WHERE id=?", params![new, id]).map_err(e)?;
            }
            refresh_fts(&tx, id)?;
            cnt += 1;
        }
        tx.execute("INSERT OR REPLACE INTO artist_aliases(key,name) VALUES(?,?)", params![namefix::key(old), new]).map_err(e)?;
        tx.execute("UPDATE artist_aliases SET name=? WHERE lower(name)=lower(?)", params![new, old.trim()]).map_err(e)?;
        // фото исполнителя переезжает вместе с именем (если у нового имени своего нет)
        let ok = namefix::key(old);
        let nk = namefix::key(new);
        if ok != nk {
            tx.execute("INSERT OR IGNORE INTO artist_info(key,name,photo) SELECT ?, ?, photo FROM artist_info WHERE key=?", params![nk, new, ok]).map_err(e)?;
        }
        tx.execute("UPDATE artist_info SET name=? WHERE key=?", params![new, nk]).map_err(e)?;
        tx.commit().map_err(e)?;
        n = cnt;
    }
    db.rebuild_albums()?;
    Ok(n)
}

/// Свести разные написания одного исполнителя к одному: регистр, ё/е, транслит («Kino» → «Кино», если
/// по-русски он уже есть), каждая часть «A, B» по отдельности. Глобальные переименования пользователя
/// главнее, ручные правки отдельных треков не трогаем. Вызывается после сканирования и при запуске.
/// Возвращает число изменённых треков (альбомы пересобираются, если что-то поменялось).
pub fn unify_artists(db: &Db) -> Res<usize> {
    let n;
    {
        let mut c = db.conn.lock();
        let tx = c.transaction().map_err(e)?;
        let rows: Vec<(i64, String, String, String)> = {
            let mut st = tx.prepare("SELECT id, path, coalesce(artist,''), coalesce(album_artist,'') FROM tracks").map_err(e)?;
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(e)?.filter_map(|x| x.ok()).collect();
            v
        };
        let manual: std::collections::HashSet<String> = {
            let mut st = tx.prepare("SELECT path FROM name_overrides WHERE artist IS NOT NULL").map_err(e)?;
            let v = st.query_map([], |r| r.get(0)).map_err(e)?.filter_map(|x| x.ok()).collect();
            v
        };
        let mut pinned: HashMap<String, String> = HashMap::new();
        {
            let mut st = tx.prepare("SELECT key, name FROM artist_aliases").map_err(e)?;
            for (k, name) in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?.flatten() {
                pinned.insert(namefix::key(&name), name.clone());
                pinned.insert(k, name);
            }
        }
        let mut votes: HashMap<String, HashMap<String, u32>> = HashMap::new();
        for (_, _, a, aa) in &rows {
            for part in namefix::split_artists(a).into_iter().chain(namefix::split_artists(aa)) {
                if part == UNKNOWN_ARTIST || namefix::is_placeholder(&part) {
                    continue;
                }
                let k = namefix::key(&part);
                if !k.is_empty() {
                    *votes.entry(k).or_default().entry(part).or_default() += 1;
                }
            }
        }
        let canon = namefix::canonical_names(&votes, &pinned);
        let mut cnt = 0;
        for (id, path, a, aa) in rows {
            let na = if manual.contains(&path) || a.is_empty() { a.clone() } else { namefix::rewrite_artists(&a, &canon) };
            let naa = if aa.is_empty() { aa.clone() } else { namefix::rewrite_artists(&aa, &canon) };
            if na == a && naa == aa {
                continue;
            }
            tx.execute("UPDATE tracks SET artist=?, album_artist=? WHERE id=?", params![na, naa, id]).map_err(e)?;
            refresh_fts(&tx, id)?;
            cnt += 1;
        }
        tx.commit().map_err(e)?;
        n = cnt;
    }
    if n > 0 {
        db.rebuild_albums()?;
    }
    Ok(n)
}

/// Своё фото исполнителя (путь к уже скопированному в кэш приложения файлу). None — убрать фото.
pub fn set_artist_photo(db: &Db, name: &str, photo: Option<&str>) -> Res<()> {
    db.conn
        .lock()
        .execute(
            "INSERT INTO artist_info(key,name,photo) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET photo=excluded.photo, name=excluded.name",
            params![namefix::key(name), name.trim(), photo],
        )
        .map_err(e)?;
    Ok(())
}

pub fn artist_photo(db: &Db, name: &str) -> Option<String> {
    db.conn.lock().query_row("SELECT photo FROM artist_info WHERE key=?", [namefix::key(name)], |r| r.get::<_, Option<String>>(0)).optional().ok().flatten().flatten()
}

/// Треки, которые автоматика распознала неуверенно (или переставила части), — для значка «проверьте».
/// Возвращает (track_id, confidence 0..1, swapped).
pub fn needs_review(db: &Db) -> Vec<(i64, u8, bool)> {
    let c = db.conn.lock();
    let Ok(mut st) = c.prepare("SELECT t.id, g.confidence, g.swapped FROM name_guess g JOIN tracks t ON t.path=g.path WHERE g.confidence<2 OR g.swapped=1") else {
        return vec![];
    };
    let v = st.query_map([], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u8, r.get::<_, i64>(2)? != 0))).map(|it| it.filter_map(|x| x.ok()).collect()).unwrap_or_default();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unify_and_split() {
        let p = std::env::temp_dir().join(format!("teto-unify-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&p);
        let db = Db::open(&p).unwrap();
        migrate(&db).unwrap();
        {
            let c = db.conn.lock();
            for (i, (t, a, al)) in [
                ("Группа крови", "Кино", "Группа крови"),
                ("Звезда", "KINO", "Звезда по имени"),
                ("Кукушка", "kino", "Black"),
                ("Тёмная ночь", "Баста, Скриптонит", "Сингл"),
                ("Притон", "скриптонит", "Дом"),
            ]
            .iter()
            .enumerate()
            {
                c.execute("INSERT INTO tracks(path,title,artist,album_artist,album,dur,added,mtime,size,disc,no,year,genre,codec,bits,rate,channels,kbps,lossless,has_pic,fav,missing,plays) VALUES(?,?,?,'',?,200,0,0,1,1,1,0,'','MP3',16,44100,2,320,0,0,0,0,0)", params![format!("/m/{i}.mp3"), t, a, al]).unwrap();
            }
        }
        db.conn.lock().execute("INSERT INTO fts(rowid,title,artist,album) SELECT id,title,artist,album FROM tracks", []).unwrap();
        db.rebuild_albums().unwrap();
        let n = unify_artists(&db).unwrap();
        assert_eq!(n, 3);
        let names: Vec<String> = db.artists().into_iter().map(|a| format!("{}:{}:{}", a.name, a.albums, a.tracks)).collect();
        assert_eq!(names, vec!["Баста:1:1", "Кино:3:3", "Скриптонит:2:2"]);
        assert_eq!(db.artist_albums("скриптонит").len(), 2);
        let (t, _, ar) = db.search("kino");
        assert_eq!(t.len(), 3);
        assert_eq!(ar.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["Кино"]);
        let _ = std::fs::remove_file(&p);
    }
}
