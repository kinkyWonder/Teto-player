//! SQLite library (WAL) + FTS5 search.
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

pub type Res<T> = Result<T, String>;
pub fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_id: i64,
    pub disc: u32,
    pub no: u32,
    pub dur: f64,
    pub codec: String,
    pub bits: u32,
    pub rate: u32,
    pub kbps: u32,
    pub lossless: bool,
    pub genre: String,
    pub year: u32,
    pub fav: bool,
    pub missing: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Album {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub year: u32,
    pub genre: String,
    pub tracks: u32,
    pub dur: f64,
    pub cover: Option<String>,
    pub cover_name: String,
    pub recipe: Option<Value>,
    pub history: Vec<Value>,
    pub added: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Artist {
    pub name: String,
    pub albums: u32,
    pub tracks: u32,
    pub album_id: i64,
    pub album_title: String,
    pub cover: Option<String>,
    pub recipe: Option<Value>,
    pub genre: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub tracks: u32,
    pub album_id: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Stats {
    pub albums: u32,
    pub artists: u32,
    pub tracks: u32,
    pub favs: u32,
}

/// Metadata read from a file by the scanner.
#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub path: String,
    pub mtime: i64,
    pub size: i64,
    pub title: String,
    pub artist: String,
    pub album_artist: String,
    pub album: String,
    pub disc: u32,
    pub no: u32,
    pub year: u32,
    pub genre: String,
    pub dur: f64,
    pub codec: String,
    pub bits: u32,
    pub rate: u32,
    pub channels: u32,
    pub kbps: u32,
    pub lossless: bool,
    pub rg_track: Option<f32>,
    pub rg_album: Option<f32>,
    pub rg_track_peak: Option<f32>,
    pub rg_album_peak: Option<f32>,
    pub has_pic: bool,
}

/// What the audio engine needs to play a track.
#[derive(Clone, Debug, Default)]
pub struct PlayItem {
    pub id: i64,
    pub path: String,
    pub dur: f64,
    pub rg_track: Option<f32>,
    pub rg_album: Option<f32>,
    pub rg_track_peak: Option<f32>,
    pub rg_album_peak: Option<f32>,
    pub album_id: i64,
    /// measured loudness (LUFS) and sample peak for songs without ReplayGain tags (crate::loudness)
    pub lufs: Option<f32>,
    pub peak: Option<f32>,
    pub album_lufs: Option<f32>,
    pub album_peak: Option<f32>,
}

pub struct Db {
    pub conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA temp_store=MEMORY;
CREATE TABLE IF NOT EXISTS folders(path TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS albums(
  id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
  year INTEGER DEFAULT 0, genre TEXT DEFAULT '', tracks INTEGER DEFAULT 0, dur REAL DEFAULT 0,
  cover TEXT, cover_path TEXT, cover_name TEXT DEFAULT '', recipe TEXT, history TEXT,
  analysis TEXT, added INTEGER DEFAULT 0, played INTEGER DEFAULT 0, fav INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tracks(
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, mtime INTEGER, size INTEGER,
  title TEXT, artist TEXT, album_artist TEXT, album TEXT, album_id INTEGER, disc INTEGER, no INTEGER,
  year INTEGER, genre TEXT, dur REAL, codec TEXT, bits INTEGER, rate INTEGER, channels INTEGER, kbps INTEGER,
  lossless INTEGER, rg_track REAL, rg_album REAL, rg_track_peak REAL, rg_album_peak REAL, has_pic INTEGER,
  fav INTEGER DEFAULT 0, missing INTEGER DEFAULT 0, added INTEGER, plays INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, artist, album, tokenize="unicode61 remove_diacritics 2", prefix='1 2 3');
CREATE TABLE IF NOT EXISTS playlists(id INTEGER PRIMARY KEY, name TEXT NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS playlist_items(playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, track_id INTEGER NOT NULL, pos INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pli ON playlist_items(playlist_id, pos);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS loud(path TEXT PRIMARY KEY, lufs REAL, peak REAL);
CREATE TABLE IF NOT EXISTS web_genre(key TEXT PRIMARY KEY, genre TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0);
"#;

const TRACK_COLS: &str = "t.id,t.path,t.title,t.artist,t.album,t.album_id,t.disc,t.no,t.dur,t.codec,t.bits,t.rate,t.kbps,t.lossless,t.genre,t.year,t.fav,t.missing";
const ALBUM_COLS: &str = "a.id,a.title,a.artist,a.year,a.genre,a.tracks,a.dur,a.cover,a.cover_name,a.recipe,a.history,a.added";

fn track_row(r: &Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: r.get(0)?,
        path: r.get(1)?,
        title: r.get(2)?,
        artist: r.get(3)?,
        album: r.get(4)?,
        album_id: r.get(5)?,
        disc: r.get(6)?,
        no: r.get(7)?,
        dur: r.get(8)?,
        codec: r.get(9)?,
        bits: r.get(10)?,
        rate: r.get(11)?,
        kbps: r.get(12)?,
        lossless: r.get::<_, i64>(13)? != 0,
        genre: r.get(14)?,
        year: r.get(15)?,
        fav: r.get::<_, i64>(16)? != 0,
        missing: r.get::<_, i64>(17)? != 0,
    })
}

fn album_row(r: &Row) -> rusqlite::Result<Album> {
    let recipe: Option<String> = r.get(9)?;
    let history: Option<String> = r.get(10)?;
    Ok(Album {
        id: r.get(0)?,
        title: r.get(1)?,
        artist: r.get(2)?,
        year: r.get(3)?,
        genre: r.get(4)?,
        tracks: r.get(5)?,
        dur: r.get(6)?,
        cover: r.get(7)?,
        cover_name: r.get::<_, Option<String>>(8)?.unwrap_or_default(),
        recipe: recipe.and_then(|s| serde_json::from_str(&s).ok()),
        history: history.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
        added: r.get(11)?,
    })
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn album_order(sort: &str) -> &'static str {
    match sort {
        "title" => "a.title COLLATE NOCASE, a.artist COLLATE NOCASE",
        "year" => "a.year DESC, a.artist COLLATE NOCASE, a.title COLLATE NOCASE",
        "added" => "a.added DESC, a.id DESC",
        _ => "a.artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE",
    }
}

fn track_order(sort: &str) -> &'static str {
    match sort {
        "title" => "t.title COLLATE NOCASE, t.artist COLLATE NOCASE",
        "year" => "t.year DESC, a.artist COLLATE NOCASE, a.title COLLATE NOCASE, t.disc, t.no",
        "added" => "t.added DESC, t.album_id, t.disc, t.no",
        _ => "a.artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE, t.disc, t.no, t.path",
    }
}

impl Db {
    pub fn open(path: &Path) -> Res<Db> {
        let conn = Connection::open(path).map_err(e)?;
        conn.execute_batch(SCHEMA).map_err(e)?;
        conn.execute_batch(crate::listen::SCHEMA).map_err(e)?;
        conn.pragma_update(None, "cache_size", -16000).map_err(e)?;
        Ok(Db { conn: Mutex::new(conn) })
    }

    // ---------- kv ----------
    pub fn kv_get(&self, key: &str) -> Option<String> {
        self.conn.lock().query_row("SELECT value FROM kv WHERE key=?", [key], |r| r.get(0)).optional().ok().flatten()
    }
    pub fn kv_set(&self, key: &str, v: &str) {
        let _ = self.conn.lock().execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, v]);
    }

    // ---------- folders ----------
    pub fn folders(&self) -> Vec<String> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT path FROM folders ORDER BY path").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().filter_map(|x| x.ok()).collect()
    }
    pub fn add_folder(&self, p: &str) -> Res<()> {
        self.conn.lock().execute("INSERT OR IGNORE INTO folders(path) VALUES(?)", [p]).map_err(e)?;
        Ok(())
    }
    pub fn remove_folder(&self, p: &str) -> Res<()> {
        let c = self.conn.lock();
        c.execute("DELETE FROM folders WHERE path=?", [p]).map_err(e)?;
        let mut prefix = p.to_string();
        if !prefix.ends_with(['\\', '/']) {
            prefix.push(std::path::MAIN_SEPARATOR);
        }
        let ids: Vec<i64> = {
            let mut st = c.prepare("SELECT id FROM tracks WHERE substr(path,1,length(?1))=?1").map_err(e)?;
            let v = st.query_map([&prefix], |r| r.get(0)).map_err(e)?.filter_map(|x| x.ok()).collect();
            v
        };
        drop(c);
        self.delete_tracks(&ids)?;
        self.rebuild_albums()
    }

    // ---------- scanner support ----------
    pub fn file_index(&self) -> HashMap<String, (i64, i64, i64)> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT path,id,mtime,size FROM tracks").unwrap();
        st.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect()
    }

    pub fn upsert(&self, metas: &[Meta]) -> Res<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction().map_err(e)?;
        {
            let mut up = tx
                .prepare_cached(
                    "INSERT INTO tracks(path,mtime,size,title,artist,album_artist,album,disc,no,year,genre,dur,codec,bits,rate,channels,kbps,lossless,
                     rg_track,rg_album,rg_track_peak,rg_album_peak,has_pic,added,missing,album_id)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,0,0)
                     ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,size=excluded.size,title=excluded.title,artist=excluded.artist,
                     album_artist=excluded.album_artist,album=excluded.album,disc=excluded.disc,no=excluded.no,year=excluded.year,genre=excluded.genre,
                     dur=excluded.dur,codec=excluded.codec,bits=excluded.bits,rate=excluded.rate,channels=excluded.channels,kbps=excluded.kbps,
                     lossless=excluded.lossless,rg_track=excluded.rg_track,rg_album=excluded.rg_album,rg_track_peak=excluded.rg_track_peak,
                     rg_album_peak=excluded.rg_album_peak,has_pic=excluded.has_pic,missing=0
                     RETURNING id",
                )
                .map_err(e)?;
            let mut fd = tx.prepare_cached("DELETE FROM fts WHERE rowid=?").map_err(e)?;
            let mut fi = tx.prepare_cached("INSERT INTO fts(rowid,title,artist,album) VALUES(?,?,?,?)").map_err(e)?;
            let t = now();
            for m in metas {
                let id: i64 = up
                    .query_row(
                        params![
                            m.path, m.mtime, m.size, m.title, m.artist, m.album_artist, m.album, m.disc, m.no, m.year, m.genre, m.dur, m.codec, m.bits,
                            m.rate, m.channels, m.kbps, m.lossless as i64, m.rg_track, m.rg_album, m.rg_track_peak, m.rg_album_peak, m.has_pic as i64, t
                        ],
                        |r| r.get(0),
                    )
                    .map_err(e)?;
                fd.execute([id]).map_err(e)?;
                fi.execute(params![id, m.title, if m.album_artist.is_empty() || m.album_artist == m.artist { m.artist.clone() } else { format!("{} {}", m.artist, m.album_artist) }, m.album]).map_err(e)?;
            }
        }
        tx.commit().map_err(e)
    }

    pub fn delete_tracks(&self, ids: &[i64]) -> Res<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut c = self.conn.lock();
        let tx = c.transaction().map_err(e)?;
        for id in ids {
            tx.execute("DELETE FROM tracks WHERE id=?", [id]).map_err(e)?;
            tx.execute("DELETE FROM fts WHERE rowid=?", [id]).map_err(e)?;
            tx.execute("DELETE FROM playlist_items WHERE track_id=?", [id]).map_err(e)?;
        }
        tx.commit().map_err(e)
    }

    /// Group tracks: Album Artist -> Album. Album ids are stable (keyed by artist+title).
    pub fn rebuild_albums(&self) -> Res<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction().map_err(e)?;
        tx.execute_batch(
            r#"
            CREATE TEMP TABLE IF NOT EXISTS ak(tid INTEGER PRIMARY KEY, key TEXT, artist TEXT, album TEXT);
            DELETE FROM ak;
            INSERT INTO ak SELECT id,
                lower(CASE WHEN album_artist<>'' THEN album_artist ELSE artist END) || char(1) || lower(album),
                CASE WHEN album_artist<>'' THEN album_artist ELSE artist END, album FROM tracks;
            INSERT INTO albums(key,title,artist,added)
                SELECT key, min(album), min(artist), strftime('%s','now') FROM ak WHERE key NOT IN (SELECT key FROM albums) GROUP BY key;
            UPDATE tracks SET album_id=(SELECT a.id FROM albums a JOIN ak ON ak.key=a.key WHERE ak.tid=tracks.id);
            DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL);
            UPDATE albums SET
                tracks=(SELECT count(*) FROM tracks t WHERE t.album_id=albums.id),
                dur=(SELECT coalesce(sum(dur),0) FROM tracks t WHERE t.album_id=albums.id),
                year=(SELECT coalesce(max(year),0) FROM tracks t WHERE t.album_id=albums.id),
                added=coalesce((SELECT min(added) FROM tracks t WHERE t.album_id=albums.id), added);
            "#,
        )
        .map_err(e)?;
        // genres: distinct, in order of frequency, up to 3
        let rows: Vec<(i64, String)> = {
            let mut st = tx.prepare("SELECT album_id, genre FROM tracks WHERE genre<>'' ORDER BY album_id").map_err(e)?;
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.filter_map(|x| x.ok()).collect();
            v
        };
        let mut by: HashMap<i64, Vec<(String, u32)>> = HashMap::new();
        for (aid, g) in rows {
            let list = by.entry(aid).or_default();
            for part in g.split([';', '/', ',', '\0']).map(|s| s.trim()).filter(|s| !s.is_empty()) {
                if let Some(x) = list.iter_mut().find(|x| x.0.eq_ignore_ascii_case(part)) {
                    x.1 += 1;
                } else {
                    list.push((part.to_string(), 1));
                }
            }
        }
        tx.execute("UPDATE albums SET genre=''", []).map_err(e)?;
        {
            let mut st = tx.prepare("UPDATE albums SET genre=? WHERE id=?").map_err(e)?;
            for (aid, mut list) in by {
                list.sort_by(|a, b| b.1.cmp(&a.1));
                let g = list.iter().take(3).map(|x| x.0.as_str()).collect::<Vec<_>>().join(", ");
                st.execute(params![g, aid]).map_err(e)?;
            }
        }
        tx.commit().map_err(e)
    }

    /// Albums whose cover source has not been resolved yet / tracks to look at.
    pub fn albums_needing_cover(&self) -> Vec<(i64, Vec<(String, bool)>)> {
        let c = self.conn.lock();
        let mut st = c
            .prepare("SELECT a.id, t.path, t.has_pic FROM albums a JOIN tracks t ON t.album_id=a.id WHERE a.cover_path IS NULL ORDER BY a.id, t.disc, t.no")
            .unwrap();
        let mut out: Vec<(i64, Vec<(String, bool)>)> = Vec::new();
        let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? != 0))).unwrap();
        for (id, p, pic) in rows.flatten() {
            match out.last_mut() {
                Some(l) if l.0 == id => l.1.push((p, pic)),
                _ => out.push((id, vec![(p, pic)])),
            }
        }
        out
    }

    pub fn set_cover_source(&self, id: i64, kind: Option<&str>, path: &str, name: &str) {
        let _ = self.conn.lock().execute("UPDATE albums SET cover=?, cover_path=?, cover_name=? WHERE id=?", params![kind, path, name, id]);
    }

    /// Settings → "Reprocess all files": forget everything that was derived automatically — internet / sound genres,
    /// audio analysis and generated cover recipes of albums without a real cover. Manual edits are kept.
    pub fn reset_derived(&self) {
        let c = self.conn.lock();
        let _ = c.execute_batch(
            "DELETE FROM web_genre;
             UPDATE albums SET analysis=NULL;
             UPDATE albums SET recipe=NULL, history=NULL WHERE cover IS NULL;
             UPDATE albums SET cover_path=NULL;",
        );
    }

    pub fn reset_cover_sources(&self) {
        let _ = self.conn.lock().execute("UPDATE albums SET cover_path=NULL", []);
    }

    pub fn cover_source(&self, id: i64) -> Option<(String, String)> {
        self.conn
            .lock()
            .query_row("SELECT cover, cover_path FROM albums WHERE id=? AND cover IS NOT NULL", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .ok()
            .flatten()
    }

    // ---------- queries ----------
    pub fn stats(&self) -> Stats {
        let c = self.conn.lock();
        c.query_row(
            "SELECT (SELECT count(*) FROM albums),(SELECT count(DISTINCT lower(artist)) FROM albums),(SELECT count(*) FROM tracks),(SELECT count(*) FROM tracks WHERE fav=1)",
            [],
            |r| Ok(Stats { albums: r.get(0)?, artists: r.get(1)?, tracks: r.get(2)?, favs: r.get(3)? }),
        )
        .unwrap_or_default()
    }

    fn albums_where(&self, wh: &str, order: &str, p: &[&dyn rusqlite::ToSql]) -> Vec<Album> {
        let c = self.conn.lock();
        let sql = format!("SELECT {ALBUM_COLS} FROM albums a {wh} ORDER BY {order}");
        let mut st = c.prepare_cached(&sql).unwrap();
        let v = st.query_map(p, album_row).unwrap().filter_map(|x| x.ok()).collect();
        v
    }

    pub fn albums(&self, sort: &str) -> Vec<Album> {
        self.albums_where("", album_order(sort), &[])
    }
    pub fn recent_albums(&self) -> Vec<Album> {
        self.albums_where("WHERE a.played>0", "a.played DESC LIMIT 12", &[])
    }
    pub fn album(&self, id: i64) -> Option<Album> {
        self.albums_where("WHERE a.id=?", "a.id", &[&id]).into_iter().next()
    }
    /// Albums of an artist, including joint ones («A, B» belongs to both A and B).
    pub fn artist_albums(&self, name: &str) -> Vec<Album> {
        let k = crate::namefix::key(name);
        self.albums_where("", "a.year DESC, a.title COLLATE NOCASE", &[])
            .into_iter()
            .filter(|a| crate::namefix::split_artists(&a.artist).iter().any(|p| crate::namefix::key(p) == k))
            .collect()
    }

    /// Every artist on its own: «Баста, Скриптонит» counts for both; featured artists are listed too.
    pub fn artists(&self) -> Vec<Artist> {
        type Row = (String, String, i64, String, Option<String>, Option<String>, String);
        let rows: Vec<Row> = {
            let c = self.conn.lock();
            let mut st = c
                .prepare(
                    "SELECT coalesce(t.artist,''), coalesce(a.artist,''), a.id, coalesce(a.title,''), a.cover, a.recipe, coalesce(a.genre,'')
                     FROM tracks t JOIN albums a ON a.id=t.album_id ORDER BY a.id DESC",
                )
                .unwrap();
            let v = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
                .unwrap()
                .filter_map(|x| x.ok())
                .collect();
            v
        };
        let mut m: HashMap<String, (Artist, std::collections::HashSet<i64>)> = HashMap::new();
        for (ta, aa, id, title, cover, recipe, genre) in rows {
            let own = crate::namefix::split_artists(&aa);
            let mut seen: Vec<String> = Vec::new();
            for (p, is_own) in own.iter().map(|p| (p, true)).chain(crate::namefix::split_artists(&ta).iter().map(|p| (p, false)).collect::<Vec<_>>().into_iter()) {
                let k = crate::namefix::key(p);
                if k.is_empty() || seen.contains(&k) {
                    continue;
                }
                seen.push(k.clone());
                let e = m.entry(k).or_insert_with(|| {
                    (
                        Artist {
                            name: p.clone(),
                            albums: 0,
                            tracks: 0,
                            album_id: id,
                            album_title: title.clone(),
                            cover: cover.clone(),
                            recipe: recipe.as_ref().and_then(|s| serde_json::from_str(s).ok()),
                            genre: genre.clone(),
                        },
                        Default::default(),
                    )
                });
                e.0.tracks += 1;
                if is_own && e.1.insert(id) {
                    e.0.albums += 1;
                }
            }
        }
        let mut v: Vec<Artist> = m.into_values().map(|x| x.0).collect();
        v.sort_by_cached_key(|a| a.name.to_lowercase());
        v
    }

    fn tracks_where(&self, wh: &str, order: &str, p: &[&dyn rusqlite::ToSql]) -> Vec<Track> {
        let c = self.conn.lock();
        let sql = format!("SELECT {TRACK_COLS} FROM tracks t LEFT JOIN albums a ON a.id=t.album_id {wh} ORDER BY {order}");
        let mut st = c.prepare_cached(&sql).unwrap();
        let v = st.query_map(p, track_row).unwrap().filter_map(|x| x.ok()).collect();
        v
    }

    pub fn album_tracks(&self, id: i64) -> Vec<Track> {
        self.tracks_where("WHERE t.album_id=?", "t.disc, t.no, t.path", &[&id])
    }
    pub fn tracks(&self, sort: &str) -> Vec<Track> {
        self.tracks_where("", track_order(sort), &[])
    }
    pub fn favorites(&self) -> Vec<Track> {
        self.tracks_where("WHERE t.fav=1", track_order("artist"), &[])
    }
    pub fn track(&self, id: i64) -> Option<Track> {
        self.tracks_where("WHERE t.id=?", "t.id", &[&id]).into_iter().next()
    }
    pub fn tracks_by_ids(&self, ids: &[i64]) -> Vec<Track> {
        let all: HashMap<i64, Track> = {
            let c = self.conn.lock();
            let mut st = c.prepare_cached(&format!("SELECT {TRACK_COLS} FROM tracks t WHERE t.id=?")).unwrap();
            ids.iter().filter_map(|id| st.query_row([id], track_row).ok()).map(|t| (t.id, t)).collect()
        };
        ids.iter().filter_map(|id| all.get(id).cloned()).collect()
    }

    pub fn play_items(&self, ids: &[i64]) -> Vec<PlayItem> {
        let c = self.conn.lock();
        let mut st = c
            .prepare_cached("SELECT t.id,t.path,t.dur,t.rg_track,t.rg_album,t.rg_track_peak,t.rg_album_peak,t.album_id,l.lufs,l.peak FROM tracks t LEFT JOIN loud l ON l.path=t.path WHERE t.id=?")
            .unwrap();
        let mut items: Vec<PlayItem> = ids
            .iter()
            .filter_map(|id| {
                st.query_row([id], |r| {
                    Ok(PlayItem {
                        id: r.get(0)?,
                        path: r.get(1)?,
                        dur: r.get(2)?,
                        rg_track: r.get(3)?,
                        rg_album: r.get(4)?,
                        rg_track_peak: r.get(5)?,
                        rg_album_peak: r.get(6)?,
                        album_id: r.get(7)?,
                        lufs: r.get(8)?,
                        peak: r.get(9)?,
                        album_lufs: None,
                        album_peak: None,
                    })
                })
                .ok()
            })
            .collect();
        drop(st);
        let mut albums: HashMap<i64, (Option<f32>, Option<f32>)> = HashMap::new();
        for it in items.iter_mut() {
            let v = *albums.entry(it.album_id).or_insert_with(|| album_loud_q(&c, it.album_id));
            it.album_lufs = v.0;
            it.album_peak = v.1;
        }
        items
    }

    /// Album loudness / peak from its measured songs.
    pub fn album_loud(&self, album_id: i64) -> (Option<f32>, Option<f32>) {
        album_loud_q(&self.conn.lock(), album_id)
    }

    /// Next song to measure (no ReplayGain tags, not measured yet); `prefer` first (the queue around the current song).
    pub fn next_unmeasured(&self, prefer: &[String]) -> Option<String> {
        let c = self.conn.lock();
        for p in prefer {
            let need: bool = c
                .query_row("SELECT 1 FROM tracks t WHERE t.path=? AND t.missing=0 AND t.rg_track IS NULL AND t.rg_album IS NULL AND NOT EXISTS(SELECT 1 FROM loud l WHERE l.path=t.path)", [p], |_| Ok(true))
                .unwrap_or(false);
            if need {
                return Some(p.clone());
            }
        }
        c.query_row(
            "SELECT t.path FROM tracks t WHERE t.missing=0 AND t.rg_track IS NULL AND t.rg_album IS NULL AND NOT EXISTS(SELECT 1 FROM loud l WHERE l.path=t.path) ORDER BY t.plays DESC, t.id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok()
    }
    pub fn set_loud(&self, path: &str, v: Option<(f32, f32)>) {
        let _ = self.conn.lock().execute("INSERT OR REPLACE INTO loud(path,lufs,peak) VALUES(?,?,?)", params![path, v.map(|x| x.0), v.map(|x| x.1)]);
    }
    /// (measured, songs that need measuring) — for Settings.
    pub fn loud_stats(&self) -> (i64, i64) {
        let c = self.conn.lock();
        let need: i64 = c.query_row("SELECT count(*) FROM tracks WHERE missing=0 AND rg_track IS NULL AND rg_album IS NULL", [], |r| r.get(0)).unwrap_or(0);
        let done: i64 = c
            .query_row("SELECT count(*) FROM tracks t JOIN loud l ON l.path=t.path WHERE t.missing=0 AND t.rg_track IS NULL AND t.rg_album IS NULL", [], |r| r.get(0))
            .unwrap_or(0);
        (done, need)
    }
    /// Album cover chosen by the user (Settings → "Replace cover with a picture…"): forget the old source.
    pub fn reset_cover_source(&self, id: i64) {
        let _ = self.conn.lock().execute("UPDATE albums SET cover=NULL, cover_path=NULL, cover_name='' WHERE id=?", [id]);
    }

    /// Search; a Latin query also finds Cyrillic names written in translit («kino» → «Кино»).
    pub fn search(&self, q: &str) -> (Vec<Track>, Vec<Album>, Vec<Artist>) {
        let mut r = self.search_one(q);
        if !crate::namefix::has_cyr(q) && q.chars().any(|c| c.is_ascii_alphabetic()) {
            let alt = crate::namefix::untranslit(q);
            if alt != q {
                let (t, a, ar) = self.search_one(&alt);
                for x in t {
                    if !r.0.iter().any(|y| y.id == x.id) {
                        r.0.push(x);
                    }
                }
                for x in a {
                    if !r.1.iter().any(|y| y.id == x.id) {
                        r.1.push(x);
                    }
                }
                for x in ar {
                    if !r.2.iter().any(|y| y.name == x.name) {
                        r.2.push(x);
                    }
                }
            }
        }
        r
    }

    fn search_one(&self, q: &str) -> (Vec<Track>, Vec<Album>, Vec<Artist>) {
        let words: Vec<String> = q.split(|c: char| !c.is_alphanumeric()).filter(|s| !s.is_empty()).map(|s| s.to_lowercase()).collect();
        let toks: Vec<String> = words.iter().map(|s| format!("\"{}\"*", s.replace('"', ""))).collect();
        if toks.is_empty() {
            return (vec![], vec![], vec![]);
        }
        let fq = toks.join(" AND ");
        let tracks = self.tracks_where("WHERE t.id IN (SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT 300)", "t.title COLLATE NOCASE", &[&fq]);
        // albums/artists: match on the album/artist columns only
        let aq = format!("{{album artist}} : ({fq})");
        let albums = self.albums_where(
            "WHERE a.id IN (SELECT DISTINCT album_id FROM tracks WHERE id IN (SELECT rowid FROM fts WHERE fts MATCH ? LIMIT 2000))",
            "a.artist COLLATE NOCASE, a.year",
            &[&aq],
        );
        let rq = format!("{{artist}} : ({fq})");
        let names: Vec<String> = {
            let c = self.conn.lock();
            let mut st = c
                .prepare_cached("SELECT DISTINCT coalesce(t.artist,'') || char(1) || coalesce(t.album_artist,'') FROM tracks t WHERE t.id IN (SELECT rowid FROM fts WHERE fts MATCH ? LIMIT 2000)")
                .unwrap();
            let v = st.query_map([&rq], |r| r.get(0)).map(|it| it.filter_map(|x| x.ok()).collect()).unwrap_or_default();
            v
        };
        // only the artists that themselves match («Баста, Скриптонит» by «скрип» → Скриптонит)
        let wkeys: Vec<String> = words.iter().map(|w| crate::namefix::key(w)).collect();
        let mut wanted = std::collections::HashSet::new();
        for n in &names {
            for p in n.split('\u{1}').flat_map(crate::namefix::split_artists) {
                let (l, k) = (p.to_lowercase(), crate::namefix::key(&p));
                if words.iter().zip(&wkeys).all(|(w, wk)| l.contains(w.as_str()) || k.contains(wk.as_str())) {
                    wanted.insert(k);
                }
            }
        }
        let artists = if wanted.is_empty() { vec![] } else { self.artists().into_iter().filter(|a| wanted.contains(&crate::namefix::key(&a.name))).collect() };
        (tracks, albums, artists)
    }

    pub fn set_fav(&self, id: i64, fav: bool) {
        let _ = self.conn.lock().execute("UPDATE tracks SET fav=? WHERE id=?", params![fav as i64, id]);
    }
    pub fn set_album_fav(&self, id: i64, fav: bool) {
        let _ = self.conn.lock().execute("UPDATE tracks SET fav=? WHERE album_id=?", params![fav as i64, id]);
    }
    pub fn set_missing(&self, id: i64, missing: bool) {
        let _ = self.conn.lock().execute("UPDATE tracks SET missing=? WHERE id=?", params![missing as i64, id]);
    }
    pub fn mark_played(&self, track_id: i64) {
        let c = self.conn.lock();
        let _ = c.execute("UPDATE tracks SET plays=plays+1 WHERE id=?", [track_id]);
        let _ = c.execute("UPDATE albums SET played=? WHERE id=(SELECT album_id FROM tracks WHERE id=?)", params![now(), track_id]);
    }

    pub fn set_recipe(&self, album: i64, recipe: Option<&Value>, history: Option<&Value>) {
        let c = self.conn.lock();
        let _ = c.execute(
            "UPDATE albums SET recipe=?, history=coalesce(?, history) WHERE id=?",
            params![recipe.map(|v| v.to_string()), history.map(|v| v.to_string()), album],
        );
    }
    pub fn analysis(&self, album: i64) -> Option<String> {
        self.conn.lock().query_row("SELECT analysis FROM albums WHERE id=?", [album], |r| r.get(0)).optional().ok().flatten().flatten()
    }
    /// Next album without cached analysis (background pre-analysis), preferring ones without real covers.
    pub fn next_unanalyzed(&self) -> Option<i64> {
        self.conn
            .lock()
            .query_row("SELECT id FROM albums WHERE analysis IS NULL ORDER BY (cover IS NOT NULL), id LIMIT 1", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }
    /// Genre per album for the genre browser: tag genre, else the genre estimated by the audio analysis.
    pub fn album_genres(&self) -> Vec<(i64, String)> {
        let c = self.conn.lock();
        // tags > internet (iTunes / Deezer, see webgenre.rs) > sound analysis
        let mut st = match c.prepare("SELECT a.id, coalesce(a.genre,''), a.analysis, coalesce(w.genre,'') FROM albums a LEFT JOIN web_genre w ON w.key=a.key") {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?)));
        let Ok(rows) = rows else { return vec![] };
        rows.filter_map(|r| r.ok())
            .filter_map(|(id, g, an, web)| {
                if !g.is_empty() {
                    return Some((id, g));
                }
                if !web.is_empty() {
                    return Some((id, web));
                }
                let v: Value = serde_json::from_str(&an?).ok()?;
                v.get("genre").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(|x| (id, x.to_string()))
            })
            .collect()
    }
    pub fn set_analysis(&self, album: i64, v: &str) {
        let _ = self.conn.lock().execute("UPDATE albums SET analysis=? WHERE id=?", params![v, album]);
    }

    // ---------- playlists ----------
    pub fn playlists(&self) -> Vec<Playlist> {
        let c = self.conn.lock();
        let mut st = c
            .prepare(
                "SELECT p.id, p.name, (SELECT count(*) FROM playlist_items i WHERE i.playlist_id=p.id),
                 coalesce((SELECT t.album_id FROM playlist_items i JOIN tracks t ON t.id=i.track_id WHERE i.playlist_id=p.id ORDER BY i.pos LIMIT 1),0)
                 FROM playlists p ORDER BY p.created, p.id",
            )
            .unwrap();
        let v = st
            .query_map([], |r| Ok(Playlist { id: r.get(0)?, name: r.get(1)?, tracks: r.get(2)?, album_id: r.get(3)? }))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect();
        v
    }
    pub fn create_playlist(&self, name: &str) -> Res<i64> {
        let c = self.conn.lock();
        c.execute("INSERT INTO playlists(name,created) VALUES(?,?)", params![name, now()]).map_err(e)?;
        Ok(c.last_insert_rowid())
    }
    pub fn delete_playlist(&self, id: i64) {
        let c = self.conn.lock();
        let _ = c.execute("DELETE FROM playlist_items WHERE playlist_id=?", [id]);
        let _ = c.execute("DELETE FROM playlists WHERE id=?", [id]);
    }
    pub fn rename_playlist(&self, id: i64, name: &str) {
        let _ = self.conn.lock().execute("UPDATE playlists SET name=? WHERE id=?", params![name, id]);
    }
    pub fn playlist_tracks(&self, id: i64) -> Vec<Track> {
        self.tracks_where("JOIN playlist_items i ON i.track_id=t.id WHERE i.playlist_id=?", "i.pos", &[&id])
    }
    pub fn add_to_playlist(&self, id: i64, ids: &[i64]) -> Res<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction().map_err(e)?;
        let mut pos: i64 = tx.query_row("SELECT coalesce(max(pos),-1)+1 FROM playlist_items WHERE playlist_id=?", [id], |r| r.get(0)).map_err(e)?;
        for t in ids {
            tx.execute("INSERT INTO playlist_items(playlist_id,track_id,pos) VALUES(?,?,?)", params![id, t, pos]).map_err(e)?;
            pos += 1;
        }
        tx.commit().map_err(e)
    }
    pub fn remove_from_playlist(&self, id: i64, ids: &[i64]) {
        let c = self.conn.lock();
        for t in ids {
            let _ = c.execute("DELETE FROM playlist_items WHERE playlist_id=? AND track_id=?", params![id, t]);
        }
    }
    pub fn album_track_paths(&self, id: i64) -> Vec<(i64, String)> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id,path FROM tracks WHERE album_id=? ORDER BY disc,no").unwrap();
        let v = st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().filter_map(|x| x.ok()).collect();
        v
    }
    pub fn track_lookup(&self, id: i64) -> Option<(String, String, String, String, f64)> {
        self.conn
            .lock()
            .query_row("SELECT path,title,artist,album,dur FROM tracks WHERE id=?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .optional()
            .ok()
            .flatten()
    }
}

fn album_loud_q(c: &Connection, album_id: i64) -> (Option<f32>, Option<f32>) {
    let mut st = match c.prepare_cached("SELECT l.lufs, l.peak FROM tracks t JOIN loud l ON l.path=t.path WHERE t.album_id=? AND l.lufs IS NOT NULL") {
        Ok(s) => s,
        Err(_) => return (None, None),
    };
    let rows: Vec<(f32, f32)> = st
        .query_map([album_id], |r| Ok((r.get::<_, f64>(0)? as f32, r.get::<_, Option<f64>>(1)?.unwrap_or(0.0) as f32)))
        .map(|it| it.flatten().collect())
        .unwrap_or_default();
    let l: Vec<f32> = rows.iter().map(|x| x.0).collect();
    (crate::loudness::album(&l), rows.iter().map(|x| x.1).fold(None, |a: Option<f32>, p| Some(a.map_or(p, |a| a.max(p)))))
}
