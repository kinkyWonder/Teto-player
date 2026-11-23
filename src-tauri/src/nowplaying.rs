//! «Трансляция» — what is playing right now, for other programs on this computer (OBS, overlays, bots, widgets,
//! Stream Deck, scripts…). Everything is local: the HTTP server listens on 127.0.0.1 only, nothing leaves the PC.
//!
//! Modules (docs/API.md has the full reference and client examples):
//!  - HTTP     `http://127.0.0.1:<port>/v1/…` — REST (`/now`, `/lyrics`, `/cover`, `/queue`, `/control/*`)
//!  - SSE      `GET /v1/events`  — live event stream (EventSource in a browser / OBS)
//!  - WebSocket `GET /v1/ws`     — the same events + commands from the client
//!  - overlay  `GET /overlay`    — ready-made OBS browser source (track, current lyric line, progress)
//!  - pipe     `\\.\pipe\teto-player` (Windows) — NDJSON event stream for native programs
//!  - files    `<data>\nowplaying\*.txt|json|jpg` — for tools that can only read files ("Text from file")
//!
//! The module knows nothing about Tauri: the app implements [`Host`]; tests use a fake host.
use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const API_VERSION: u32 = 1;
pub const DEFAULT_PORT: u16 = 7710;
pub const PIPE_NAME: &str = r"\\.\pipe\teto-player";

/// Settings → «Трансляция для других программ» (stored inside the app settings as `api`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct ApiCfg {
    /// local HTTP server (REST + SSE + WebSocket + overlay)
    pub enabled: bool,
    pub port: u16,
    /// write `<data>\nowplaying\*` files
    pub files: bool,
    /// Windows named pipe `\\.\pipe\teto-player`
    pub pipe: bool,
    /// allow /v1/control/* (play, pause, next, seek, volume, download…) — always needs the token
    pub control: bool,
    /// let ordinary web sites (any Origin) read the API; off = only local pages, OBS and programs
    pub allow_web: bool,
    pub token: String,
}
impl Default for ApiCfg {
    fn default() -> Self {
        ApiCfg { enabled: false, port: DEFAULT_PORT, files: false, pipe: true, control: false, allow_web: false, token: String::new() }
    }
}

