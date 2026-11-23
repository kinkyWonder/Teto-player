//! Tauri shell: commands, events, cover protocol, SMTC, tray, session restore.
use crate::audio::{Event, Player, Repeat};
use crate::db::{Album, Artist, Db, Playlist, Stats, Track};
use crate::lyrics::{self, Lyrics, NetErr};
use crate::scan::{Scanner, Status};
use crate::discord::Rpc;
use crate::{covers, dsp, paths, prio, tags};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

type R<T> = Result<T, String>;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Button {
    pub label: String,
    pub url: String,
}
impl Default for Button {
    fn default() -> Self {
        Button { label: String::new(), url: String::new() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct DiscordCfg {
    pub enabled: bool,
    pub client_id: String,
    pub details: String,
    pub state: String,
    pub large_text: String,
    /// "itunes" | "asset" | "none"
    pub large_image: String,
    pub asset_key: String,
    /// small icon: "state" (asset keys play/pause) | "none"
    pub small: String,
    pub play_key: String,
    pub pause_key: String,
    /// "progress" | "elapsed" | "none"
    pub timestamps: String,
    /// "show" | "clear"
    pub paused: String,
    /// 0 = app name, 1 = state (artist), 2 = details (title) — shown in the member list
    pub status_display: u8,
    pub buttons: Vec<Button>,
    /// clear after N minutes of pause (0 = never)
    pub idle_min: u32,
}
impl Default for DiscordCfg {
    fn default() -> Self {
        DiscordCfg {
            enabled: false,
            client_id: String::new(),
            details: "{title}".into(),
            state: "{artist}".into(),
            large_text: "{album} · {year}".into(),
            large_image: "itunes".into(),
            asset_key: "logo".into(),
            small: "state".into(),
            play_key: "play".into(),
            pause_key: "pause".into(),
            timestamps: "progress".into(),
            paused: "show".into(),
            status_display: 1,
            buttons: vec![],
            idle_min: 10,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub offline: bool,
    pub replaygain: String,
    pub eq_on: bool,
    pub eq: Vec<f32>,
    pub eq_preset: String,
    pub device: String,
    pub show_np: bool,
    // look & feel (applied by the UI)
    pub theme: String,
    pub anim: String, // "full" | "reduced" | "off"
    pub anim_speed: f32,
    pub glow: bool,
    pub blur: bool,
    pub ui_scale: f32,
    pub lyrics_size: f32,
    pub visualizer: bool,
    pub cover_quality: String, // "high" | "fast"
    pub gpu: bool,             // hardware acceleration (applies after restart)
    // system
    pub close_to_tray: bool,
    pub start_minimized: bool,
    pub autostart: bool,
    pub low_power_tray: bool,
    pub resume_on_start: bool,
    pub remember_pos: bool,
    // playback transitions
    pub xf_mode: u8,
    pub xf_ms: u32,
    pub xf_keep_album: bool,
    pub fade_ms: u32,
    pub skip_fade: bool,
    // covers / analysis
    pub auto_gen: bool,
    pub bg_analysis: bool,
    /// look up genres of untagged albums on the internet (iTunes / Deezer)
    pub web_genres: bool,
    // safety
    pub write_protect: bool,
    pub discord: DiscordCfg,
    /// «Трансляция для других программ»: local HTTP / SSE / WebSocket / pipe / files (crate::nowplaying)
    pub api: crate::nowplaying::ApiCfg,
}
impl Default for Settings {
    fn default() -> Self {
        Settings {
            offline: false,
            replaygain: "track".into(),
            eq_on: false,
            eq: vec![0.0; 10],
            eq_preset: "Flat".into(),
            device: String::new(),
            show_np: true,
            theme: "tide".into(),
            anim: "full".into(),
            anim_speed: 1.0,
            glow: true,
            blur: true,
            ui_scale: 1.0,
            lyrics_size: 1.0,
            visualizer: true,
            cover_quality: "high".into(),
            gpu: true,
            close_to_tray: true,
            start_minimized: false,
            autostart: false,
            low_power_tray: true,
            resume_on_start: false,
            remember_pos: true,
            xf_mode: 0,
            xf_ms: 6000,
            xf_keep_album: true,
            fade_ms: 150,
            skip_fade: true,
            auto_gen: true,
            bg_analysis: false,
            web_genres: true,
            write_protect: false,
            discord: DiscordCfg::default(),
            api: crate::nowplaying::ApiCfg::default(),
        }
    }
}

type Job = Box<dyn FnOnce() + Send>;

#[derive(Serialize, Clone)]
struct PlayerState {
    track: Option<Track>,
    playing: bool,
    pos: f64,
    dur: f64,
    volume: f32,
    muted: bool,
    shuffle: bool,
    repeat: Repeat,
    queue: Vec<i64>,
    index: usize,
    output: String,
    error: Option<String>,
}

pub struct App {
    db: Arc<Db>,
    player: OnceLock<Arc<Player>>,
    scanner: OnceLock<Arc<Scanner>>,
    settings: Mutex<Settings>,
    handle: OnceLock<AppHandle>,
    error: Mutex<Option<String>>,
    smtc: OnceLock<crossbeam_channel::Sender<SmtcMsg>>,
    last_track: AtomicI64,
    hidden: AtomicBool,
    rpc: Rpc,
    /// single background-priority worker for analysis / heavy one-off jobs
    worker: crossbeam_channel::Sender<Job>,
    art: Mutex<HashMap<i64, Option<String>>>,
    paused_at: Mutex<Option<std::time::Instant>>,
    listen: crate::listen::Listen,
    /// now-playing API for other programs (docs/API.md)
    api: OnceLock<Arc<crate::nowplaying::Hub>>,
}

impl App {
    fn player(&self) -> &Arc<Player> {
        self.player.get().expect("player")
    }
    fn emit<S: Serialize + Clone>(&self, ev: &str, payload: S) {
        if let Some(h) = self.handle.get() {
            let _ = h.emit(ev, payload);
        }
    }
    fn state(&self) -> PlayerState {
        let p = self.player();
        let q = p.queue.lock();
        let ids: Vec<i64> = q.items.iter().map(|x| x.id).collect();
        let index = q.play_idx;
        let repeat = q.repeat;
        let shuffle = q.orig.is_some();
        drop(q);
        let tid = p.current_track().or_else(|| ids.get(index).copied());
        let track = tid.and_then(|id| self.db.track(id));
        let output = track.as_ref().map(fmt_format).unwrap_or_default();
        PlayerState {
            dur: track.as_ref().map(|t| t.dur).unwrap_or(0.0),
            track,
            playing: p.is_playing(),
            pos: p.position(),
            volume: p.volume(),
            muted: p.muted(),
            shuffle,
            repeat,
            queue: ids,
            index,
            output,
            error: self.error.lock().clone(),
        }
    }
    fn push_state(&self) {
        if let Some(h) = self.api.get() {
            h.kick();
        }
        let st = self.state();
        self.smtc_update(&st);
        self.discord_update(&st);
        if !self.hidden.load(Ordering::Relaxed) {
            self.emit("player:state", st);
        }
    }

    fn run_bg<T: Send + 'static>(&self, f: impl FnOnce() -> T + Send + 'static) -> crossbeam_channel::Receiver<T> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        let _ = self.worker.send(Box::new(move || {
            let _ = tx.send(f());
        }));
        rx
    }

    // ---- Discord Rich Presence ----
    fn discord_update(&self, st: &PlayerState) {
        let cfg = self.settings.lock().discord.clone();
        if !cfg.enabled {
            return;
        }
        {
            let mut pa = self.paused_at.lock();
            if st.playing {
                *pa = None;
            } else if pa.is_none() {
                *pa = Some(std::time::Instant::now());
            }
        }
        let act = self.discord_activity(&cfg, st);
        self.rpc.set(&cfg.client_id, act);
    }

    fn discord_activity(&self, cfg: &DiscordCfg, st: &PlayerState) -> Option<Value> {
        let t = st.track.as_ref()?;
        if !st.playing {
            if cfg.paused == "clear" {
                return None;
            }
            if cfg.idle_min > 0 {
                if let Some(at) = *self.paused_at.lock() {
                    if at.elapsed().as_secs() >= cfg.idle_min as u64 * 60 {
                        return None;
                    }
                }
            }
        }
        let fill = |tpl: &str| -> String {
            let s = tpl
                .replace("{title}", &t.title)
                .replace("{artist}", &t.artist)
                .replace("{album}", &t.album)
                .replace("{year}", &if t.year > 0 { t.year.to_string() } else { String::new() })
                .replace("{genre}", &t.genre)
                .replace("{format}", &st.output)
                .replace("{codec}", &t.codec);
            let s = s.trim().trim_end_matches(" ·").trim_start_matches("· ").trim().to_string();
            // Discord requires 2..=128 chars
            let mut s: String = s.chars().take(128).collect();
            if s.chars().count() == 1 {
                s.push(' ');
            }
            s
        };
        let mut a = serde_json::Map::new();
        a.insert("type".into(), json!(2));
        a.insert("status_display_type".into(), json!(cfg.status_display.min(2)));
        let d = fill(&cfg.details);
        if !d.is_empty() {
            a.insert("details".into(), json!(d));
        }
        let mut stt = fill(&cfg.state);
        if !st.playing {
            stt = if stt.is_empty() { "На паузе".into() } else { format!("⏸ {stt}").chars().take(128).collect() };
        }
        if !stt.is_empty() {
            a.insert("state".into(), json!(stt));
        }
        if st.playing && cfg.timestamps != "none" {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
            let start = now - (st.pos * 1000.0) as i64;
            let mut ts = json!({ "start": start });
            if cfg.timestamps == "progress" && st.dur > 0.0 {
                ts["end"] = json!(start + (st.dur * 1000.0) as i64);
            }
            a.insert("timestamps".into(), ts);
        }
        let mut assets = serde_json::Map::new();
        let large = match cfg.large_image.as_str() {
            "itunes" => self.cover_art_url(t.album_id).or_else(|| (!cfg.asset_key.is_empty()).then(|| cfg.asset_key.clone())),
            "asset" => (!cfg.asset_key.is_empty()).then(|| cfg.asset_key.clone()),
            _ => None,
        };
        if let Some(l) = large {
            assets.insert("large_image".into(), json!(l));
            let lt = fill(&cfg.large_text);
            if !lt.is_empty() {
                assets.insert("large_text".into(), json!(lt));
            }
        }
        if cfg.small == "state" {
            let k = if st.playing { &cfg.play_key } else { &cfg.pause_key };
            if !k.is_empty() {
                assets.insert("small_image".into(), json!(k));
                assets.insert("small_text".into(), json!(if st.playing { "Играет" } else { "Пауза" }));
            }
        }
        if !assets.is_empty() {
            a.insert("assets".into(), Value::Object(assets));
        }
        let buttons: Vec<Value> = cfg
            .buttons
            .iter()
            .filter(|b| !b.label.trim().is_empty() && (b.url.starts_with("https://") || b.url.starts_with("http://")))
            .take(2)
            .map(|b| json!({ "label": fill(&b.label).chars().take(32).collect::<String>(), "url": fill_url(&b.url, t) }))
            .collect();
        if !buttons.is_empty() {
            a.insert("buttons".into(), json!(buttons));
        }
        Some(Value::Object(a))
    }

    /// Public album-art URL (Apple iTunes Search) for Discord; cached, off the hot path, respects offline mode.
    fn cover_art_url(&self, album_id: i64) -> Option<String> {
        if let Some(v) = self.art.lock().get(&album_id) {
            return v.clone();
        }
        if self.settings.lock().offline {
            return None;
        }
        let key = format!("art:{album_id}");
        if let Some(v) = self.db.kv_get(&key) {
            let v = (!v.is_empty()).then_some(v);
            self.art.lock().insert(album_id, v.clone());
            return v;
        }
        // resolve in the background, presence is refreshed when done
        self.art.lock().insert(album_id, None);
        let al = self.db.album(album_id)?;
        let db = self.db.clone();
        let me = self.handle.get().cloned();
        let _ = self.worker.send(Box::new(move || {
            let term = format!("{} {}", al.artist, al.title);
            let url = lyrics::agent()
                .get("https://itunes.apple.com/search")
                .query("term", &term)
                .query("entity", "album")
                .query("limit", "3")
                .call()
                .ok()
                .and_then(|r| r.into_json::<Value>().ok())
                .and_then(|v| {
                    let res = v["results"].as_array()?.clone();
                    let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
                    let want = norm(&al.title);
                    let pick = res.iter().find(|x| norm(x["collectionName"].as_str().unwrap_or("")).starts_with(&want)).or(res.first())?;
                    pick["artworkUrl100"].as_str().map(|u| u.replace("100x100bb", "512x512bb"))
                });
            db.kv_set(&key, url.as_deref().unwrap_or(""));
            if let Some(h) = me {
                if let Some(a) = h.try_state::<Arc<App>>() {
                    a.art.lock().insert(album_id, url);
                    a.push_state();
                }
            }
        }));
        None
    }

    fn set_hidden(&self, hidden: bool) {
        self.hidden.store(hidden, Ordering::SeqCst);
        let low = self.settings.lock().low_power_tray;
        if let Some(w) = self.handle.get().and_then(|h| h.get_webview_window("main")) {
            if low {
                webview_power(&w, hidden);
            }
        }
        if !hidden {
            self.emit("app:shown", ());
            self.push_state();
        }
    }
    fn save_session(&self) {
        self.listen.flush(&self.db);
        let Some(p) = self.player.get() else { return };
        let q = p.queue.lock();
        let v = json!({
            "queue": q.items.iter().map(|x| x.id).collect::<Vec<_>>(),
            "orig": q.orig.as_ref().map(|o| o.iter().map(|x| x.id).collect::<Vec<_>>()),
            "index": q.play_idx,
            "repeat": q.repeat,
            "pos": if self.settings.lock().remember_pos { p.position() } else { 0.0 },
            "volume": p.volume(),
            "muted": p.muted(),
        });
        drop(q);
        self.db.kv_set("session", &v.to_string());
    }
    fn restore_session(&self) {
        let Some(s) = self.db.kv_get("session").and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { return };
        let p = self.player();
        if let Some(v) = s["volume"].as_f64() {
            p.set_volume(v as f32);
        }
        p.set_muted(s["muted"].as_bool().unwrap_or(false));
        let ids: Vec<i64> = serde_json::from_value(s["queue"].clone()).unwrap_or_default();
        let items = self.db.play_items(&ids);
        if items.is_empty() {
            return;
        }
        let idx = s["index"].as_u64().unwrap_or(0) as usize;
        let pos = s["pos"].as_f64().unwrap_or(0.0);
        let autoplay = self.settings.lock().resume_on_start;
        p.load(items, idx, pos, autoplay, false);
        if let Ok(r) = serde_json::from_value::<Repeat>(s["repeat"].clone()) {
            p.queue.lock().repeat = r;
        }
        if let Ok(o) = serde_json::from_value::<Vec<i64>>(s["orig"].clone()) {
            p.queue.lock().orig = Some(self.db.play_items(&o));
        }
    }
    fn apply_settings(&self, s: &Settings, old: Option<&Settings>) {
        let p = self.player();
        p.sh.rg_mode.store(match s.replaygain.as_str() { "off" => 0, "album" => 2, _ => 1 }, Ordering::SeqCst);
        let mut b = [0f32; 10];
        for (i, x) in s.eq.iter().take(10).enumerate() {
            b[i] = x.clamp(-12.0, 12.0);
        }
        p.set_eq(false, b); // equalizer removed in 1.8.0 — always bypassed
        p.sh.xf_mode.store(s.xf_mode.min(4), Ordering::SeqCst);
        p.sh.xf_ms.store(s.xf_ms.clamp(500, 15000), Ordering::SeqCst);
        p.sh.xf_keep_album.store(s.xf_keep_album, Ordering::SeqCst);
        p.sh.fade_ms.store(s.fade_ms.clamp(5, 2000), Ordering::SeqCst);
        p.sh.skip_fade.store(s.skip_fade, Ordering::SeqCst);
        if let Some(o) = old {
            if o.device != s.device {
                p.set_device(s.device.clone());
            }
            if o.autostart != s.autostart {
                set_autostart(s.autostart);
            }
        }
        if let Some(h) = self.api.get() {
            if old.map(|o| o.api != s.api).unwrap_or(true) {
                h.set_cfg(s.api.clone());
            }
        }
        if !s.discord.enabled {
            self.rpc.stop();
        } else if old.map(|o| o.discord != s.discord).unwrap_or(true) {
            // settings struct is already stored by the caller for the update below
        }
    }

    fn on_player_event(self: &Arc<Self>, e: Event) {
        match e {
            Event::Track { qidx, track_id } => {
                *self.error.lock() = None;
                if self.last_track.swap(track_id, Ordering::SeqCst) != track_id {
                    self.db.mark_played(track_id);
                }
                let dur = self.db.track(track_id).map(|t| t.dur).unwrap_or(0.0);
                self.listen.track(&self.db, track_id, dur);
                self.push_state();
                // prefetch lyrics for the next item
                let next = self.player().queue.lock().items.get(qidx + 1).map(|x| x.id);
                if let Some(n) = next {
                    let me = self.clone();
                    std::thread::spawn(move || {
                        let _ = me.resolve_lyrics(n);
                    });
                }
            }
            Event::Pos(p) => {
                self.listen.pos(&self.db, p);
                if !self.hidden.load(Ordering::Relaxed) {
                    self.emit("player:pos", json!({ "pos": p }));
                }
                static N: AtomicI64 = AtomicI64::new(0);
                if N.fetch_add(1, Ordering::Relaxed) % 20 == 0 {
                    self.save_session();
                    self.smtc_progress(p);
                }
            }
            Event::Ended => self.push_state(),
            Event::Error { track_id, msg, missing } => {
                if missing {
                    self.db.set_missing(track_id, true);
                }
                let name = self.db.track(track_id).map(|t| t.title).unwrap_or_default();
                let m = format!("{msg}: {name}");
                *self.error.lock() = Some(m.clone());
                self.emit("player:error", m);
                self.emit("library", ());
            }
        }
    }

    fn resolve_lyrics(&self, id: i64) -> Lyrics {
        let Some(t) = self.db.track(id) else { return Lyrics::none() };
        let path = Path::new(&t.path);
        if let Some(s) = tags::lyrics(path) {
            let l = Lyrics::from_text(&s, "Из тегов");
            if l.kind != "none" {
                return l;
            }
        }
        if let Some((s, label)) = lyrics::sidecar(path) {
            let l = Lyrics::from_text(&s, label);
            if l.kind != "none" {
                return l;
            }
        }
        let key = lyrics::cache_key(&t.artist, &t.title, &t.album, t.dur);
        if let Some(l) = lyrics::cache_get(&key) {
            return l;
        }
        if self.settings.lock().offline {
            return Lyrics::none();
        }
        match lyrics::lrclib_get(&t.artist, &t.title, &t.album, t.dur) {
            Ok(l) => {
                lyrics::cache_put(&key, &l);
                l
            }
            Err(NetErr::NotFound) => {
                let l = Lyrics::none();
                lyrics::cache_put(&key, &l);
                l
            }
            Err(NetErr::Network(e)) => Lyrics::error(e),
        }
    }

    // ---- SMTC (Windows media overlay / media keys) ----
    fn smtc_update(&self, st: &PlayerState) {
        let Some(tx) = self.smtc.get() else { return };
        if let Some(t) = &st.track {
            let album = self.db.album(t.album_id);
            let generated = album.as_ref().map(|a| a.recipe.is_some() || a.cover.is_none()).unwrap_or(true);
            let cover = covers::thumb_file(&self.db, t.album_id, generated).map(|p| format!("file:///{}", p.to_string_lossy().replace('\\', "/")));
            let _ = tx.send(SmtcMsg::Meta { title: t.title.clone(), artist: t.artist.clone(), album: t.album.clone(), cover, dur: t.dur });
        }
        let _ = tx.send(SmtcMsg::State { playing: st.playing, pos: st.pos, has: st.track.is_some() });
    }
    fn smtc_progress(&self, pos: f64) {
        if let Some(tx) = self.smtc.get() {
            let _ = tx.send(SmtcMsg::State { playing: self.player().is_playing(), pos, has: true });
        }
    }
}

enum SmtcMsg {
    Meta { title: String, artist: String, album: String, cover: Option<String>, dur: f64 },
    State { playing: bool, pos: f64, has: bool },
}

fn start_smtc(app: &Arc<App>, hwnd: Option<isize>) {
    use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig};
    let (tx, rx) = crossbeam_channel::unbounded::<SmtcMsg>();
    let _ = app.smtc.set(tx);
    let me = app.clone();
    std::thread::Builder::new()
        .name("teto-smtc".into())
        .spawn(move || {
            let cfg = PlatformConfig { dbus_name: "teto_player", display_name: "Teto Player", hwnd: hwnd.map(|h| h as *mut std::ffi::c_void) };
            let Ok(mut mc) = MediaControls::new(cfg) else { return };
            let pl = me.clone();
            let _ = mc.attach(move |e: MediaControlEvent| {
                let p = pl.player();
                match e {
                    MediaControlEvent::Play => p.play(),
                    MediaControlEvent::Pause => p.pause(),
                    MediaControlEvent::Toggle => p.toggle(),
                    MediaControlEvent::Next => p.next(),
                    MediaControlEvent::Previous => p.prev(),
                    MediaControlEvent::Stop => p.pause(),
                    MediaControlEvent::SetPosition(MediaPosition(d)) => p.seek(d.as_secs_f64()),
                    _ => {}
                }
                pl.push_state();
            });
            let mut last_meta = String::new();
            while let Ok(m) = rx.recv() {
                match m {
                    SmtcMsg::Meta { title, artist, album, cover, dur } => {
                        let key = format!("{title}|{artist}|{album}|{cover:?}");
                        if key != last_meta {
                            last_meta = key;
                            let _ = mc.set_metadata(MediaMetadata {
                                title: Some(&title),
                                artist: Some(&artist),
                                album: Some(&album),
                                cover_url: cover.as_deref(),
                                duration: Some(std::time::Duration::from_secs_f64(dur.max(0.0))),
                            });
                        }
                    }
                    SmtcMsg::State { playing, pos, has } => {
                        let progress = Some(MediaPosition(std::time::Duration::from_secs_f64(pos.max(0.0))));
                        let _ = mc.set_playback(if !has { MediaPlayback::Stopped } else if playing { MediaPlayback::Playing { progress } } else { MediaPlayback::Paused { progress } });
                    }
                }
            }
        })
        .ok();
}

fn fmt_format(t: &Track) -> String {
    let rate = |r: u32| {
        let k = r as f64 / 1000.0;
        if k.fract() == 0.0 { format!("{}", k as u32) } else { format!("{}", k.floor() as u32) }
    };
    if t.lossless && t.bits > 0 {
        format!("{} {}/{}", t.codec, t.bits, rate(t.rate))
    } else if t.kbps > 0 {
        format!("{} {}", t.codec, t.kbps)
    } else {
        t.codec.clone()
    }
}

// ------------------------------ commands ------------------------------
type S<'a> = State<'a, Arc<App>>;

#[tauri::command]
fn stats(a: S) -> Stats {
    a.db.stats()
}
#[tauri::command]
fn albums(a: S, sort: String) -> Vec<Album> {
    a.db.albums(&sort)
}
#[tauri::command]
fn recent_albums(a: S) -> Vec<Album> {
    a.db.recent_albums()
}
#[tauri::command]
fn album(a: S, id: i64) -> Option<Album> {
    a.db.album(id)
}
#[tauri::command]
fn album_tracks(a: S, id: i64) -> Vec<Track> {
    a.db.album_tracks(id)
}
#[tauri::command]
fn artists(a: S) -> Vec<Artist> {
    a.db.artists()
}
#[tauri::command]
fn artist_albums(a: S, name: String) -> Vec<Album> {
    a.db.artist_albums(&name)
}
#[tauri::command]
fn tracks(a: S, sort: String) -> Vec<Track> {
    a.db.tracks(&sort)
}
#[tauri::command]
fn favorites(a: S) -> Vec<Track> {
    a.db.favorites()
}
#[tauri::command]
fn search(a: S, q: String) -> Value {
    let (mut t, al, ar) = a.db.search(&q);
    t.sort_by_key(|x| !x.fav); // favourites first, then the rest of the library (stable)
    json!({ "tracks": t, "albums": al, "artists": ar })
}
/// "Hints": the full track list of an album (iTunes Search API), to show songs that are not in the library.
#[tauri::command]
async fn album_tracklist(artist: String, album: String) -> Option<Value> {
    tauri::async_runtime::spawn_blocking(move || crate::webgenre::tracklist(&lyrics::agent(), &artist, &album))
        .await
        .ok()
        .flatten()
}
/// Opens a web page in the default browser ("Download" buttons of the hints).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("bad url".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(&url)
            .creation_flags(NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
/// "Download": YouTube Music search through yt-dlp (the best match is picked in the UI, src/core/ytmusic.ts).
#[tauri::command]
async fn yt_search(q: String, browser: Option<String>) -> R<Vec<Value>> {
    tauri::async_runtime::spawn_blocking(move || crate::ytmusic::search(&q, browser.as_deref().unwrap_or(""))).await.map_err(|e| e.to_string())?
}
/// "Download": saves the audio into <Music>/Teto Downloads (added to the library folders) and rescans.
/// Like on the phone: progress ("dl" events), ✕ (`dl_cancel`), names + a square cover written into the file.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn yt_download(
    a: S<'_>, id: Option<String>, url: String, artist: String, title: String, browser: Option<String>, thumb: Option<String>, song_album: Option<String>,
    album: Option<String>, album_artist: Option<String>, no: Option<u32>, disc: Option<u32>, year: Option<u32>,
) -> R<Value> {
    let app = a.inner().clone();
    let id = id.filter(|x| !x.is_empty()).unwrap_or_else(|| format!("dl{}", fastrand::u64(..)));
    let r = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let last = Mutex::new(-1i32);
        let (app2, id2) = (app.clone(), id.clone());
        let progress = move |f: f64| {
            let pc = (f * 100.0) as i32;
            let mut l = last.lock();
            if pc != *l {
                *l = pc;
                app2.emit("dl", json!({ "id": id2, "state": "running", "progress": f, "message": format!("{pc}%") }));
            }
        };
        let d = crate::ytmusic::download(&url, &artist, &title, browser.as_deref().unwrap_or(""), &id, &progress)?;
        let title = if title.is_empty() { d.title.clone() } else { title.clone() };
        let artist = if artist.is_empty() { d.artist.clone() } else { artist.clone() };
        app.emit("dl", json!({ "id": id, "state": "running", "progress": 1.0, "message": "Обложка и теги…", "title": title, "artist": artist }));
        let cover = if app.settings.lock().offline { None } else { crate::ytmusic::square_cover(thumb.as_deref().unwrap_or(""), &url) };
        let song_album = song_album.filter(|s| !s.trim().is_empty()).unwrap_or(d.album.clone());
        let _ = tags::write_download(&d.path, &title, &artist, &song_album, cover.as_deref());
        // from an album page: the song goes straight into that album (best effort — a tag error keeps the file)
        if let Some(al) = album.as_deref().filter(|s| !s.trim().is_empty()) {
            let _ = crate::tags::write_album(&d.path, &title, &artist, al, album_artist.as_deref().unwrap_or(""), no.unwrap_or(0), disc.unwrap_or(0), year.unwrap_or(0));
        }
        Ok(json!({ "path": d.path.to_string_lossy(), "title": title, "artist": artist }))
    })
    .await
    .map_err(|e| e.to_string())??;
    let dir = crate::ytmusic::downloads_dir().to_string_lossy().into_owned();
    let sc = a.scanner.get().unwrap();
    if !a.db.folders().iter().any(|f| f == &dir) {
        a.db.add_folder(&dir)?;
        sc.rewatch();
    }
    sc.start();
    Ok(r)
}
#[tauri::command]
fn dl_cancel(id: String) {
    crate::ytmusic::cancel(&id);
}
/// HTTPS for the desktop UI's fast internet search (src/mobile/backend/online.ts, shared with the phone):
/// YouTube Music / YouTube (InnerTube), SoundCloud api-v2 and Spotify pages. The webview can't call them itself (CORS).
#[tauri::command]
async fn net_http(a: S<'_>, method: String, url: String, headers: Option<HashMap<String, String>>, body: Option<String>) -> R<Value> {
    if a.settings.lock().offline {
        return Err("Офлайн-режим: сеть выключена в настройках".into());
    }
    tauri::async_runtime::spawn_blocking(move || net_http_do(&method, &url, headers.unwrap_or_default(), body)).await.map_err(|e| e.to_string())?
}
const NET_HOSTS: &[&str] = &["music.youtube.com", "www.youtube.com", "youtube.com", "m.youtube.com", "soundcloud.com", "m.soundcloud.com", "api-v2.soundcloud.com", "a-v2.sndcdn.com", "open.spotify.com", "embed.spotify.com"];
fn net_http_do(method: &str, url: &str, headers: HashMap<String, String>, body: Option<String>) -> R<Value> {
    let host = url.strip_prefix("https://").and_then(|r| r.split(['/', '?', '#']).next()).unwrap_or("").to_ascii_lowercase();
    if !NET_HOSTS.contains(&host.as_str()) {
        return Err(format!("адрес не разрешён: {host}"));
    }
    let agent = ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(8)).timeout(std::time::Duration::from_secs(12)).build();
    let mut req = agent.request(if method.eq_ignore_ascii_case("POST") { "POST" } else { "GET" }, url);
    let mut has_ua = false;
    for (k, v) in &headers {
        if k.eq_ignore_ascii_case("user-agent") {
            has_ua = true;
        }
        req = req.set(k, v);
    }
    if !has_ua {
        req = req.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
    }
    let resp = match body {
        Some(b) => req.send_string(&b),
        None => req.call(),
    };
    let r = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(e.to_string()),
    };
    let status = r.status();
    let mut text = String::new();
    use std::io::Read;
    r.into_reader().take(8 << 20).read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(json!({ "status": status, "data": text }))
}
/// Album / track menu → "Replace cover with a picture…" (ported from the phone). `data`: base64 JPEG (centre square).
#[tauri::command]
fn set_custom_cover(a: S, album_id: i64, data: String) -> R<()> {
    let bytes = crate::nowplaying::b64_decode(&data).ok_or("плохая картинка")?;
    image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let p = covers::custom_path(album_id);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&p, &bytes).map_err(|e| e.to_string())?;
    covers::invalidate(album_id);
    let _ = std::fs::remove_file(covers::gen_path(album_id));
    a.db.set_cover_source(album_id, Some("custom"), &p.to_string_lossy(), "");
    a.db.set_recipe(album_id, None, None);
    a.art.lock().remove(&album_id);
    a.emit("library", ());
    a.push_state();
    Ok(())
}
/// "Restore the original cover": forget the picture, look for the file / folder cover again.
#[tauri::command]
fn reset_cover(a: S, album_id: i64) {
    let _ = std::fs::remove_file(covers::custom_path(album_id));
    covers::invalidate(album_id);
    a.db.reset_cover_source(album_id);
    covers::resolve_sources(&a.db);
    a.emit("library", ());
    a.push_state();
}
#[tauri::command]
fn has_custom_cover(album_id: i64) -> bool {
    covers::custom_path(album_id).exists()
}
/// Track menu → "Delete" (ported from the phone): the files go to the Recycle Bin, the songs leave the library.
#[tauri::command]
fn delete_tracks(a: S, track_ids: Vec<i64>) -> R<usize> {
    if a.settings.lock().write_protect {
        return Err("Включена защита файлов от записи (Настройки → Безопасность)".into());
    }
    let p = a.player();
    let cur = p.current_track();
    if cur.map(|c| track_ids.contains(&c)).unwrap_or(false) {
        p.pause();
    }
    let mut gone = Vec::new();
    let mut err = String::new();
    for id in &track_ids {
        let Some(t) = a.db.track(*id) else { continue };
        match recycle(Path::new(&t.path)) {
            Ok(()) => gone.push(*id),
            Err(e) => err = e,
        }
    }
    if gone.is_empty() && !err.is_empty() {
        return Err(err);
    }
    // drop them from the queue (from the end so the indexes stay valid)
    {
        let idx: Vec<usize> = p.queue.lock().items.iter().enumerate().filter(|(_, x)| gone.contains(&x.id)).map(|(i, _)| i).collect();
        let play = p.queue.lock().play_idx;
        for i in idx.into_iter().rev() {
            if i != play {
                p.remove(i);
            }
        }
        if cur.map(|c| gone.contains(&c)).unwrap_or(false) {
            p.next();
        }
    }
    a.db.delete_tracks(&gone)?;
    a.db.rebuild_albums()?;
    a.emit("library", ());
    a.push_state();
    Ok(gone.len())
}
#[cfg(windows)]
fn recycle(path: &Path) -> R<()> {
    #[repr(C)]
    #[allow(non_snake_case)]
    struct SHFILEOPSTRUCTW {
        hwnd: isize,
        wFunc: u32,
        pFrom: *const u16,
        pTo: *const u16,
        fFlags: u16,
        fAnyOperationsAborted: i32,
        hNameMappings: *mut core::ffi::c_void,
        lpszProgressTitle: *const u16,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHFileOperationW(op: *mut SHFILEOPSTRUCTW) -> i32;
    }
    const FO_DELETE: u32 = 3;
    const FOF_SILENT: u16 = 0x4;
    const FOF_NOCONFIRMATION: u16 = 0x10;
    const FOF_ALLOWUNDO: u16 = 0x40;
    const FOF_NOERRORUI: u16 = 0x400;
    use std::os::windows::ffi::OsStrExt;
    let from: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect(); // double-NUL terminated list
    let mut op = SHFILEOPSTRUCTW {
        hwnd: 0,
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    let r = unsafe { SHFileOperationW(&mut op) };
    if r == 0 && op.fAnyOperationsAborted == 0 {
        Ok(())
    } else if !path.exists() {
        Ok(())
    } else {
        Err(format!("не удалось удалить ({r:#x}): {}", path.display()))
    }
}
#[cfg(not(windows))]
fn recycle(path: &Path) -> R<()> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
/// Settings → Playback: how many songs without ReplayGain tags are measured already.
#[tauri::command]
fn level_stats(a: S) -> Value {
    let (done, total) = a.db.loud_stats();
    json!({ "done": done, "total": total })
}
/// Settings → «Трансляция»: is the server running, address, clients.
#[tauri::command]
fn api_status(a: S) -> Value {
    a.api.get().map(|h| h.status()).unwrap_or(Value::Null)
}
/// A new control token (the old one stops working).
#[tauri::command]
fn api_new_token(a: S) -> R<Settings> {
    let mut s = a.settings.lock().clone();
    s.api.token = crate::nowplaying::new_token();
    a.db.kv_set("settings", &serde_json::to_string(&s).unwrap());
    let old = std::mem::replace(&mut *a.settings.lock(), s.clone());
    a.apply_settings(&s, Some(&old));
    Ok(s)
}

/// What the now-playing API reads from the app (crate::nowplaying::Host).
struct ApiHost(std::sync::Weak<App>);
impl crate::nowplaying::Host for ApiHost {
    fn snapshot(&self) -> Option<crate::nowplaying::Snap> {
        let a = self.0.upgrade()?;
        let p = a.player.get()?;
        let q = p.queue.lock();
        let (index, queue_len, repeat, shuffle) = (q.play_idx, q.items.len(), q.repeat, q.orig.is_some());
        let qid = q.items.get(q.play_idx).map(|x| x.id);
        drop(q);
        let track = p.current_track().or(qid).and_then(|id| a.db.track(id)).map(|t| crate::nowplaying::TrackInfo {
            id: t.id,
            format: fmt_format(&t),
            title: t.title,
            artist: t.artist,
            album: t.album,
            album_id: t.album_id,
            year: t.year,
            genre: t.genre,
            dur: t.dur,
            codec: t.codec,
            path: t.path,
        });
        Some(crate::nowplaying::Snap {
            track,
            playing: p.is_playing(),
            pos: p.position(),
            volume: p.volume(),
            muted: p.muted(),
            shuffle,
            repeat: serde_json::to_value(repeat).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
            index,
            queue_len,
        })
    }
    fn lyrics(&self, track_id: i64) -> Option<crate::nowplaying::Lyr> {
        let a = self.0.upgrade()?;
        let l = a.resolve_lyrics(track_id);
        Some(crate::nowplaying::Lyr {
            kind: l.kind,
            source: l.source,
            lines: l.lines.into_iter().map(|x| crate::nowplaying::LyrLine { t: x.t, text: x.text }).collect(),
        })
    }
    fn cover(&self, album_id: i64, size: u32) -> Option<Vec<u8>> {
        let a = self.0.upgrade()?;
        let generated = a.db.album(album_id).map(|al| al.recipe.is_some() || al.cover.is_none()).unwrap_or(true);
        if !generated {
            if let Some(b) = covers::get(&a.db, album_id, size) {
                return Some(b);
            }
        }
        std::fs::read(covers::gen_path(album_id)).ok().or_else(|| covers::get(&a.db, album_id, size))
    }
    fn queue(&self, limit: usize) -> Value {
        let Some(a) = self.0.upgrade() else { return Value::Null };
        let Some(p) = a.player.get() else { return Value::Null };
        let q = p.queue.lock();
        let index = q.play_idx;
        let ids: Vec<i64> = q.items.iter().skip(index).take(limit + 1).map(|x| x.id).collect();
        let total = q.items.len();
        drop(q);
        let items: Vec<Value> = ids
            .iter()
            .enumerate()
            .filter_map(|(i, id)| a.db.track(*id).map(|t| json!({ "index": index + i, "id": t.id, "title": t.title, "artist": t.artist, "album": t.album, "album_id": t.album_id, "dur": t.dur })))
            .collect();
        json!({ "index": index, "length": total, "items": items })
    }
    fn control(&self, cmd: &str, arg: &Value) -> Result<Value, String> {
        let a = self.0.upgrade().ok_or("app")?;
        let p = a.player.get().ok_or("player")?;
        match cmd {
            "play" => p.play(),
            "pause" => p.pause(),
            "toggle" => p.toggle(),
            "next" => p.next(),
            "prev" | "previous" => p.prev(),
            "seek" => p.seek(arg["pos"].as_f64().ok_or("нужно { \"pos\": секунды }")?.max(0.0)),
            "volume" => p.set_volume(arg["v"].as_f64().ok_or("нужно { \"v\": 0…1 }")?.clamp(0.0, 1.0) as f32),
            "mute" => p.set_muted(arg["m"].as_bool().unwrap_or(!p.muted())),
            "shuffle" => {
                let off = p.queue.lock().orig.is_none();
                p.set_shuffle(arg["on"].as_bool().unwrap_or(off));
            }
            "repeat" => p.set_repeat(serde_json::from_value::<Repeat>(arg["mode"].clone()).map_err(|_| "mode: off | all | one")?),
            "download" => {
                let url = arg["url"].as_str().filter(|u| u.starts_with("https://") || u.starts_with("http://") || u.starts_with("spotify:")).ok_or("нужно { \"url\": ссылка }")?;
                a.emit("api_download", json!({ "url": url }));
                return Ok(json!({ "ok": true, "queued": url }));
            }
            _ => return Err(format!("неизвестная команда: {cmd}")),
        }
        a.push_state();
        a.emit("player:state", a.state());
        Ok(json!({ "ok": true }))
    }
    fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
    fn data_dir(&self) -> std::path::PathBuf {
        paths::root().clone()
    }
}
/// Monthly report: the shareable picture, to a path chosen in the save dialog (PNG only).
#[tauri::command]
fn save_png(path: String, data: Vec<u8>) -> R<()> {
    if !path.to_ascii_lowercase().ends_with(".png") || !data.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("png only".into());
    }
    std::fs::write(&path, data).map_err(|e| e.to_string())
}
#[tauri::command]
fn set_fav(a: S, id: i64, fav: bool) {
    a.db.set_fav(id, fav)
}
#[tauri::command]
fn set_album_fav(a: S, id: i64, fav: bool) {
    a.db.set_album_fav(id, fav)
}
#[tauri::command]
fn folders(a: S) -> Vec<String> {
    a.db.folders()
}
#[tauri::command]
fn add_folder(a: S, path: String) -> R<()> {
    a.db.add_folder(&path)?;
    let sc = a.scanner.get().unwrap();
    sc.rewatch();
    sc.start();
    Ok(())
}
#[tauri::command]
fn remove_folder(a: S, path: String) -> R<()> {
    a.db.remove_folder(&path)?;
    a.scanner.get().unwrap().rewatch();
    a.emit("library", ());
    Ok(())
}
#[tauri::command]
fn rescan(a: S) {
    a.scanner.get().unwrap().start();
}
/// Settings → "Reprocess all files": generated covers are drawn again, every file is re-read and its names parsed
/// again, genres are looked up again (internet → sound analysis). Manual renames / covers / tags stay.
#[tauri::command]
fn reprocess(a: S) {
    a.db.reset_derived();
    let _ = std::fs::remove_dir_all(paths::covers());
    let _ = std::fs::create_dir_all(paths::covers());
    a.art.lock().clear();
    a.scanner.get().unwrap().start_full();
    a.emit("library", ());
}
/// Hidden listening statistics for the monthly report (src/report builds the report from these rows).
#[tauri::command]
fn listen_log(a: S, from: String, to: String) -> Vec<Value> {
    a.listen.flush(&a.db);
    crate::listen::log(&a.db, &from, &to)
}
#[tauri::command]
fn listen_first(a: S) -> Option<String> {
    crate::listen::first_day(&a.db)
}
/// Developer mode → reset the listening statistics.
#[tauri::command]
fn listen_reset(a: S) -> R<()> {
    a.listen.clear();
    crate::listen::reset(&a.db)
}
#[tauri::command]
fn scan_status(a: S) -> Status {
    a.scanner.get().unwrap().status.lock().clone()
}
#[tauri::command]
fn playlists(a: S) -> Vec<Playlist> {
    a.db.playlists()
}
#[tauri::command]
fn create_playlist(a: S, name: String) -> R<i64> {
    a.db.create_playlist(&name)
}
#[tauri::command]
fn delete_playlist(a: S, id: i64) {
    a.db.delete_playlist(id)
}
#[tauri::command]
fn rename_playlist(a: S, id: i64, name: String) {
    a.db.rename_playlist(id, &name)
}
#[tauri::command]
fn playlist_tracks(a: S, id: i64) -> Vec<Track> {
    a.db.playlist_tracks(id)
}
#[tauri::command]
fn add_to_playlist(a: S, id: i64, track_ids: Vec<i64>) -> R<()> {
    a.db.add_to_playlist(id, &track_ids)
}
#[tauri::command]
fn remove_from_playlist(a: S, id: i64, track_ids: Vec<i64>) {
    a.db.remove_from_playlist(id, &track_ids)
}

