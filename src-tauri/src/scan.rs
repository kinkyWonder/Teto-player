//! Background library scanner (incremental by mtime+size) and folder watcher.
use crate::db::{Db, Meta};
use crate::{covers, namefix_db, tags};
use parking_lot::Mutex;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use walkdir::WalkDir;

#[derive(Serialize, Clone, Debug)]
pub struct Status {
    pub state: String,
    pub done: usize,
    pub total: usize,
    pub message: String,
}

impl Default for Status {
    fn default() -> Self {
        Status { state: "idle".into(), done: 0, total: 0, message: String::new() }
    }
}

pub struct Scanner {
    pub db: Arc<Db>,
    pub status: Mutex<Status>,
    running: AtomicBool,
    again: AtomicBool,
    /// next run re-reads every file (Settings → "Reprocess all files")
    force: AtomicBool,
    notify: Box<dyn Fn(&Status, bool) + Send + Sync>, // (status, library_changed)
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl Scanner {
    pub fn new(db: Arc<Db>, notify: Box<dyn Fn(&Status, bool) + Send + Sync>) -> Arc<Scanner> {
        Arc::new(Scanner { db, status: Mutex::new(Status::default()), running: AtomicBool::new(false), again: AtomicBool::new(false), force: AtomicBool::new(false), notify, watcher: Mutex::new(None) })
    }

    fn set(&self, st: Status, changed: bool) {
        *self.status.lock() = st.clone();
        (self.notify)(&st, changed);
    }

    /// Full rescan: every file is read and parsed again, as if it was new.
    pub fn start_full(self: &Arc<Self>) {
        self.force.store(true, Ordering::SeqCst);
        self.start();
    }

    /// Start a scan in the background (coalesces concurrent requests).
    pub fn start(self: &Arc<Self>) {
        if self.running.swap(true, Ordering::SeqCst) {
            self.again.store(true, Ordering::SeqCst);
            return;
        }
        let me = self.clone();
        std::thread::Builder::new()
            .name("tide-scan".into())
            .spawn(move || {
                crate::prio::background();
                loop {
                    me.again.store(false, Ordering::SeqCst);
                    if let Err(e) = me.run() {
                        me.set(Status { state: "error".into(), done: 0, total: 0, message: e }, false);
                    }
                    if !me.again.load(Ordering::SeqCst) {
                        break;
                    }
                }
                me.running.store(false, Ordering::SeqCst);
            })
            .unwrap();
    }

    fn run(&self) -> Result<(), String> {
        let t0 = Instant::now();
        let folders = self.db.folders();
        self.set(Status { state: "scanning".into(), done: 0, total: 0, message: "Поиск файлов…".into() }, false);
        let mut files: Vec<(PathBuf, i64, i64)> = Vec::new();
        for f in &folders {
            for ent in WalkDir::new(f).follow_links(true).into_iter().filter_map(|e| e.ok()) {
                if !ent.file_type().is_file() || !tags::is_audio(ent.path()) {
                    continue;
                }
                let Ok(md) = ent.metadata() else { continue };
                let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
                files.push((ent.into_path(), mtime, md.len() as i64));
            }
        }
        let force = self.force.swap(false, Ordering::SeqCst);
        let index = if force { Default::default() } else { self.db.file_index() };
        let seen: HashSet<String> = files.iter().map(|f| f.0.to_string_lossy().into_owned()).collect();
        let gone: Vec<i64> = if force { self.db.file_index() } else { index.clone() }.iter().filter(|(p, _)| !seen.contains(*p)).map(|(_, v)| v.0).collect();
        let todo: Vec<&(PathBuf, i64, i64)> = files
            .iter()
            .filter(|(p, m, s)| match index.get(p.to_string_lossy().as_ref()) {
                Some((_, om, os)) => om != m || os != s,
                None => true,
            })
            .collect();
        let total = todo.len();
        let changed = total > 0 || !gone.is_empty();
        let done = std::sync::atomic::AtomicUsize::new(0);
        let last = Mutex::new(Instant::now());
        // dedicated low-priority pool: scanning never stutters playback or the UI
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads((std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 2).clamp(1, 6))
            .start_handler(|_| crate::prio::background())
            .build()
            .map_err(|e| e.to_string())?;
        // индекс уже добавленных исполнителей/треков + ручные правки пользователя (~мс на 10k треков)
        let mut names = namefix_db::Ctx::load(&self.db);
        for chunk in todo.chunks(256) {
            let mut metas: Vec<Meta> = pool.install(|| chunk
                .par_iter()
                .filter_map(|(p, _, _)| {
                    let m = tags::read_raw(p);
                    let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                    let mut l = last.lock();
                    if l.elapsed() > Duration::from_millis(150) {
                        *l = Instant::now();
                        drop(l);
                        self.set(Status { state: "scanning".into(), done: d, total, message: p.to_string_lossy().into_owned() }, false);
                    }
                    m
                })
                .collect());
            names.apply(&mut metas); // очистка названий: микросекунды на трек, в этом же фоновом потоке
            self.db.upsert(&metas)?;
        }
        // сомнительные треки, разобранные до того, как в индекс попали нужные исполнители, — разбираем ещё раз
        let re = names.take_recheck();
        if !re.is_empty() {
            let mut metas: Vec<Meta> = pool.install(|| re.par_iter().filter_map(|p| tags::read_raw(std::path::Path::new(p))).collect());
            names.apply_final(&mut metas);
            self.db.upsert(&metas)?;
        }
        names.flush(&self.db)?;
        self.db.delete_tracks(&gone)?;
        if changed {
            self.db.rebuild_albums()?;
            // «Kino» и «Кино», «КИНО» и «Кино» — один исполнитель
            if let Err(err) = crate::namefix_db::unify_artists(&self.db) {
                eprintln!("unify artists: {err}");
            }
            if total > 0 {
                // re-resolve covers for albums touched by this scan
                self.db.reset_cover_sources();
            }
        }
        covers::resolve_sources(&self.db);
        if total > 0 {
            for (id, _) in self.db.albums_needing_cover() {
                covers::invalidate(id);
            }
        }
        eprintln!("scan: {} files, {} updated, {} removed in {:?}", files.len(), total, gone.len(), t0.elapsed());
        self.set(Status { state: "idle".into(), done: total, total, message: String::new() }, changed);
        Ok(())
    }

    /// Watch library folders and rescan (debounced) on changes.
    pub fn watch(self: &Arc<Self>) {
        use notify::{RecursiveMode, Watcher};
        let me = self.clone();
        let (tx, rx) = crossbeam_channel::unbounded::<()>();
        let w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if ev.paths.iter().any(|p| tags::is_audio(p) || p.extension().is_none() || covers_name(p)) && !ev.kind.is_access() {
                    let _ = tx.send(());
                }
            }
        });
        let Ok(mut w) = w else { return };
        for f in self.db.folders() {
            let _ = w.watch(std::path::Path::new(&f), RecursiveMode::Recursive);
        }
        *self.watcher.lock() = Some(w);
        std::thread::Builder::new()
            .name("tide-watch".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    // debounce: wait for 2 s of silence
                    while rx.recv_timeout(Duration::from_secs(2)).is_ok() {}
                    me.start();
                }
            })
            .ok();
    }

    pub fn rewatch(self: &Arc<Self>) {
        *self.watcher.lock() = None;
        self.watch();
    }
}

fn covers_name(p: &std::path::Path) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "lrc")).unwrap_or(false)
}