pub fn new_token() -> String {
    const A: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    (0..24).map(|_| A[fastrand::usize(..A.len())] as char).collect()
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct TrackInfo {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_id: i64,
    pub year: u32,
    pub genre: String,
    pub dur: f64,
    pub codec: String,
    /// e.g. "FLAC 24/96"
    pub format: String,
    pub path: String,
}

#[derive(Clone, Debug, Default)]
pub struct Snap {
    pub track: Option<TrackInfo>,
    pub playing: bool,
    pub pos: f64,
    pub volume: f32,
    pub muted: bool,
    pub shuffle: bool,
    pub repeat: String,
    pub index: usize,
    pub queue_len: usize,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct LyrLine {
    pub t: f64,
    pub text: String,
}
#[derive(Clone, Debug, Default)]
pub struct Lyr {
    /// synced | plain | none | error
    pub kind: String,
    pub source: String,
    pub lines: Vec<LyrLine>,
}

/// What the app gives the API.
pub trait Host: Send + Sync + 'static {
    fn snapshot(&self) -> Option<Snap>;
    /// May block (cache → tags → .lrc → LRCLIB); called on a helper thread.
    fn lyrics(&self, track_id: i64) -> Option<Lyr>;
    /// JPEG or PNG bytes of the album cover (real, or the generated one).
    fn cover(&self, album_id: i64, size: u32) -> Option<Vec<u8>>;
    fn queue(&self, limit: usize) -> Value;
    fn control(&self, cmd: &str, arg: &Value) -> Result<Value, String>;
    fn version(&self) -> String;
    fn data_dir(&self) -> PathBuf;
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Index of the line being sung at `pos` (synced lyrics are sorted by time).
pub fn line_at(lines: &[LyrLine], pos: f64) -> Option<usize> {
    let i = lines.partition_point(|l| l.t <= pos + 0.05);
    if i == 0 { None } else { Some(i - 1) }
}

fn line_json(l: &Lyr, i: Option<usize>, dur: f64) -> Value {
    let Some(i) = i else { return Value::Null };
    let Some(x) = l.lines.get(i) else { return Value::Null };
    let end = l.lines.get(i + 1).map(|n| n.t).unwrap_or(dur.max(x.t));
    json!({ "index": i, "t": x.t, "end": end, "text": x.text })
}

/// Template for `/v1/now.txt` and the files: {title} {artist} {album} {year} {genre} {format} {line} {next} {pos} {dur} {state}
pub fn fill(tpl: &str, now: &Value) -> String {
    let tr = &now["track"];
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let mmss = |x: f64| { let x = x.max(0.0) as u64; format!("{}:{:02}", x / 60, x % 60) };
    let year = tr["year"].as_u64().filter(|y| *y > 0).map(|y| y.to_string()).unwrap_or_default();
    tpl.replace("{title}", &s(&tr["title"]))
        .replace("{artist}", &s(&tr["artist"]))
        .replace("{album}", &s(&tr["album"]))
        .replace("{year}", &year)
        .replace("{genre}", &s(&tr["genre"]))
        .replace("{format}", &s(&tr["format"]))
        .replace("{line}", &s(&now["lyrics"]["line"]["text"]))
        .replace("{next}", &s(&now["lyrics"]["next"]["text"]))
        .replace("{pos}", &mmss(now["pos"].as_f64().unwrap_or(0.0)))
        .replace("{dur}", &mmss(now["dur"].as_f64().unwrap_or(0.0)))
        .replace("{state}", &s(&now["state"]))
}

pub struct Msg {
    pub event: &'static str,
    pub data: String,
}
struct Sub {
    id: u64,
    tx: Sender<Arc<Msg>>,
    pos: bool,
    filter: Option<Vec<String>>,
}

#[derive(Default)]
struct Live {
    snap: Option<Snap>,
    at: Option<Instant>,
    lyr_for: i64,
    lyr: Option<Arc<Lyr>>,
    lyr_gen: u64,
    line: Option<usize>,
    line_dirty: bool,
    pos_at: Option<Instant>,
}

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
}

pub struct Hub {
    host: Arc<dyn Host>,
    cfg: Mutex<ApiCfg>,
    subs: Mutex<Vec<Sub>>,
    next_id: AtomicU64,
    kick_tx: Sender<()>,
    live: Mutex<Live>,
    server: Mutex<Option<Server>>,
    status: Mutex<String>,
    pipe_stop: Mutex<Option<Arc<AtomicBool>>>,
    files: Mutex<HashMap<&'static str, String>>,
}

impl Hub {
    pub fn new(host: Arc<dyn Host>) -> Arc<Hub> {
        let (kick_tx, kick_rx) = bounded::<()>(1);
        let hub = Arc::new(Hub {
            host,
            cfg: Mutex::new(ApiCfg::default()),
            subs: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
            kick_tx,
            live: Mutex::new(Live::default()),
            server: Mutex::new(None),
            status: Mutex::new("Выключено".into()),
            pipe_stop: Mutex::new(None),
            files: Mutex::new(HashMap::new()),
        });
        let h = hub.clone();
        std::thread::Builder::new().name("teto-api".into()).spawn(move || h.tick_loop(kick_rx)).ok();
        hub
    }

    pub fn cfg(&self) -> ApiCfg {
        self.cfg.lock().clone()
    }

    /// Applies new settings: starts / stops / moves the server and the pipe.
    pub fn set_cfg(self: &Arc<Self>, c: ApiCfg) {
        *self.cfg.lock() = c.clone();
        // HTTP
        let mut srv = self.server.lock();
        let want = c.enabled.then_some(c.port);
        if srv.as_ref().map(|s| s.port) != want {
            if let Some(s) = srv.take() {
                s.stop.store(true, Ordering::SeqCst);
                let _ = TcpStream::connect_timeout(&([127, 0, 0, 1], s.port).into(), Duration::from_millis(300));
            }
            if let Some(port) = want {
                match TcpListener::bind(("127.0.0.1", port)) {
                    Ok(l) => {
                        let stop = Arc::new(AtomicBool::new(false));
                        let (h, st) = (self.clone(), stop.clone());
                        std::thread::Builder::new().name("teto-api-http".into()).spawn(move || h.accept_loop(l, st)).ok();
                        *srv = Some(Server { port, stop });
                        *self.status.lock() = format!("Работает: http://127.0.0.1:{port}");
                    }
                    Err(e) => *self.status.lock() = format!("Порт {port} занят: {e}"),
                }
            } else {
                *self.status.lock() = "Выключено".into();
            }
        }
        drop(srv);
        // named pipe
        let mut ps = self.pipe_stop.lock();
        let want_pipe = c.enabled && c.pipe && cfg!(windows);
        if want_pipe != ps.is_some() {
            if let Some(stop) = ps.take() {
                stop.store(true, Ordering::SeqCst);
                pipe::unblock();
            }
            if want_pipe {
                let stop = Arc::new(AtomicBool::new(false));
                let (h, st) = (self.clone(), stop.clone());
                std::thread::Builder::new().name("teto-api-pipe".into()).spawn(move || pipe::serve(h, st)).ok();
                *ps = Some(stop);
            }
        }
        drop(ps);
        self.kick();
    }

    pub fn status(&self) -> Value {
        let c = self.cfg();
        json!({
            "running": self.server.lock().is_some(),
            "message": self.status.lock().clone(),
            "port": c.port,
            "clients": self.subs.lock().len(),
            "pipe": if c.enabled && c.pipe && cfg!(windows) { PIPE_NAME } else { "" },
            "files": if c.enabled && c.files { self.host.data_dir().join("nowplaying").to_string_lossy().into_owned() } else { String::new() },
        })
    }

    /// Something changed (track, play/pause, seek, volume…): look again right away.
    pub fn kick(&self) {
        let _ = self.kick_tx.try_send(());
    }

    /// The user picked other lyrics for this track.
    pub fn lyrics_changed(self: &Arc<Self>, track_id: i64) {
        let mut l = self.live.lock();
        if l.lyr_for == track_id {
            l.lyr_for = -1; // fetched again on the next tick
        }
        drop(l);
        self.kick();
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.cfg.lock().port)
    }

    /// The `now` object (also the payload of `hello`, `track` and `state`).
    pub fn now(&self) -> Value {
        let snap = self.host.snapshot();
        let l = self.live.lock();
        let lyr = snap.as_ref().and_then(|s| s.track.as_ref()).filter(|t| t.id == l.lyr_for).and_then(|_| l.lyr.clone());
        drop(l);
        self.now_of(snap.as_ref(), lyr.as_deref())
    }

    fn now_of(&self, snap: Option<&Snap>, lyr: Option<&Lyr>) -> Value {
        let ts = now_ms();
        let Some(s) = snap.filter(|s| s.track.is_some()) else {
            return json!({ "v": API_VERSION, "state": "stopped", "ts": ts, "pos": 0.0, "dur": 0.0, "track": null, "cover_url": null, "lyrics": null, "queue": { "index": 0, "length": 0 } });
        };
        let t = s.track.as_ref().unwrap();
        let lyrics = match lyr {
            None => json!({ "kind": "loading", "source": "", "count": 0, "line": null, "next": null, "prev": null }),
            Some(l) => {
                let i = if l.kind == "synced" { line_at(&l.lines, s.pos) } else { None };
                let next = if l.kind == "synced" { Some(i.map_or(0, |i| i + 1)) } else { None };
                json!({
                    "kind": l.kind, "source": l.source, "count": l.lines.len(),
                    "line": line_json(l, i, t.dur),
                    "next": line_json(l, next, t.dur),
                    "prev": line_json(l, i.and_then(|i| i.checked_sub(1)), t.dur),
                })
            }
        };
        json!({
            "v": API_VERSION,
            "state": if s.playing { "playing" } else { "paused" },
            "ts": ts,
            "pos": (s.pos * 1000.0).round() / 1000.0,
            "dur": t.dur,
            "track": t,
            "cover_url": format!("{}/v1/cover/{}?size=600", self.base_url(), t.album_id),
            "lyrics": lyrics,
            "volume": s.volume, "muted": s.muted, "shuffle": s.shuffle, "repeat": s.repeat,
            "queue": { "index": s.index, "length": s.queue_len },
        })
    }

    /// Full lyrics of the current track (fetched now if needed).
    pub fn lyrics_now(&self) -> Value {
        let Some(s) = self.host.snapshot() else { return json!({ "track_id": null, "kind": "none", "source": "", "lines": [] }) };
        let Some(t) = s.track else { return json!({ "track_id": null, "kind": "none", "source": "", "lines": [] }) };
        let cached = { let l = self.live.lock(); (l.lyr_for == t.id).then(|| l.lyr.clone()).flatten() };
        let lyr = cached.or_else(|| self.host.lyrics(t.id).map(Arc::new));
        match lyr {
            None => json!({ "track_id": t.id, "kind": "none", "source": "", "lines": [] }),
            Some(l) => json!({ "track_id": t.id, "kind": l.kind, "source": l.source, "lines": l.lines.iter().enumerate().map(|(i, _)| line_json(&l, Some(i), t.dur)).collect::<Vec<_>>() }),
        }
    }

    // ---------------- events ----------------
    fn subscribe(&self, pos: bool, filter: Option<Vec<String>>) -> (u64, Receiver<Arc<Msg>>) {
        let (tx, rx) = bounded(256);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.subs.lock().push(Sub { id, tx, pos, filter });
        self.kick();
        (id, rx)
    }
    fn unsubscribe(&self, id: u64) {
        self.subs.lock().retain(|s| s.id != id);
    }
    fn emit(&self, event: &'static str, data: &Value) {
        let mut subs = self.subs.lock();
        if subs.is_empty() {
            return;
        }
        let m = Arc::new(Msg { event, data: data.to_string() });
        subs.retain(|s| {
            if event == "pos" && !s.pos {
                return true;
            }
            if let Some(f) = &s.filter {
                if !f.iter().any(|x| x == event) {
                    return true;
                }
            }
            !matches!(s.tx.try_send(m.clone()), Err(TrySendError::Disconnected(_)))
        });
    }

    fn tick_loop(self: Arc<Self>, kick: Receiver<()>) {
        loop {
            let c = self.cfg();
            let active = c.enabled && (c.files || !self.subs.lock().is_empty());
            let _ = kick.recv_timeout(Duration::from_millis(if active { 100 } else { 1000 }));
            if !c.enabled {
                continue;
            }
            self.tick(&c);
        }
    }

    fn tick(self: &Arc<Self>, c: &ApiCfg) {
        let snap = self.host.snapshot();
        let tid = snap.as_ref().and_then(|s| s.track.as_ref()).map(|t| t.id).unwrap_or(0);
        let mut ev: Vec<&'static str> = Vec::new();
        let mut l = self.live.lock();
        let prev = l.snap.clone();
        let ptid = prev.as_ref().and_then(|s| s.track.as_ref()).map(|t| t.id).unwrap_or(0);
        if tid != ptid || l.at.is_none() {
            ev.push("track");
            l.line = None;
            l.line_dirty = true;
        } else if let (Some(a), Some(b)) = (prev.as_ref(), snap.as_ref()) {
            let expect = a.pos + if a.playing { l.at.map(|x| x.elapsed().as_secs_f64()).unwrap_or(0.0) } else { 0.0 };
            let jumped = (b.pos - expect).abs() > 1.5;
            if a.playing != b.playing || jumped || a.volume != b.volume || a.muted != b.muted || a.shuffle != b.shuffle || a.repeat != b.repeat
                || a.index != b.index || a.queue_len != b.queue_len {
                ev.push("state");
                if jumped {
                    l.line_dirty = true;
                }
            }
        }
        // lyrics of a new track: fetched on a helper thread (may hit the network)
        if tid != 0 && l.lyr_for != tid {
            l.lyr_for = tid;
            l.lyr = None;
            l.lyr_gen += 1;
            let gen = l.lyr_gen;
            let h = self.clone();
            std::thread::spawn(move || {
                let r = h.host.lyrics(tid).unwrap_or(Lyr { kind: "none".into(), ..Default::default() });
                let mut l = h.live.lock();
                if l.lyr_gen == gen {
                    l.lyr = Some(Arc::new(r));
                    l.line_dirty = true;
                    drop(l);
                    h.lyrics_loaded(tid);
                    h.kick();
                }
            });
        }
        if tid == 0 {
            l.lyr_for = 0;
            l.lyr = None;
        }
        // current line
        let mut line_ev = None;
        if let (Some(s), Some(ly)) = (snap.as_ref(), l.lyr.clone()) {
            if ly.kind == "synced" {
                let i = line_at(&ly.lines, s.pos);
                if i != l.line || l.line_dirty {
                    l.line = i;
                    let dur = s.track.as_ref().map(|t| t.dur).unwrap_or(0.0);
                    line_ev = Some(json!({
                        "track_id": tid, "pos": s.pos, "ts": now_ms(),
                        "line": line_json(&ly, i, dur), "next": line_json(&ly, Some(i.map_or(0, |i| i + 1)), dur),
                        "prev": line_json(&ly, i.and_then(|i| i.checked_sub(1)), dur),
                    }));
                }
            }
        }
        l.line_dirty = false;
        let pos_due = snap.as_ref().map(|s| s.playing).unwrap_or(false) && l.pos_at.map(|x| x.elapsed() >= Duration::from_secs(1)).unwrap_or(true);
        if pos_due {
            l.pos_at = Some(Instant::now());
        }
        l.snap = snap.clone();
        l.at = Some(Instant::now());
        let lyr = (l.lyr_for == tid).then(|| l.lyr.clone()).flatten();
        drop(l);

        let need_now = !ev.is_empty() || line_ev.is_some();
        let now = if need_now || c.files { Some(self.now_of(snap.as_ref(), lyr.as_deref())) } else { None };
        for e in &ev {
            self.emit(e, now.as_ref().unwrap());
        }
        if let Some(le) = &line_ev {
            self.emit("line", le);
        }
        if pos_due {
            if let Some(s) = &snap {
                self.emit("pos", &json!({ "track_id": tid, "pos": s.pos, "dur": s.track.as_ref().map(|t| t.dur).unwrap_or(0.0), "ts": now_ms(), "playing": s.playing }));
            }
        }
        if c.files {
            if let Some(n) = &now {
                self.write_files(n);
            }
        }
    }

    fn lyrics_loaded(&self, tid: i64) {
        let snap = self.host.snapshot();
        if snap.as_ref().and_then(|s| s.track.as_ref()).map(|t| t.id) != Some(tid) {
            return;
        }
        let v = self.lyrics_now();
        self.emit("lyrics", &v);
    }

    // ---------------- files ----------------
    fn write_files(&self, now: &Value) {
        let dir = self.host.data_dir().join("nowplaying");
        let _ = std::fs::create_dir_all(&dir);
        let stopped = now["state"] == "stopped";
        let txt = |tpl: &str| if stopped { String::new() } else { fill(tpl, now) };
        let mut stable = now.clone();
        stable["ts"] = json!(0);
        stable["pos"] = json!(0);
        let items: [(&'static str, String); 9] = [
            ("track.txt", txt("{artist} — {title}")),
            ("title.txt", txt("{title}")),
            ("artist.txt", txt("{artist}")),
            ("album.txt", txt("{album}")),
            ("line.txt", txt("{line}")),
            ("next_line.txt", txt("{next}")),
            ("state.txt", now["state"].as_str().unwrap_or("").to_string()),
            ("now.json.key", stable.to_string()),
            ("cover.key", now["track"]["album_id"].to_string()),
        ];
        let mut last = self.files.lock();
        for (name, body) in items {
            if last.get(name) == Some(&body) {
                continue;
            }
            match name {
                "now.json.key" => {
                    let _ = write_atomic(&dir.join("now.json"), serde_json::to_string_pretty(now).unwrap_or_default().as_bytes());
                }
                "cover.key" => {
                    let img = now["track"]["album_id"].as_i64().and_then(|id| self.host.cover(id, 600));
                    match img {
                        Some(b) => {
                            let _ = write_atomic(&dir.join("cover.jpg"), &b);
                        }
                        None => {
                            let _ = std::fs::remove_file(dir.join("cover.jpg"));
                        }
                    }
                }
                _ => {
                    let _ = write_atomic(&dir.join(name), body.as_bytes());
                }
            }
            last.insert(name, body);
        }
    }

    // ---------------- HTTP ----------------
    fn accept_loop(self: Arc<Self>, l: TcpListener, stop: Arc<AtomicBool>) {
        for s in l.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(s) = s else { continue };
            let h = self.clone();
            std::thread::Builder::new().name("teto-api-conn".into()).spawn(move || h.handle(s)).ok();
        }
    }

    fn handle(self: Arc<Self>, mut s: TcpStream) {
        let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = s.set_nodelay(true);
        let Some(req) = Req::read(&mut s) else { return };
        let c = self.cfg();
        // DNS-rebinding guard: only our own host names
        let host_ok = match req.header("host") {
            None => true,
            Some(h) => {
                let h = h.to_ascii_lowercase();
                [format!("127.0.0.1:{}", c.port), format!("localhost:{}", c.port), format!("[::1]:{}", c.port), "127.0.0.1".into(), "localhost".into()].contains(&h)
            }
        };
        if !host_ok {
            return respond(&mut s, 403, "text/plain; charset=utf-8", b"forbidden host", &[]);
        }
        // privacy: web pages from other sites can't read what you listen to unless allowed
        if let Some(o) = req.header("origin") {
            if !c.allow_web && !origin_local(o) {
                return respond(&mut s, 403, "text/plain; charset=utf-8", "Teto Player: доступ сайтам выключен (Настройки → Трансляция → «Разрешить сайтам»)".as_bytes(), &[]);
            }
        }
        if req.method == "OPTIONS" {
            return respond(&mut s, 204, "text/plain", b"", &[("Access-Control-Allow-Methods", "GET, POST, OPTIONS"), ("Access-Control-Allow-Headers", "Authorization, Content-Type"), ("Access-Control-Max-Age", "600")]);
        }
        let path = req.path.trim_end_matches('/').to_string();
        let path = if path.is_empty() { "/".to_string() } else { path };
        let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        match (req.method.as_str(), segs.as_slice()) {
            ("GET", [""]) => respond(&mut s, 200, "text/html; charset=utf-8", index_html(&self.base_url(), &self.host.version()).as_bytes(), &[]),
            ("GET", ["overlay"]) => respond(&mut s, 200, "text/html; charset=utf-8", OVERLAY_HTML.as_bytes(), &[]),
            ("GET", ["v1"]) | ("GET", ["v1", "info"]) => {
                let v = json!({ "app": "Teto Player", "version": self.host.version(), "api": API_VERSION, "control": c.control,
                    "pipe": if c.pipe && cfg!(windows) { PIPE_NAME } else { "" },
                    "endpoints": ["/v1/now", "/v1/now.txt", "/v1/lyrics", "/v1/cover", "/v1/cover/{album_id}", "/v1/queue", "/v1/events", "/v1/ws", "/v1/control/{cmd}", "/overlay"] });
                json_resp(&mut s, 200, &v)
            }
            ("GET", ["v1", "now"]) => json_resp(&mut s, 200, &self.now()),
            ("GET", ["v1", "now.txt"]) => {
                let tpl = req.query("fmt").unwrap_or_else(|| "{artist} — {title}".into());
                let n = self.now();
                let body = if n["state"] == "stopped" { String::new() } else { fill(&tpl, &n) };
                respond(&mut s, 200, "text/plain; charset=utf-8", body.as_bytes(), &[])
            }
            ("GET", ["v1", "lyrics"]) => json_resp(&mut s, 200, &self.lyrics_now()),
            ("GET", ["v1", "queue"]) => {
                let n = req.query("limit").and_then(|x| x.parse().ok()).unwrap_or(20usize).min(500);
                json_resp(&mut s, 200, &self.host.queue(n))
            }
            ("GET", ["v1", "cover"]) | ("GET", ["v1", "cover", _]) => {
                let id = match segs.get(2) {
                    Some(x) => x.parse::<i64>().ok(),
                    None => self.host.snapshot().and_then(|s| s.track).map(|t| t.album_id),
                };
                let size = req.query("size").and_then(|x| x.parse().ok()).unwrap_or(600u32).clamp(64, 600);
                match id.and_then(|id| self.host.cover(id, size)) {
                    Some(b) => {
                        let ct = if b.starts_with(&[0x89, b'P', b'N', b'G']) { "image/png" } else { "image/jpeg" };
                        respond(&mut s, 200, ct, &b, &[])
                    }
                    None => json_resp(&mut s, 404, &json!({ "error": "no cover" })),
                }
            }
            ("GET", ["v1", "events"]) => self.sse(s, &req),
            ("GET", ["v1", "ws"]) => self.ws(s, &req),
            ("POST", ["v1", "control", cmd]) => {
                let cmd = cmd.to_string();
                let r = self.control(&c, &req, &cmd, &serde_json::from_slice::<Value>(&req.body).unwrap_or(Value::Null));
                match r {
                    Ok(v) => json_resp(&mut s, 200, &v),
                    Err((code, e)) => json_resp(&mut s, code, &json!({ "ok": false, "error": e })),
                }
            }
            _ => json_resp(&mut s, 404, &json!({ "error": "not found", "see": "/" })),
        }
    }

    fn control(&self, c: &ApiCfg, req: &Req, cmd: &str, body: &Value) -> Result<Value, (u16, String)> {
        let tok = req.header("authorization").and_then(|h| h.strip_prefix("Bearer ").map(|x| x.trim().to_string())).or_else(|| req.query("token"));
        self.control_tok(c, tok.as_deref(), cmd, body)
    }
    fn control_tok(&self, c: &ApiCfg, tok: Option<&str>, cmd: &str, body: &Value) -> Result<Value, (u16, String)> {
        if !c.control {
            return Err((403, "управление выключено (Настройки → Трансляция → «Разрешить управление»)".into()));
        }
        if c.token.is_empty() || !tok.map(|t| ct_eq(t.as_bytes(), c.token.as_bytes())).unwrap_or(false) {
            return Err((401, "нужен токен: Authorization: Bearer <token>".into()));
        }
        let r = self.host.control(cmd, body).map_err(|e| (400, e))?;
        self.kick();
        Ok(r)
    }

    fn sse(self: &Arc<Self>, mut s: TcpStream, req: &Req) {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\nX-Accel-Buffering: no\r\n\r\n";
        if s.write_all(head.as_bytes()).is_err() {
            return;
        }
        let pos = req.query("pos").map(|x| x != "0").unwrap_or(true);
        let filter = req.query("events").map(|x| x.split(',').map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect::<Vec<_>>());
        let (id, rx) = self.subscribe(pos, filter);
        let hello = format!("retry: 2000\nevent: hello\ndata: {}\n\n", self.now());
        let mut ok = s.write_all(hello.as_bytes()).is_ok();
        while ok {
            match rx.recv_timeout(Duration::from_secs(15)) {
                Ok(m) => ok = s.write_all(format!("event: {}\ndata: {}\n\n", m.event, m.data).as_bytes()).is_ok(),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => ok = s.write_all(b": ping\n\n").is_ok(),
                Err(_) => ok = false,
            }
        }
        self.unsubscribe(id);
    }

    fn ws(self: &Arc<Self>, mut s: TcpStream, req: &Req) {
        let Some(key) = req.header("sec-websocket-key").filter(|_| req.header("upgrade").map(|u| u.eq_ignore_ascii_case("websocket")).unwrap_or(false)) else {
            return json_resp(&mut s, 400, &json!({ "error": "WebSocket upgrade expected" }));
        };
        let accept = ws_accept(key.trim());
        let head = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
        if s.write_all(head.as_bytes()).is_err() {
            return;
        }
        let pos = req.query("pos").map(|x| x != "0").unwrap_or(true);
        let filter = req.query("events").map(|x| x.split(',').map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect::<Vec<_>>());
        let (id, rx) = self.subscribe(pos, filter);
        let out = Arc::new(Mutex::new(match s.try_clone() { Ok(x) => x, Err(_) => return self.unsubscribe(id) }));
        let alive = Arc::new(AtomicBool::new(true));
        let _ = ws_send(&mut out.lock(), 1, ev_json("hello", &self.now().to_string()).as_bytes());
        // reader: commands from the client, ping/pong, close
        {
            let (h, out, alive, mut rd) = (self.clone(), out.clone(), alive.clone(), s);
            let _ = rd.set_read_timeout(None);
            std::thread::spawn(move || {
                while let Some((op, data)) = ws_read(&mut rd) {
                    match op {
                        1 => {
                            let reply = h.ws_command(&String::from_utf8_lossy(&data));
                            if ws_send(&mut out.lock(), 1, reply.as_bytes()).is_err() {
                                break;
                            }
                        }
                        8 => {
                            let _ = ws_send(&mut out.lock(), 8, &[]);
                            break;
                        }
                        9 => {
                            let _ = ws_send(&mut out.lock(), 10, &data);
                        }
                        _ => {}
                    }
                }
                alive.store(false, Ordering::SeqCst);
                let _ = rd.shutdown(Shutdown::Both);
                h.kick();
            });
        }
        while alive.load(Ordering::SeqCst) {
            let r = match rx.recv_timeout(Duration::from_secs(15)) {
                Ok(m) => ws_send(&mut out.lock(), 1, ev_json(m.event, &m.data).as_bytes()),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => ws_send(&mut out.lock(), 9, b"teto"),
                Err(_) => break,
            };
            if r.is_err() {
                break;
            }
        }
        let _ = out.lock().shutdown(Shutdown::Both);
        self.unsubscribe(id);
    }

    /// WebSocket text message: {"cmd":"now"|"lyrics"|"queue"|<control>, "args":{…}, "token":"…", "id":…}
    fn ws_command(&self, text: &str) -> String {
        let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
        let id = v["id"].clone();
        let cmd = v["cmd"].as_str().unwrap_or("");
        let r: Result<Value, (u16, String)> = match cmd {
            "now" => Ok(self.now()),
            "lyrics" => Ok(self.lyrics_now()),
            "queue" => Ok(self.host.queue(v["args"]["limit"].as_u64().unwrap_or(20).min(500) as usize)),
            "" => Err((400, "cmd?".into())),
            c => self.control_tok(&self.cfg(), v["token"].as_str(), c, &v["args"]),
        };
        let data = match r {
            Ok(x) => json!({ "id": id, "ok": true, "result": x }),
            Err((code, e)) => json!({ "id": id, "ok": false, "code": code, "error": e }),
        };
        ev_json("reply", &data.to_string())
    }
}

