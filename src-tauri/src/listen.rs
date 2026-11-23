//! Hidden listening statistics for the monthly report (Settings never shows the current month).
//! Seconds actually played, plays (≥30 s or half the song) and skips are kept per day / hour / track,
//! with a snapshot of the track names so the report survives deleted files. Day and hour are local time.
use crate::db::Db;
use parking_lot::Mutex;
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Instant;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS listen(day TEXT NOT NULL, hour INTEGER NOT NULL, track_id INTEGER NOT NULL,
  secs REAL NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0, skips INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, hour, track_id));
CREATE TABLE IF NOT EXISTS listen_meta(track_id INTEGER PRIMARY KEY, title TEXT, artist TEXT, album TEXT, album_id INTEGER, genre TEXT, dur REAL);
";

struct Inst {
    id: i64,
    dur: f64,
    last: f64,
    secs: f64,
    counted: bool,
}

#[derive(Default)]
struct Pending {
    secs: f64,
    plays: i64,
    skips: i64,
}

pub struct Listen {
    cur: Mutex<Option<Inst>>,
    pending: Mutex<HashMap<i64, Pending>>,
    flushed: Mutex<Instant>,
}

impl Default for Listen {
    fn default() -> Self {
        Listen { cur: Mutex::new(None), pending: Mutex::new(HashMap::new()), flushed: Mutex::new(Instant::now()) }
    }
}

impl Listen {
    /// A new song started (or the same one again).
    pub fn track(&self, db: &Db, id: i64, dur: f64) {
        let old = self.cur.lock().replace(Inst { id, dur, last: -1.0, secs: 0.0, counted: false });
        if let Some(o) = old {
            // skipped: left before 30 s of a song longer than a minute
            if !o.counted && o.secs < 30.0 && o.dur > 60.0 && o.dur - o.last > 5.0 {
                self.pending.lock().entry(o.id).or_default().skips += 1;
            }
        }
        self.flush(db);
    }
    /// Playback position (only sent while playing). Jumps (seeks) are not counted.
    pub fn pos(&self, db: &Db, p: f64) {
        let mut c = self.cur.lock();
        let Some(i) = c.as_mut() else { return };
        let d = p - i.last;
        if i.last >= 0.0 && d > 0.0 && d < 2.5 {
            i.secs += d;
            let mut pd = self.pending.lock();
            let e = pd.entry(i.id).or_default();
            e.secs += d;
            if !i.counted && (i.secs >= 30.0 || (i.dur > 0.0 && i.secs >= i.dur * 0.5)) {
                i.counted = true;
                e.plays += 1;
            }
        }
        i.last = p;
        drop(c);
        if self.flushed.lock().elapsed().as_secs() >= 30 {
            self.flush(db);
        }
    }
    /// Drops the not yet written counters (developer mode → reset).
    pub fn clear(&self) {
        self.pending.lock().clear();
        *self.cur.lock() = None;
    }
    pub fn flush(&self, db: &Db) {
        *self.flushed.lock() = Instant::now();
        let items: Vec<(i64, Pending)> = self.pending.lock().drain().collect();
        if items.is_empty() {
            return;
        }
        let c = db.conn.lock();
        for (id, p) in items {
            let _ = c.execute(
                "INSERT INTO listen(day,hour,track_id,secs,plays,skips) VALUES(date('now','localtime'), CAST(strftime('%H','now','localtime') AS INTEGER), ?1, ?2, ?3, ?4)
                 ON CONFLICT(day,hour,track_id) DO UPDATE SET secs=secs+excluded.secs, plays=plays+excluded.plays, skips=skips+excluded.skips",
                params![id, p.secs, p.plays, p.skips],
            );
            let _ = c.execute(
                "INSERT OR REPLACE INTO listen_meta(track_id,title,artist,album,album_id,genre,dur)
                 SELECT id,title,artist,album,album_id,genre,dur FROM tracks WHERE id=?1",
                [id],
            );
        }
    }
}

/// Rows of [from, to) (days as YYYY-MM-DD) for the report builder (src/report).
pub fn log(db: &Db, from: &str, to: &str) -> Vec<Value> {
    let c = db.conn.lock();
    let Ok(mut st) = c.prepare(
        "SELECT l.day,l.hour,l.track_id,l.secs,l.plays,l.skips,coalesce(t.title,m.title,''),coalesce(t.artist,m.artist,''),
                coalesce(t.album,m.album,''),coalesce(t.album_id,m.album_id,0),coalesce(t.genre,m.genre,''),coalesce(t.dur,m.dur,0)
         FROM listen l LEFT JOIN tracks t ON t.id=l.track_id LEFT JOIN listen_meta m ON m.track_id=l.track_id
         WHERE l.day>=?1 AND l.day<?2",
    ) else {
        return vec![];
    };
    let rows = st.query_map([from, to], |r| {
        Ok(json!({
            "d": r.get::<_, String>(0)?, "h": r.get::<_, i64>(1)?, "id": r.get::<_, i64>(2)?, "s": r.get::<_, f64>(3)?,
            "p": r.get::<_, i64>(4)?, "k": r.get::<_, i64>(5)?, "title": r.get::<_, String>(6)?, "artist": r.get::<_, String>(7)?,
            "album": r.get::<_, String>(8)?, "album_id": r.get::<_, i64>(9)?, "genre": r.get::<_, String>(10)?, "dur": r.get::<_, f64>(11)?,
        }))
    });
    match rows {
        Ok(r) => r.filter_map(|x| x.ok()).collect(),
        Err(_) => vec![],
    }
}

/// Developer mode → reset: forget every listening statistic.
pub fn reset(db: &Db) -> Result<(), String> {
    db.conn.lock().execute_batch("DELETE FROM listen; DELETE FROM listen_meta;").map_err(|e| e.to_string())
}

/// First day with any statistics (the report archive starts there).
pub fn first_day(db: &Db) -> Option<String> {
    db.conn.lock().query_row("SELECT min(day) FROM listen", [], |r| r.get::<_, Option<String>>(0)).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_plays_and_skips() {
        let dir = std::env::temp_dir().join(format!("teto-listen-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).unwrap();
        let l = Listen::default();
        l.track(&db, 1, 200.0);
        let mut p = 0.0;
        while p < 40.0 {
            l.pos(&db, p);
            p += 0.25;
        }
        l.track(&db, 2, 200.0); // song 1 counted as a play
        l.pos(&db, 0.0);
        l.pos(&db, 0.25);
        l.track(&db, 3, 200.0); // song 2 skipped
        l.pos(&db, 50.0); // a seek is not listening time
        l.flush(&db);
        let rows = log(&db, "0000-00-00", "9999-99-99");
        let get = |id: i64| rows.iter().find(|r| r["id"] == id).cloned().unwrap();
        assert_eq!(get(1)["p"], 1);
        assert!((get(1)["s"].as_f64().unwrap() - 39.75).abs() < 0.01);
        assert_eq!(get(2)["k"], 1);
        assert!(rows.iter().all(|r| r["id"] != 3));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