#[tauri::command]
fn play_queue(a: S, track_ids: Vec<i64>, index: usize, shuffle: bool) {
    let items = a.db.play_items(&track_ids);
    // keep index pointing at the same track even if some ids vanished
    let want = track_ids.get(index).copied();
    let idx = want.and_then(|w| items.iter().position(|x| x.id == w)).unwrap_or(0);
    *a.error.lock() = None;
    a.player().load(items, idx, 0.0, true, shuffle);
    a.push_state();
}
/// Smart-shuffled playback: `order` is the mixed order, `track_ids` the original list (restored when shuffle is switched off).
#[tauri::command]
fn play_mix(a: S, track_ids: Vec<i64>, order: Vec<i64>) {
    let orig = a.db.play_items(&track_ids);
    let mixed = a.db.play_items(&order);
    *a.error.lock() = None;
    a.player().load_mixed(orig, mixed);
    a.push_state();
}
// ------------------------------ names (namefix) ------------------------------
#[tauri::command]
fn rename_track(a: S, id: i64, title: Option<String>, artist: Option<String>, album: Option<String>) -> R<()> {
    crate::namefix_db::set_track_names(&a.db, id, title.as_deref(), artist.as_deref(), album.as_deref())?;
    crate::covers::resolve_sources(&a.db);
    a.emit("library", ());
    a.push_state();
    Ok(())
}
#[tauri::command]
fn swap_artist_title(a: S, id: i64) -> R<()> {
    crate::namefix_db::swap_artist_title(&a.db, id)?;
    crate::covers::resolve_sources(&a.db);
    a.emit("library", ());
    a.push_state();
    Ok(())
}
#[tauri::command]
fn rename_artist(a: S, old: String, new: String) -> R<usize> {
    let n = crate::namefix_db::rename_artist(&a.db, &old, &new)?;
    crate::covers::resolve_sources(&a.db);
    a.emit("library", ());
    a.push_state();
    Ok(n)
}
fn artist_file(name: &str) -> std::path::PathBuf {
    let k = crate::namefix::key(name);
    let mut h: u64 = 0xcbf29ce484222325;
    for b in k.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let dir = paths::root().join("artists");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("{h:016x}.jpg"))
}
/// Своё фото исполнителя: JPEG (уже обрезанный в UI) копируется в кэш приложения. None — убрать фото.
#[tauri::command]
fn set_artist_photo(a: S, name: String, jpeg: Option<Vec<u8>>) -> R<()> {
    let f = artist_file(&name);
    match jpeg {
        Some(b) if !b.is_empty() => {
            std::fs::write(&f, b).map_err(|e| e.to_string())?;
            crate::namefix_db::set_artist_photo(&a.db, &name, Some(&f.to_string_lossy()))?;
        }
        _ => {
            let _ = std::fs::remove_file(&f);
            crate::namefix_db::set_artist_photo(&a.db, &name, None)?;
        }
    }
    a.emit("library", ());
    Ok(())
}
/// Имя файла фото в протоколе teto://localhost/artist/<file> (+ версия), если фото задано.
#[tauri::command]
fn artist_photo(a: S, name: String) -> Option<String> {
    let p = crate::namefix_db::artist_photo(&a.db, &name)?;
    let f = std::path::Path::new(&p);
    let v = std::fs::metadata(f).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(format!("{}?v={v}", f.file_name()?.to_string_lossy()))
}
#[tauri::command]
fn names_to_review(a: S) -> Vec<(i64, u8, bool)> {
    crate::namefix_db::needs_review(&a.db)
}
#[tauri::command]
fn album_genres(a: S) -> Vec<(i64, String)> {
    a.db.album_genres()
}
#[tauri::command]
fn enqueue(a: S, track_ids: Vec<i64>, next: bool) {
    a.player().enqueue(a.db.play_items(&track_ids), next);
    a.push_state();
}
#[tauri::command]
fn toggle(a: S) {
    a.player().toggle();
    a.push_state();
    a.save_session();
}
#[tauri::command]
fn next(a: S) {
    a.player().next();
    a.push_state();
}
#[tauri::command]
fn prev(a: S) {
    a.player().prev();
    a.push_state();
}
#[tauri::command]
fn seek(a: S, pos: f64) {
    a.player().seek(pos);
    if !a.player().is_playing() {
        // keep the restored position exact when seeking while paused (after the decoder applied the seek)
        let me = a.inner().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            me.save_session();
        });
    }
}
#[tauri::command]
fn jump(a: S, index: usize) {
    a.player().jump(index);
}
#[tauri::command]
fn remove_from_queue(a: S, index: usize) {
    a.player().remove(index);
    a.push_state();
}
#[tauri::command]
fn set_volume(a: S, v: f32) {
    a.player().set_volume(v);
    a.emit("player:state", a.state());
}
#[tauri::command]
fn set_muted(a: S, m: bool) {
    a.player().set_muted(m);
    a.push_state();
}
#[tauri::command]
fn set_shuffle(a: S, on: bool) {
    a.player().set_shuffle(on);
    a.push_state();
}
#[tauri::command]
fn set_repeat(a: S, mode: Repeat) {
    a.player().set_repeat(mode);
    a.push_state();
}
#[tauri::command]
fn player_state(a: S) -> PlayerState {
    a.state()
}
#[tauri::command]
fn queue_tracks(a: S) -> Vec<Track> {
    let ids: Vec<i64> = a.player().queue.lock().items.iter().map(|x| x.id).collect();
    a.db.tracks_by_ids(&ids)
}
#[tauri::command]
fn levels(a: S) -> Vec<f32> {
    if a.hidden.load(Ordering::Relaxed) {
        return vec![];
    }
    a.player().levels()
}
#[tauri::command]
fn devices() -> Vec<String> {
    Player::devices()
}