fn ev_json(event: &str, data: &str) -> String {
    format!("{{\"event\":\"{event}\",\"data\":{data}}}")
}

fn origin_local(o: &str) -> bool {
    let o = o.trim().to_ascii_lowercase();
    if o == "null" || o.starts_with("file://") {
        return true;
    }
    let host = o.split("://").nth(1).unwrap_or("").split(':').next().unwrap_or("").trim_end_matches('/');
    matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "teto.localhost")
}

/// Constant-time comparison (the token).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn write_atomic(p: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, p).or_else(|_| std::fs::write(p, data))
}

// ---------------- minimal HTTP/1.1 ----------------
struct Req {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
impl Req {
    fn read(s: &mut TcpStream) -> Option<Req> {
        let mut r = BufReader::new(s.try_clone().ok()?);
        let mut line = String::new();
        r.read_line(&mut line).ok()?;
        let mut it = line.split_whitespace();
        let method = it.next()?.to_ascii_uppercase();
        let target = it.next()?.to_string();
        let mut headers = Vec::new();
        let mut total = 0usize;
        loop {
            let mut h = String::new();
            let n = r.read_line(&mut h).ok()?;
            total += n;
            if n == 0 || total > 16 * 1024 {
                return None;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
            }
        }
        let len = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse::<usize>().ok()).unwrap_or(0).min(64 * 1024);
        let mut body = vec![0u8; len];
        if len > 0 {
            r.read_exact(&mut body).ok()?;
        }
        let (path, qs) = target.split_once('?').unwrap_or((&target, ""));
        let query = qs.split('&').filter(|x| !x.is_empty()).map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (pct_decode(k), pct_decode(v))
        }).collect();
        Some(Req { method, path: pct_decode(path), query, headers, body })
    }
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str())
    }
    fn query(&self, k: &str) -> Option<String> {
        self.query.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone())
    }
}

pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(x) => {
                        out.push(x);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            x => out.push(x),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn respond(s: &mut TcpStream, code: u16, ctype: &str, body: &[u8], extra: &[(&str, &str)]) {
    let reason = match code { 200 => "OK", 204 => "No Content", 400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found", _ => "Error" };
    let mut h = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n", body.len());
    for (k, v) in extra {
        h.push_str(&format!("{k}: {v}\r\n"));
    }
    h.push_str("\r\n");
    let _ = s.write_all(h.as_bytes());
    let _ = s.write_all(body);
    let _ = s.flush();
}
fn json_resp(s: &mut TcpStream, code: u16, v: &Value) {
    respond(s, code, "application/json; charset=utf-8", v.to_string().as_bytes(), &[]);
}

// ---------------- WebSocket (RFC 6455, server side) ----------------
pub fn ws_accept(key: &str) -> String {
    b64(&sha1(format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes()))
}
fn ws_send(s: &mut TcpStream, op: u8, data: &[u8]) -> std::io::Result<()> {
    let mut h = vec![0x80 | op];
    match data.len() {
        n if n < 126 => h.push(n as u8),
        n if n < 65536 => {
            h.push(126);
            h.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            h.push(127);
            h.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    s.write_all(&h)?;
    s.write_all(data)
}
/// One client frame (control frames and unfragmented messages; fragments are joined).
fn ws_read(s: &mut TcpStream) -> Option<(u8, Vec<u8>)> {
    let mut msg = Vec::new();
    let mut first_op = 0u8;
    loop {
        let mut h = [0u8; 2];
        s.read_exact(&mut h).ok()?;
        let fin = h[0] & 0x80 != 0;
        let op = h[0] & 0x0f;
        let masked = h[1] & 0x80 != 0;
        let mut len = (h[1] & 0x7f) as u64;
        if len == 126 {
            let mut b = [0u8; 2];
            s.read_exact(&mut b).ok()?;
            len = u16::from_be_bytes(b) as u64;
        } else if len == 127 {
            let mut b = [0u8; 8];
            s.read_exact(&mut b).ok()?;
            len = u64::from_be_bytes(b);
        }
        if len > 1 << 20 {
            return None;
        }
        let mut mask = [0u8; 4];
        if masked {
            s.read_exact(&mut mask).ok()?;
        }
        let mut data = vec![0u8; len as usize];
        s.read_exact(&mut data).ok()?;
        if masked {
            for (i, b) in data.iter_mut().enumerate() {
                *b ^= mask[i % 4];
            }
        }
        if op >= 8 {
            return Some((op, data)); // control frames are never fragmented
        }
        if op != 0 {
            first_op = op;
        }
        msg.extend_from_slice(&data);
        if fin {
            return Some((first_op, msg));
        }
    }
}

pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut m = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    m.push(0x80);
    while m.len() % 64 != 56 {
        m.push(0);
    }
    m.extend_from_slice(&bits.to_be_bytes());
    for chunk in m.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, x) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&x.to_be_bytes());
    }
    out
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub fn b64(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}
/// Standard base64 (whitespace and a data-URL prefix are ignored).
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.rsplit(',').next().unwrap_or(s);
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut n) = (0u32, 0u32);
    for ch in s.bytes() {
        let v = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        } as u32;
        acc = acc << 6 | v;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((acc >> n) as u8);
            acc &= (1 << n) - 1;
        }
    }
    Some(out)
}

