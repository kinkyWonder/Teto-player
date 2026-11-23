//! Lyrics: tags -> sidecar .lrc/.txt -> cache -> LRCLIB.
use crate::paths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Line {
    pub t: f64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Lyrics {
    pub kind: String, // synced | plain | none | error
    pub lines: Vec<Line>,
    pub source: String,
    #[serde(default)]
    pub raw: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Lyrics {
    pub fn none() -> Self {
        Lyrics { kind: "none".into(), lines: vec![], source: String::new(), raw: String::new(), message: None }
    }
    pub fn error(msg: String) -> Self {
        Lyrics { kind: "error".into(), lines: vec![], source: String::new(), raw: String::new(), message: Some(msg) }
    }
    pub fn from_text(text: &str, source: &str) -> Self {
        let lines = parse_lrc(text);
        if !lines.is_empty() {
            return Lyrics { kind: "synced".into(), lines, source: source.into(), raw: text.into(), message: None };
        }
        let lines: Vec<Line> = text.replace("\r\n", "\n").lines().map(|l| Line { t: 0.0, text: l.trim_end().to_string() }).collect();
        if lines.iter().all(|l| l.text.trim().is_empty()) {
            return Lyrics::none();
        }
        Lyrics { kind: "plain".into(), lines, source: source.into(), raw: text.into(), message: None }
    }
}

/// Parse LRC (multiple timestamps per line, [offset:], [mm:ss.xx] / [mm:ss:xx]).
pub fn parse_lrc(text: &str) -> Vec<Line> {
    let mut out = Vec::new();
    let mut offset = 0.0;
    for raw in text.lines() {
        let mut s = raw.trim();
        let mut stamps = Vec::new();
        while s.starts_with('[') {
            let Some(end) = s.find(']') else { break };
            let tag = &s[1..end];
            if let Some(v) = tag.strip_prefix("offset:") {
                offset = v.trim().parse::<f64>().unwrap_or(0.0) / 1000.0;
            } else if let Some((m, rest)) = tag.split_once(':') {
                if let (Ok(m), Ok(sec)) = (m.trim().parse::<f64>(), rest.replace(':', ".").trim().parse::<f64>()) {
                    stamps.push(m * 60.0 + sec);
                }
            }
            s = s[end + 1..].trim_start();
        }
        for t in stamps {
            out.push(Line { t: (t - offset).max(0.0), text: s.to_string() });
        }
    }
    out.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    out
}

pub fn sidecar(path: &Path) -> Option<(String, &'static str)> {
    for (ext, label) in [("lrc", ".lrc"), ("LRC", ".lrc"), ("txt", ".txt")] {
        let p = path.with_extension(ext);
        if let Ok(b) = std::fs::read(&p) {
            let s = String::from_utf8(b.clone()).unwrap_or_else(|_| decode_1251(&b));
            return Some((s.trim_start_matches('\u{feff}').to_string(), label));
        }
    }
    None
}

fn decode_1251(b: &[u8]) -> String {
    // minimal Windows-1251 fallback for old Russian .lrc files
    b.iter()
        .map(|&c| match c {
            0x00..=0x7f => c as char,
            0xc0..=0xff => char::from_u32(0x410 + (c as u32 - 0xc0)).unwrap_or('?'),
            0xa8 => 'Ё',
            0xb8 => 'ё',
            _ => ' ',
        })
        .collect()
}

fn cache_file(id_key: &str) -> PathBuf {
    let mut h: u64 = 1469598103934665603;
    for b in id_key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    paths::lyrics().join(format!("{h:016x}.json"))
}

pub fn cache_key(artist: &str, title: &str, album: &str, dur: f64) -> String {
    format!("{}|{}|{}|{}", artist.to_lowercase(), title.to_lowercase(), album.to_lowercase(), dur.round())
}

pub fn cache_get(key: &str) -> Option<Lyrics> {
    let v: Value = serde_json::from_slice(&std::fs::read(cache_file(key)).ok()?).ok()?;
    if v.get("kind")?.as_str()? == "none" {
        // negative cache for 3 days
        let at = v.get("at")?.as_i64()?;
        if crate::db::now() - at > 3 * 86400 {
            return None;
        }
    }
    serde_json::from_value(v).ok()
}

pub fn cache_put(key: &str, l: &Lyrics) {
    let mut v = serde_json::to_value(l).unwrap_or(Value::Null);
    v["at"] = Value::from(crate::db::now());
    let _ = std::fs::write(cache_file(key), v.to_string());
}

/// Remove "(feat. …)", "[Remaster]", "- Live", etc.
pub fn normalize_title(t: &str) -> String {
    let mut s = t.to_string();
    for (o, c) in [('(', ')'), ('[', ']')] {
        while let (Some(a), Some(b)) = (s.find(o), s.find(c)) {
            if b > a {
                s.replace_range(a..=b, "");
            } else {
                break;
            }
        }
    }
    let low = s.to_lowercase();
    for pat in [" - live", " - remaster", " - remastered", " - radio edit", " - mono", " - stereo", " - single", " - bonus", " feat.", " ft."] {
        if let Some(i) = low.find(pat) {
            s.truncate(i);
            break;
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn normalize_artist(a: &str) -> String {
    let low = a.to_lowercase();
    let mut s = a.to_string();
    for pat in [" feat.", " ft.", " featuring ", ", ", " & ", " x "] {
        if let Some(i) = low.find(pat) {
            if i > 0 {
                s.truncate(i);
                break;
            }
        }
    }
    s.trim().to_string()
}

pub fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .user_agent(concat!("TetoPlayer/", env!("CARGO_PKG_VERSION"), " (local music player)"))
        .build()
}

fn to_lyrics(v: &Value) -> Option<Lyrics> {
    if v.get("instrumental").and_then(|x| x.as_bool()) == Some(true) {
        return Some(Lyrics { kind: "plain".into(), lines: vec![Line { t: 0.0, text: "♪ Инструментальная композиция".into() }], source: "LRCLIB".into(), raw: String::new(), message: None });
    }
    if let Some(s) = v.get("syncedLyrics").and_then(|x| x.as_str()).filter(|s| !s.trim().is_empty()) {
        let l = Lyrics::from_text(s, "LRCLIB");
        if l.kind == "synced" {
            return Some(l);
        }
    }
    let p = v.get("plainLyrics").and_then(|x| x.as_str()).filter(|s| !s.trim().is_empty())?;
    let mut l = Lyrics::from_text(p, "LRCLIB");
    l.kind = "plain".into();
    Some(l)
}

pub enum NetErr {
    NotFound,
    Network(String),
}

pub fn lrclib_get(artist: &str, title: &str, album: &str, dur: f64) -> Result<Lyrics, NetErr> {
    let a = agent();
    let try_get = |artist: &str, title: &str, album: &str| -> Result<Option<Lyrics>, NetErr> {
        let mut req = a.get("https://lrclib.net/api/get").query("artist_name", artist).query("track_name", title);
        if !album.is_empty() {
            req = req.query("album_name", album);
        }
        if dur > 0.0 {
            req = req.query("duration", &format!("{}", dur.round() as i64));
        }
        match req.call() {
            Ok(r) => Ok(r.into_json::<Value>().ok().as_ref().and_then(to_lyrics)),
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(ureq::Error::Status(c, _)) => Err(NetErr::Network(format!("HTTP {c}"))),
            Err(e) => Err(NetErr::Network(e.to_string())),
        }
    };
    if let Some(l) = try_get(artist, title, album)? {
        return Ok(l);
    }
    let (na, nt) = (normalize_artist(artist), normalize_title(title));
    if (na != artist || nt != title) && !nt.is_empty() {
        if let Some(l) = try_get(&na, &nt, "")? {
            return Ok(l);
        }
    }
    // search, pick candidate with |duration diff| <= 2 s, prefer synced
    let list = lrclib_search(&na, &nt)?;
    let mut best: Option<(&Value, f64)> = None;
    for v in &list {
        let d = v.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let diff = (d - dur).abs();
        if dur > 0.0 && diff > 2.0 {
            continue;
        }
        let synced = v.get("syncedLyrics").and_then(|x| x.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
        let score = diff - if synced { 10.0 } else { 0.0 };
        if best.map(|b| score < b.1).unwrap_or(true) {
            best = Some((v, score));
        }
    }
    best.and_then(|b| to_lyrics(b.0)).ok_or(NetErr::NotFound)
}

pub fn lrclib_search(artist: &str, title: &str) -> Result<Vec<Value>, NetErr> {
    let r = agent()
        .get("https://lrclib.net/api/search")
        .query("track_name", title)
        .query("artist_name", artist)
        .call();
    let mut list = match r {
        Ok(r) => r.into_json::<Vec<Value>>().map_err(|e| NetErr::Network(e.to_string()))?,
        Err(ureq::Error::Status(404, _)) => vec![],
        Err(e) => return Err(NetErr::Network(e.to_string())),
    };
    if list.is_empty() {
        let q = format!("{artist} {title}");
        if let Ok(r) = agent().get("https://lrclib.net/api/search").query("q", &q).call() {
            list = r.into_json::<Vec<Value>>().unwrap_or_default();
        }
    }
    Ok(list)
}

pub fn lrclib_by_id(id: i64) -> Result<Lyrics, NetErr> {
    match agent().get(&format!("https://lrclib.net/api/get/{id}")).call() {
        Ok(r) => r.into_json::<Value>().ok().as_ref().and_then(to_lyrics).ok_or(NetErr::NotFound),
        Err(ureq::Error::Status(404, _)) => Err(NetErr::NotFound),
        Err(e) => Err(NetErr::Network(e.to_string())),
    }
}

/// Render back to LRC text (for "save next to file").
pub fn to_lrc(l: &Lyrics) -> String {
    if !l.raw.is_empty() && l.kind == "synced" {
        return l.raw.clone();
    }
    if l.kind == "synced" {
        return l.lines.iter().map(|x| format!("[{:02}:{:05.2}]{}", (x.t / 60.0) as u32, x.t % 60.0, x.text)).collect::<Vec<_>>().join("\n");
    }
    l.lines.iter().map(|x| x.text.clone()).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lrc() {
        let l = parse_lrc("[ar:x]\n[00:12.50][01:00.00]hello\n[00:05.1]first\n[offset:500]\n");
        assert_eq!(l.len(), 3);
        assert_eq!(l[0].text, "first");
        assert!((l[1].t - 12.5).abs() < 1e-9);
        assert_eq!(normalize_title("Song (feat. X) [Remastered 2011]"), "Song");
        assert_eq!(normalize_title("Song - Live at Wembley"), "Song");
    }
}