#[tauri::command]
async fn lyrics(a: S<'_>, id: i64) -> R<Lyrics> {
    let app = a.inner().clone();
    tauri::async_runtime::spawn_blocking(move || app.resolve_lyrics(id)).await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn lyrics_candidates(a: S<'_>, id: i64) -> R<Vec<Value>> {
    let app = a.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if app.settings.lock().offline {
            return Err("Офлайн-режим: поиск отключён".to_string());
        }
        let t = app.db.track(id).ok_or("нет трека")?;
        let list = lyrics::lrclib_search(&lyrics::normalize_artist(&t.artist), &lyrics::normalize_title(&t.title)).map_err(|e| match e {
            NetErr::Network(s) => s,
            NetErr::NotFound => "не найдено".into(),
        })?;
        Ok(list
            .iter()
            .map(|v| {
                let d = v["duration"].as_f64().unwrap_or(0.0) as u32;
                json!({
                    "id": v["id"],
                    "label": format!("{} — {} · {} · {}:{:02}", v["artistName"].as_str().unwrap_or(""), v["trackName"].as_str().unwrap_or(""), v["albumName"].as_str().unwrap_or(""), d / 60, d % 60),
                    "synced": v["syncedLyrics"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn pick_lyrics(a: S<'_>, id: i64, candidate: i64) -> R<Lyrics> {
    let app = a.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let t = app.db.track(id).ok_or("нет трека")?;
        let l = lyrics::lrclib_by_id(candidate).map_err(|e| match e {
            NetErr::Network(s) => s,
            NetErr::NotFound => "не найдено".into(),
        })?;
        lyrics::cache_put(&lyrics::cache_key(&t.artist, &t.title, &t.album, t.dur), &l);
        if let Some(h) = app.api.get() {
            h.lyrics_changed(id);
        }
        Ok(l)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_lrc(a: S<'_>, id: i64) -> R<String> {
    let app = a.inner().clone();
    if app.settings.lock().write_protect {
        return Err("Включена защита файлов от записи (Настройки → Безопасность)".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let t = app.db.track(id).ok_or("нет трека")?;
        let l = app.resolve_lyrics(id);
        if l.kind == "none" || l.kind == "error" {
            return Err("Текст не найден".to_string());
        }
        let p = Path::new(&t.path).with_extension(if l.kind == "synced" { "lrc" } else { "txt" });
        std::fs::write(&p, lyrics::to_lrc(&l)).map_err(|e| e.to_string())?;
        Ok(p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn analyze_album(a: S<'_>, album_id: i64) -> R<Value> {
    let app = a.inner().clone();
    if let Some(s) = app.db.analysis(album_id).and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        return Ok(s);
    }
    // heavy part runs on the single background-priority worker (low CPU + I/O priority)
    let db = app.db.clone();
    let rx = app.run_bg(move || analyze_now(&db, album_id));
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?
}

fn analyze_now(db: &Db, album_id: i64) -> R<Value> {
    if let Some(s) = db.analysis(album_id).and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        return Ok(s);
    }
    let ts = db.album_tracks(album_id);
    let t = ts.get(ts.len() / 2).ok_or("пустой альбом")?;
    let f = dsp::analyze(Path::new(&t.path), t.dur).ok_or("не удалось проанализировать")?;
    let v = serde_json::to_value(&f).map_err(|e| e.to_string())?;
    db.set_analysis(album_id, &v.to_string());
    Ok(v)
}
#[tauri::command]
fn set_recipe(a: S, album_id: i64, recipe: Value, history: Value) {
    a.db.set_recipe(album_id, Some(&recipe), Some(&history));
}
#[tauri::command]
fn use_real_cover(a: S, album_id: i64) {
    a.db.set_recipe(album_id, None, None);
    a.push_state();
}
#[tauri::command]
fn save_gen_cover(a: S, album_id: i64, png: Vec<u8>) -> R<()> {
    std::fs::write(covers::gen_path(album_id), png).map_err(|e| e.to_string())?;
    if a.player().current_track().and_then(|t| a.db.track(t)).map(|t| t.album_id) == Some(album_id) {
        a.push_state();
    }
    Ok(())
}
#[tauri::command]
async fn embed_cover(a: S<'_>, album_id: i64, png: Vec<u8>) -> R<usize> {
    let app = a.inner().clone();
    if app.settings.lock().write_protect {
        return Err("Включена защита файлов от записи (Настройки → Безопасность)".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut n = 0;
        let mut first = String::new();
        let mut errs = Vec::new();
        for (_, p) in app.db.album_track_paths(album_id) {
            match tags::embed_cover(Path::new(&p), &png) {
                Ok(()) => {
                    n += 1;
                    if first.is_empty() {
                        first = p.clone();
                    }
                }
                Err(e) => errs.push(e),
            }
        }
        if n == 0 {
            return Err(errs.first().cloned().unwrap_or_else(|| "нет файлов".into()));
        }
        covers::invalidate(album_id);
        app.db.set_cover_source(album_id, Some("file"), &first, "");
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn settings(a: S) -> Settings {
    a.settings.lock().clone()
}
#[tauri::command]
fn set_settings(a: S, patch: Value) -> R<Settings> {
    let old = a.settings.lock().clone();
    let mut v = serde_json::to_value(&old).map_err(|e| e.to_string())?;
    if let (Some(o), Some(p)) = (v.as_object_mut(), patch.as_object()) {
        for (k, x) in p {
            o.insert(k.clone(), x.clone());
        }
    }
    let s: Settings = serde_json::from_value(v).map_err(|e| e.to_string())?;
    a.db.kv_set("settings", &serde_json::to_string(&s).unwrap());
    *a.settings.lock() = s.clone();
    a.apply_settings(&s, Some(&old));
    if s.discord != old.discord || s.offline != old.offline {
        if s.offline != old.offline {
            a.art.lock().clear();
        }
        a.push_state();
    }
    Ok(s)
}

#[tauri::command]
fn discord_status(a: S) -> String {
    if !a.settings.lock().discord.enabled {
        return "Выключено".into();
    }
    a.rpc.status.lock().clone()
}
/// What would be sent to Discord right now (for the live preview), plus the resolved cover URL.
#[tauri::command]
fn discord_preview(a: S) -> Value {
    let st = a.state();
    let cfg = a.settings.lock().discord.clone();
    let act = st.track.as_ref().and_then(|_| {
        let mut c = cfg.clone();
        c.paused = "show".into();
        c.idle_min = 0;
        a.discord_activity(&c, &st)
    });
    json!({ "activity": act, "playing": st.playing, "pos": st.pos, "dur": st.dur })
}
#[tauri::command]
fn clear_cache(a: S, what: String) -> R<()> {
    let dir = match what.as_str() {
        "covers" => paths::covers(),
        "lyrics" => paths::root().join("lyrics"),
        _ => return Err("unknown".into()),
    };
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    if what == "covers" {
        a.art.lock().clear();
        a.emit("library", ());
    }
    Ok(())
}
#[tauri::command]
fn app_info() -> Value {
    json!({ "version": env!("CARGO_PKG_VERSION"), "data": paths::root().to_string_lossy() })
}
#[tauri::command]
fn hide_to_tray(a: S, app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        a.save_session();
        let _ = w.hide();
        a.set_hidden(true);
    }
}
#[tauri::command]
fn restart_app(a: S, app: AppHandle) {
    a.save_session();
    app.restart();
}
#[tauri::command]
fn show_window(app: AppHandle) {
    // first call comes from the UI once it has rendered; honour "start minimized"
    static FIRST: AtomicBool = AtomicBool::new(true);
    let a = app.try_state::<Arc<App>>().map(|s| s.inner().clone());
    if FIRST.swap(false, Ordering::SeqCst) {
        let min = a.as_ref().map(|a| a.settings.lock().start_minimized).unwrap_or(false) || std::env::args().any(|x| x == "--minimized");
        if min {
            if let Some(a) = &a {
                a.set_hidden(true);
            }
            return;
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let was_hidden = a.as_ref().map(|a| a.hidden.load(Ordering::SeqCst)).unwrap_or(false);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if was_hidden {
            if let Some(a) = &a {
                a.set_hidden(false);
            }
        }
    }
}

fn fill_url(u: &str, t: &Track) -> String {
    let enc = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    u.replace("{title}", &enc(&t.title)).replace("{artist}", &enc(&t.artist)).replace("{album}", &enc(&t.album)).replace("{query}", &enc(&format!("{} {}", t.artist, t.title)))
}

fn set_autostart(on: bool) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const NO_WINDOW: u32 = 0x0800_0000;
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let mut c = std::process::Command::new("reg");
        if on {
            let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            c.args(["add", key, "/v", "Teto Player", "/t", "REG_SZ", "/d", &format!("\"{exe}\" --minimized"), "/f"]);
        } else {
            c.args(["delete", key, "/v", "Teto Player", "/f"]);
        }
        let _ = c.creation_flags(NO_WINDOW).status();
    }
    #[cfg(not(windows))]
    let _ = on;
}

/// Hidden in tray: make WebView2 invisible, suspend its renderer and ask it to trim memory.
fn webview_power(w: &tauri::WebviewWindow, hidden: bool) {
    #[cfg(windows)]
    {
        let _ = w.with_webview(move |wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::*;
            use windows_core::Interface;
            let ctrl = wv.controller();
            let Ok(core) = ctrl.CoreWebView2() else { return };
            if hidden {
                let _ = ctrl.SetIsVisible(false);
                if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                    let _ = c19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
                }
                if let Ok(c3) = core.cast::<ICoreWebView2_3>() {
                    let h = webview2_com::TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
                    let _ = c3.TrySuspend(&h);
                }
            } else {
                if let Ok(c3) = core.cast::<ICoreWebView2_3>() {
                    let _ = c3.Resume();
                }
                if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                    let _ = c19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
                }
                let _ = ctrl.SetIsVisible(true);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (w, hidden);
}
#[tauri::command]
fn reveal_file(path: String) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let p = Path::new(&path);
        let mut c = std::process::Command::new("explorer");
        if p.is_dir() {
            c.arg(&path);
        } else {
            c.raw_arg(format!("/select,\"{}\"", path));
        }
        let _ = c.spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(Path::new(&path).parent().unwrap_or(Path::new("/"))).spawn();
    }
}

// ------------------------------ entry ------------------------------
pub fn run() {
    let db = Arc::new(Db::open(&paths::db()).expect("library.db"));
    crate::namefix_db::migrate(&db).expect("namefix migrate");
    let _ = crate::namefix_db::unify_artists(&db); // cheap: one pass over the tracks
    let init_settings: Settings = db.kv_get("settings").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let app = Arc::new(App {
        db: db.clone(),
        player: OnceLock::new(),
        scanner: OnceLock::new(),
        settings: Mutex::new(init_settings.clone()),
        handle: OnceLock::new(),
        error: Mutex::new(None),
        smtc: OnceLock::new(),
        last_track: AtomicI64::new(0),
        hidden: AtomicBool::new(false),
        rpc: Rpc::start(),
        worker: {
            let (tx, rx) = crossbeam_channel::unbounded::<Job>();
            std::thread::Builder::new()
                .name("teto-bg".into())
                .spawn(move || {
                    prio::background();
                    while let Ok(job) = rx.recv() {
                        job();
                    }
                })
                .expect("bg worker");
            tx
        },
        art: Mutex::new(HashMap::new()),
        paused_at: Mutex::new(None),
        listen: crate::listen::Listen::default(),
        api: OnceLock::new(),
    });

    // audio engine (non-blocking: device opens on its own thread)
    {
        let me = app.clone();
        let weak = Arc::downgrade(&app);
        let p = Player::new(
            move |e| {
                if let Some(a) = weak.upgrade() {
                    a.on_player_event(e);
                }
            },
            init_settings.device.clone(),
        );
        let _ = me.player.set(p);
        // now-playing API: a token for control is created once
        if init_settings.api.token.is_empty() {
            let mut s = me.settings.lock();
            s.api.token = crate::nowplaying::new_token();
            me.db.kv_set("settings", &serde_json::to_string(&*s).unwrap_or_default());
        }
        let _ = me.api.set(crate::nowplaying::Hub::new(Arc::new(ApiHost(Arc::downgrade(&me)))));
        let init_settings = me.settings.lock().clone();
        me.apply_settings(&init_settings, None);
        me.restore_session();
    }
    {
        let weak = Arc::downgrade(&app);
        let sc = Scanner::new(
            db.clone(),
            Box::new(move |st: &Status, changed| {
                if let Some(a) = weak.upgrade() {
                    a.emit("scan", st.clone());
                    if changed {
                        a.emit("library", ());
                    }
                }
            }),
        );
        let _ = app.scanner.set(sc);
    }

    let proto_db = db.clone();
    let state = app.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .register_asynchronous_uri_scheme_protocol("teto", move |_ctx, req, responder| {
            let db = proto_db.clone();
            let path = req.uri().path().to_string();
            std::thread::spawn(move || {
                let path = path.replace("%2F", "/").replace("%2f", "/");
                let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
                let resp = match parts.as_slice() {
                    ["cover", id, size] => {
                        let (id, size) = (id.parse::<i64>().unwrap_or(-1), size.parse::<u32>().unwrap_or(300));
                        covers::get(&db, id, size)
                    }
                    ["artist", file] if file.len() <= 24 && file.ends_with(".jpg") && file.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') => {
                        std::fs::read(paths::root().join("artists").join(file)).ok()
                    }
                    _ => None,
                };
                let r = match resp {
                    Some(b) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", "image/jpeg")
                        .header("Cache-Control", "max-age=31536000")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(b),
                    None => tauri::http::Response::builder().status(404).header("Access-Control-Allow-Origin", "*").body(Vec::new()),
                };
                responder.respond(r.unwrap());
            });
        })
        .setup(move |tapp| {
            let _ = app.handle.set(tapp.handle().clone());
            // main window is created here so browser args (GPU on/off) can come from the settings
            {
                let s = app.settings.lock().clone();
                let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
                if s.gpu {
                    args.push_str(" --enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist --enable-oop-rasterization");
                } else {
                    args.push_str(" --disable-gpu --disable-gpu-compositing");
                }
                let url = tauri::WebviewUrl::App("index.html".into());
                tauri::WebviewWindowBuilder::new(tapp, "main", url)
                    .title("Teto Player")
                    .inner_size(1520.0, 920.0)
                    .min_inner_size(1100.0, 700.0)
                    .center()
                    .decorations(false)
                    .shadow(true)
                    .visible(false)
                    .resizable(true)
                    .background_color(tauri::window::Color(7, 13, 15, 255))
                    .disable_drag_drop_handler()
                    .additional_browser_args(&args)
                    .build()?;
            }
            if app.settings.lock().autostart {
                set_autostart(true); // keeps the path valid if the exe was moved
            }
            // media overlay / keys
            let hwnd = {
                #[cfg(windows)]
                {
                    tapp.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize)
                }
                #[cfg(not(windows))]
                {
                    None
                }
            };
            start_smtc(&app, hwnd);
            // optional idle-time pre-analysis of the library (one album at a time, background priority)
            {
                let me = app.clone();
                std::thread::Builder::new()
                    .name("teto-preanalysis".into())
                    .spawn(move || {
                        prio::background();
                        loop {
                            std::thread::sleep(std::time::Duration::from_secs(4));
                            let s = me.settings.lock().clone();
                            if !s.bg_analysis || me.scanner.get().map(|sc| sc.status.lock().state == "scanning").unwrap_or(false) {
                                continue;
                            }
                            let Some(id) = me.db.next_unanalyzed() else { continue };
                            if analyze_now(&me.db, id).is_err() {
                                me.db.set_analysis(id, "{}");
                            }
                        }
                    })
                    .ok();
            }
            // volume leveling for songs without ReplayGain tags: loudness measured one song at a time (crate::loudness)
            {
                let me = app.clone();
                std::thread::Builder::new()
                    .name("teto-loudness".into())
                    .spawn(move || {
                        prio::background();
                        std::thread::sleep(std::time::Duration::from_secs(6));
                        loop {
                            let off = me.settings.lock().replaygain == "off";
                            let scanning = me.scanner.get().map(|sc| sc.status.lock().state == "scanning").unwrap_or(false);
                            if off || scanning {
                                std::thread::sleep(std::time::Duration::from_secs(10));
                                continue;
                            }
                            // the queue around the current song first: it is what plays next
                            let prefer: Vec<String> = {
                                let q = me.player().queue.lock();
                                q.items.iter().skip(q.play_idx).take(6).map(|x| x.path.clone()).collect()
                            };
                            let Some(path) = me.db.next_unmeasured(&prefer) else {
                                std::thread::sleep(std::time::Duration::from_secs(30));
                                continue;
                            };
                            let v = crate::loudness::measure(Path::new(&path));
                            me.db.set_loud(&path, v);
                            // queued items carry their gain: update them (applies from the next song, no jump mid-song)
                            if let Some((l, pk)) = v {
                                let album = {
                                    let q = me.player().queue.lock();
                                    q.items.iter().find(|x| x.path == path).map(|x| x.album_id)
                                };
                                let (al, ap) = album.map(|id| me.db.album_loud(id)).unwrap_or((None, None));
                                let mut q = me.player().queue.lock();
                                let q = &mut *q;
                                for it in q.items.iter_mut().chain(q.orig.iter_mut().flatten()) {
                                    if it.path == path {
                                        it.lufs = Some(l);
                                        it.peak = Some(pk);
                                    }
                                    if Some(it.album_id) == album {
                                        it.album_lufs = al;
                                        it.album_peak = ap;
                                    }
                                }
                            }
                            std::thread::sleep(std::time::Duration::from_millis(400));
                        }
                    })
                    .ok();
            }
            // genres from the internet for albums without genre tags: one album at a time, background priority
            {
                let me = app.clone();
                std::thread::Builder::new()
                    .name("teto-webgenre".into())
                    .spawn(move || {
                        prio::background();
                        let agent = crate::lyrics::agent();
                        let mut found = 0u32;
                        std::thread::sleep(std::time::Duration::from_secs(8));
                        loop {
                            let s = me.settings.lock().clone();
                            let scanning = me.scanner.get().map(|sc| sc.status.lock().state == "scanning").unwrap_or(false);
                            if scanning {
                                std::thread::sleep(std::time::Duration::from_secs(20));
                                continue;
                            }
                            let web = s.web_genres && !s.offline;
                            let next = if web { crate::webgenre::next_missing(&me.db) } else { None };
                            let Some((key, artist, album, title)) = next else {
                                // the internet did not know (or is off): guess the genre by the sound
                                if let Some(id) = crate::webgenre::next_unanalysed(&me.db, web) {
                                    if analyze_now(&me.db, id).is_err() {
                                        me.db.set_analysis(id, "{}");
                                    } else {
                                        found += 1;
                                        if found >= 20 {
                                            me.emit("library", ());
                                            found = 0;
                                        }
                                    }
                                    std::thread::sleep(std::time::Duration::from_millis(1500));
                                    continue;
                                }
                                if found > 0 {
                                    me.emit("library", ());
                                    found = 0;
                                }
                                std::thread::sleep(std::time::Duration::from_secs(if web { 90 } else { 30 }));
                                continue;
                            };
                            match crate::webgenre::lookup(&agent, &artist, &album, &title) {
                                Ok(g) => {
                                    let g = g.unwrap_or_default();
                                    let _ = crate::webgenre::save(&me.db, &key, &g);
                                    if !g.is_empty() {
                                        found += 1;
                                        if found >= 20 {
                                            me.emit("library", ());
                                            found = 0;
                                        }
                                    }
                                }
                                Err(crate::webgenre::Miss::NotFound) => {
                                    let _ = crate::webgenre::save(&me.db, &key, "");
                                }
                                Err(crate::webgenre::Miss::Network) => std::thread::sleep(std::time::Duration::from_secs(120)),
                            }
                            std::thread::sleep(std::time::Duration::from_millis(1200));
                        }
                    })
                    .ok();
            }
            build_tray(tapp, app.clone())?;
            // background: watch + incremental rescan shortly after start
            let sc = app.scanner.get().unwrap().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                if !sc.db.folders().is_empty() {
                    sc.watch();
                    sc.start();
                }
            });
            // safety net: show the window even if the UI failed to call show_window
            let h = tapp.handle().clone();
            let min = app.settings.lock().start_minimized || std::env::args().any(|x| x == "--minimized");
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2500));
                if min {
                    return;
                }
                if let Some(w) = h.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|w, e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                if let Some(a) = w.app_handle().try_state::<Arc<App>>() {
                    a.save_session();
                    if a.settings.lock().close_to_tray {
                        api.prevent_close();
                        let _ = w.hide();
                        a.set_hidden(true);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            stats, albums, recent_albums, album, album_tracks, artists, artist_albums, tracks, favorites, search, set_fav, set_album_fav, folders,
            add_folder, remove_folder, rescan, reprocess, listen_log, listen_first, scan_status, playlists, create_playlist, delete_playlist, rename_playlist, playlist_tracks,
            add_to_playlist, remove_from_playlist, play_queue, play_mix, album_genres, rename_track, swap_artist_title, rename_artist, set_artist_photo, artist_photo, names_to_review, enqueue, toggle, next, prev, seek, jump, remove_from_queue, set_volume, set_muted,
            set_shuffle, set_repeat, player_state, queue_tracks, devices, lyrics, lyrics_candidates, pick_lyrics, save_lrc, analyze_album,
            set_recipe, use_real_cover, save_gen_cover, embed_cover, settings, set_settings, show_window, reveal_file,
            discord_status, discord_preview, clear_cache, levels, app_info, hide_to_tray, restart_app, album_tracklist, open_url, yt_search, yt_download, listen_reset, save_png,
            dl_cancel, net_http, set_custom_cover, reset_cover, has_custom_cover, delete_tracks, level_stats, api_status, api_new_token
        ])
        .build(tauri::generate_context!())
        .expect("error while building Teto Player")
        .run(|h, e| {
            if let tauri::RunEvent::ExitRequested { .. } = e {
                if let Some(a) = h.try_state::<Arc<App>>() {
                    a.save_session();
                }
            }
        });
}

fn build_tray(tapp: &mut tauri::App, app: Arc<App>) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let h = tapp.handle();
    let toggle = MenuItem::with_id(h, "toggle", "Пауза / воспроизведение", true, None::<&str>)?;
    let next = MenuItem::with_id(h, "next", "Следующий трек", true, None::<&str>)?;
    let prev = MenuItem::with_id(h, "prev", "Предыдущий трек", true, None::<&str>)?;
    let show = MenuItem::with_id(h, "show", "Показать Teto Player", true, None::<&str>)?;
    let quit = MenuItem::with_id(h, "quit", "Выход", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(h)?;
    let menu = Menu::with_items(h, &[&toggle, &prev, &next, &sep, &show, &quit])?;
    let a2 = app.clone();
    let mut b = TrayIconBuilder::with_id("teto").tooltip("Teto Player").menu(&menu);
    if let Some(icon) = h.default_window_icon() {
        b = b.icon(icon.clone());
    }
    #[allow(deprecated)]
    let b = b.menu_on_left_click(false);
    b.on_menu_event(move |h, ev| {
        let p = a2.player();
        match ev.id.as_ref() {
            "toggle" => p.toggle(),
            "next" => p.next(),
            "prev" => p.prev(),
            "show" => show_window(h.clone()),
            "quit" => {
                a2.save_session();
                h.exit(0);
            }
            _ => {}
        }
        a2.push_state();
    })
    .on_tray_icon_event(|tray, ev| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
            show_window(tray.app_handle().clone());
        }
    })
    .build(h)?;
    Ok(())
}