// ---------------- Windows named pipe: \\.\pipe\teto-player (NDJSON, server → client) ----------------
#[cfg(windows)]
mod pipe {
    use super::{ev_json, Hub, PIPE_NAME};
    use std::io::Write;
    use std::os::windows::io::FromRawHandle;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    type Handle = *mut core::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateNamedPipeW(name: *const u16, open_mode: u32, pipe_mode: u32, max_inst: u32, out_buf: u32, in_buf: u32, timeout: u32, sa: *mut core::ffi::c_void) -> Handle;
        fn ConnectNamedPipe(h: Handle, ov: *mut core::ffi::c_void) -> i32;
        fn CloseHandle(h: Handle) -> i32;
        fn GetLastError() -> u32;
    }
    const PIPE_ACCESS_OUTBOUND: u32 = 0x2;
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x8;
    const ERROR_PIPE_CONNECTED: u32 = 535;

    pub fn serve(hub: Arc<Hub>, stop: Arc<AtomicBool>) {
        let name: Vec<u16> = PIPE_NAME.encode_utf16().chain(std::iter::once(0)).collect();
        while !stop.load(Ordering::SeqCst) {
            let h = unsafe { CreateNamedPipeW(name.as_ptr(), PIPE_ACCESS_OUTBOUND, PIPE_REJECT_REMOTE_CLIENTS, 255, 64 * 1024, 0, 0, std::ptr::null_mut()) };
            if h.is_null() || h as isize == -1 {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            let ok = unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) } != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
            if stop.load(Ordering::SeqCst) || !ok {
                unsafe { CloseHandle(h) };
                continue;
            }
            let file = unsafe { std::fs::File::from_raw_handle(h as _) };
            let hub = hub.clone();
            std::thread::spawn(move || client(hub, file));
        }
    }
    fn client(hub: Arc<Hub>, mut f: std::fs::File) {
        let (id, rx) = hub.subscribe(true, None);
        let mut ok = writeln!(f, "{}", ev_json("hello", &hub.now().to_string())).is_ok();
        while ok {
            match rx.recv_timeout(Duration::from_secs(15)) {
                Ok(m) => ok = writeln!(f, "{}", ev_json(m.event, &m.data)).and_then(|_| f.flush()).is_ok(),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => ok = writeln!(f, "{{\"event\":\"ping\",\"data\":null}}").is_ok(),
                Err(_) => ok = false,
            }
        }
        hub.unsubscribe(id);
    }
    /// Wakes the thread waiting in ConnectNamedPipe so it can see the stop flag.
    pub fn unblock() {
        let _ = std::fs::OpenOptions::new().read(true).open(PIPE_NAME);
    }
}
#[cfg(not(windows))]
mod pipe {
    use super::Hub;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    pub fn serve(_hub: Arc<Hub>, _stop: Arc<AtomicBool>) {}
    pub fn unblock() {}
}

// ---------------- pages ----------------
fn index_html(base: &str, version: &str) -> String {
    INDEX_HTML.replace("{base}", base).replace("{version}", version)
}

const INDEX_HTML: &str = r#"<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Teto Player API</title>
<style>body{font:15px/1.55 system-ui,Segoe UI,sans-serif;background:#0b1214;color:#dfe9ec;max-width:860px;margin:40px auto;padding:0 20px}
a{color:#6fd3c9}code,pre{font-family:Consolas,monospace;background:#131d20;border-radius:6px}code{padding:1px 6px}pre{padding:12px;overflow:auto}
h1{font-size:26px}h2{font-size:18px;margin-top:28px}td{padding:4px 12px 4px 0;vertical-align:top}#now{white-space:pre-wrap}</style></head><body>
<h1>Teto Player API <small style="opacity:.6">v1 · Teto {version}</small></h1>
<p>Локальный API: что сейчас играет, таймкод и текущая строка текста. Доступен только с этого компьютера. Полная документация — <code>docs/API.md</code>.</p>
<h2>Сейчас</h2><pre id="now">…</pre>
<h2>Адреса</h2><table>
<tr><td><a href="/v1/now">GET /v1/now</a></td><td>что играет: трек, позиция, состояние, текущая/следующая строка</td></tr>
<tr><td><a href="/v1/now.txt">GET /v1/now.txt?fmt=…</a></td><td>одна строка текста по шаблону: {artist} {title} {album} {line} {next} {pos} {dur} {state}</td></tr>
<tr><td><a href="/v1/lyrics">GET /v1/lyrics</a></td><td>весь текст песни с таймкодами</td></tr>
<tr><td><a href="/v1/cover">GET /v1/cover</a></td><td>обложка текущего альбома (JPEG/PNG), <code>?size=64…600</code></td></tr>
<tr><td><a href="/v1/queue">GET /v1/queue</a></td><td>очередь (следующие треки)</td></tr>
<tr><td><a href="/v1/events">GET /v1/events</a></td><td>поток событий (Server-Sent Events): hello, track, state, line, lyrics, pos</td></tr>
<tr><td><code>GET /v1/ws</code></td><td>WebSocket: те же события + команды</td></tr>
<tr><td><code>POST /v1/control/{cmd}</code></td><td>управление (нужен токен): play, pause, toggle, next, prev, seek, volume, mute, shuffle, repeat, download</td></tr>
<tr><td><a href="/overlay">GET /overlay</a></td><td>готовый оверлей для OBS («Браузер»), прозрачный фон</td></tr>
</table>
<p>Также: именованный канал <code>\\.\pipe\teto-player</code> (NDJSON) и файлы в папке данных <code>nowplaying\</code>.</p>
<script>const es=new EventSource('/v1/events?pos=0');const show=(e)=>{document.getElementById('now').textContent=JSON.stringify(JSON.parse(e.data),null,2)};
['hello','track','state'].forEach(k=>es.addEventListener(k,show));</script></body></html>"#;

/// OBS browser source. Query: ?cover=0 &lyrics=0 &progress=0 &next=0 &align=left|center|right &scale=1.2 &accent=%23ff4d6d
const OVERLAY_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Teto · overlay</title>
<style>
:root{--acc:#6fd3c9;--s:1}
html,body{margin:0;background:transparent;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif;color:#fff}
#w{display:flex;gap:calc(16px*var(--s));align-items:center;padding:calc(14px*var(--s));opacity:0;transform:translateY(8px);transition:opacity .5s,transform .5s}
#w.on{opacity:1;transform:none}
#w.center{justify-content:center;text-align:center}#w.right{flex-direction:row-reverse;text-align:right}
#c{width:calc(84px*var(--s));height:calc(84px*var(--s));border-radius:calc(10px*var(--s));object-fit:cover;box-shadow:0 6px 24px #0008;flex:none;background:#0004}
#m{min-width:0;max-width:calc(720px*var(--s));text-shadow:0 2px 8px #000c}
#t{font-weight:700;font-size:calc(22px*var(--s));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#a{opacity:.82;font-size:calc(16px*var(--s));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#l{margin-top:calc(8px*var(--s));font-size:calc(19px*var(--s));font-weight:600;min-height:1.3em;transition:opacity .25s}
#n{font-size:calc(15px*var(--s));opacity:.55;min-height:1.2em}
#p{margin-top:calc(8px*var(--s));height:calc(4px*var(--s));border-radius:4px;background:#ffffff30;overflow:hidden}
#p i{display:block;height:100%;width:0;background:var(--acc)}
#w.paused #t:after{content:"  ⏸";opacity:.7}
</style></head><body><div id="w"><img id="c" alt=""><div id="m"><div id="t"></div><div id="a"></div><div id="l"></div><div id="n"></div><div id="p"><i></i></div></div></div>
<script>
const q=new URLSearchParams(location.search),$=(i)=>document.getElementById(i),w=$('w');
if(q.get('cover')==='0')$('c').style.display='none';
if(q.get('lyrics')==='0'){$('l').style.display='none';$('n').style.display='none'}
if(q.get('next')==='0')$('n').style.display='none';
if(q.get('progress')==='0')$('p').style.display='none';
if(q.get('align'))w.classList.add(q.get('align'));
if(q.get('scale'))document.documentElement.style.setProperty('--s',q.get('scale'));
if(q.get('accent'))document.documentElement.style.setProperty('--acc',q.get('accent'));
let now=null,base=0,at=0;
function setLine(l,n){const el=$('l');const tx=(l&&l.text)||'';if(el.textContent!==tx){el.style.opacity=0;setTimeout(()=>{el.textContent=tx;el.style.opacity=1},180)}$('n').textContent=(n&&n.text)||''}
function apply(n){now=n;base=n.pos||0;at=performance.now();
 if(!n.track){w.classList.remove('on');return}
 w.classList.add('on');w.classList.toggle('paused',n.state!=='playing');
 $('t').textContent=n.track.title;$('a').textContent=n.track.artist+(n.track.album?' · '+n.track.album:'');
 const src='/v1/cover/'+n.track.album_id+'?size=300';if($('c').dataset.src!==src){$('c').dataset.src=src;$('c').src=src}
 if(n.lyrics)setLine(n.lyrics.line,n.lyrics.next)}
const es=new EventSource('/v1/events');
['hello','track','state'].forEach(k=>es.addEventListener(k,e=>apply(JSON.parse(e.data))));
es.addEventListener('line',e=>{const d=JSON.parse(e.data);setLine(d.line,d.next)});
es.addEventListener('pos',e=>{const d=JSON.parse(e.data);base=d.pos;at=performance.now()});
es.addEventListener('lyrics',e=>{const d=JSON.parse(e.data);if(d.kind!=='synced')setLine(null,null)});
(function loop(){if(now&&now.track&&now.dur>0){const p=now.state==='playing'?base+(performance.now()-at)/1000:base;$('p').firstChild.style.width=Math.min(100,p/now.dur*100)+'%'}requestAnimationFrame(loop)})();
</script></body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_and_ws_accept() {
        let hex: String = sha1(b"abc").iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(ws_accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }
    #[test]
    fn base64_roundtrip() {
        for s in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(b64_decode(&b64(s)).unwrap(), s);
        }
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64_decode("data:image/jpeg;base64,Zm9v").unwrap(), b"foo");
    }
    #[test]
    fn lines_and_templates() {
        let l = Lyr { kind: "synced".into(), source: "LRCLIB".into(), lines: vec![LyrLine { t: 1.0, text: "a".into() }, LyrLine { t: 5.0, text: "b".into() }] };
        assert_eq!(line_at(&l.lines, 0.5), None);
        assert_eq!(line_at(&l.lines, 1.0), Some(0));
        assert_eq!(line_at(&l.lines, 4.99), Some(1)); // 50 ms lead
        assert_eq!(line_at(&l.lines, 100.0), Some(1));
        assert_eq!(line_json(&l, Some(0), 10.0)["end"], 5.0);
        assert_eq!(line_json(&l, Some(1), 10.0)["end"], 10.0);
        let now = json!({ "state": "playing", "pos": 65.0, "dur": 200.0, "track": { "title": "T", "artist": "A", "year": 0 }, "lyrics": { "line": { "text": "x" }, "next": null } });
        assert_eq!(fill("{artist} — {title} [{pos}/{dur}] {line}|{next}|{year}", &now), "A — T [1:05/3:20] x||");
    }
    #[test]
    fn query_and_origin() {
        assert_eq!(pct_decode("%D0%9A%D0%B8%D0%BD%D0%BE+x"), "Кино x");
        assert_eq!(pct_decode("100%"), "100%");
        assert_eq!(pct_decode("%4"), "%4");
        assert!(origin_local("http://localhost:3000"));
        assert!(origin_local("null"));
        assert!(!origin_local("https://evil.example"));
        assert!(!origin_local("http://localhost.evil.example"));
        assert!(ct_eq(b"abc", b"abc") && !ct_eq(b"abc", b"abd") && !ct_eq(b"ab", b"abc"));
    }

    struct Fake(Mutex<Snap>);
    impl Host for Fake {
        fn snapshot(&self) -> Option<Snap> { Some(self.0.lock().clone()) }
        fn lyrics(&self, _: i64) -> Option<Lyr> { Some(Lyr { kind: "synced".into(), source: "test".into(), lines: vec![LyrLine { t: 0.0, text: "one".into() }, LyrLine { t: 2.0, text: "two".into() }] }) }
        fn cover(&self, _: i64, _: u32) -> Option<Vec<u8>> { None }
        fn queue(&self, _: usize) -> Value { json!({ "index": 0, "items": [] }) }
        fn control(&self, cmd: &str, _: &Value) -> Result<Value, String> { if cmd == "toggle" { Ok(json!({ "ok": true })) } else { Err("unknown".into()) } }
        fn version(&self) -> String { "test".into() }
        fn data_dir(&self) -> PathBuf { std::env::temp_dir().join("teto-api-test") }
    }

    fn get(port: u16, path: &str, extra: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn server_end_to_end() {
        let port = 17710 + (std::process::id() % 1000) as u16;
        let track = TrackInfo { id: 7, title: "Группа крови".into(), artist: "Кино".into(), album: "Группа крови".into(), album_id: 3, dur: 285.0, ..Default::default() };
        let host = Arc::new(Fake(Mutex::new(Snap { track: Some(track), playing: true, pos: 2.5, repeat: "off".into(), queue_len: 1, ..Default::default() })));
        let hub = Hub::new(host.clone());
        hub.set_cfg(ApiCfg { enabled: true, port, control: true, token: "secret".into(), pipe: false, ..Default::default() });
        std::thread::sleep(Duration::from_millis(400));
        let r = get(port, "/v1/now", "");
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        let body: Value = serde_json::from_str(r.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["track"]["artist"], "Кино");
        assert_eq!(body["state"], "playing");
        assert_eq!(body["lyrics"]["line"]["text"], "two");
        let r = get(port, "/v1/now.txt?fmt=%7Bartist%7D%20-%20%7Btitle%7D", "");
        assert!(r.ends_with("Кино - Группа крови"), "{r}");
        // foreign sites are refused, local pages are fine
        assert!(get(port, "/v1/now", "Origin: https://evil.example\r\n").starts_with("HTTP/1.1 403"));
        assert!(get(port, "/v1/now", "Origin: http://localhost:5173\r\n").starts_with("HTTP/1.1 200"));
        // DNS rebinding
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET /v1/now HTTP/1.1\r\nHost: evil.example\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 403"));
        // control needs the token
        let post = |tok: &str| {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "POST /v1/control/toggle HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {tok}\r\nContent-Length: 0\r\n\r\n").unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        };
        assert!(post("wrong").starts_with("HTTP/1.1 401"));
        assert!(post("secret").starts_with("HTTP/1.1 200"));
        // SSE: hello first, then a line change
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET /v1/events?pos=0 HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").unwrap();
        s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut r = BufReader::new(s);
        let mut seen = String::new();
        for _ in 0..12 {
            let mut l = String::new();
            if r.read_line(&mut l).unwrap_or(0) == 0 { break; }
            seen.push_str(&l);
            if seen.contains("event: hello") { break; }
        }
        assert!(seen.contains("text/event-stream") && seen.contains("event: hello"), "{seen}");
        host.0.lock().pos = 0.5; // seek back → line "one"
        let mut got = false;
        for _ in 0..40 {
            let mut l = String::new();
            if r.read_line(&mut l).unwrap_or(0) == 0 { break; }
            if l.contains("\"text\":\"one\"") { got = true; break; }
        }
        assert!(got, "line event after seek");
        // WebSocket handshake
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET /v1/ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").unwrap();
        s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut buf = [0u8; 4096];
        let n = s.read(&mut buf).unwrap();
        let txt = String::from_utf8_lossy(&buf[..n]);
        assert!(txt.contains("101 Switching Protocols") && txt.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "{txt}");
        hub.set_cfg(ApiCfg { enabled: false, ..Default::default() });
    }
}
