//! Audio engine: decoder thread -> resampler -> ReplayGain/EQ -> lock-free ring -> cpal (WASAPI shared) callback.
//! Gapless: the decoder opens the next queue item as soon as the current one hits EOF and keeps
//! filling the same ring; markers map device frames to tracks for the position/track display.
use crate::db::PlayItem;
use crate::decode::{OpenErr, Source};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{unbounded, Receiver, RecvTimeoutError, Sender};
use parking_lot::Mutex;
use rtrb::{Consumer, Producer, RingBuffer};
use rubato::{FftFixedIn, Resampler};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering::*};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    Off,
    All,
    One,
}

pub struct Queue {
    pub items: Vec<PlayItem>,
    pub orig: Option<Vec<PlayItem>>,
    pub play_idx: usize,
    pub dec_idx: usize,
    pub repeat: Repeat,
}

impl Queue {
    fn auto_next(&self, i: usize) -> Option<usize> {
        let n = self.items.len();
        if n == 0 {
            return None;
        }
        match self.repeat {
            Repeat::One => Some(i.min(n - 1)),
            Repeat::All => Some((i + 1) % n),
            Repeat::Off => (i + 1 < n).then_some(i + 1),
        }
    }
}

#[derive(Clone, Copy)]
struct Marker {
    at: u64,
    qidx: usize,
    track_id: i64,
    offset: f64,
}

pub struct Shared {
    volume: AtomicU32,
    muted: AtomicBool,
    pub paused: AtomicBool,
    played: AtomicU64,
    flush: AtomicBool,
    markers: Mutex<VecDeque<Marker>>,
    dev_rate: AtomicU32,
    done: AtomicBool,
    produced: AtomicU64,
    pub rg_mode: AtomicU8, // 0 off, 1 track, 2 album
    eq: Mutex<(bool, [f32; 10])>,
    eq_ver: AtomicU64,
    alive: AtomicBool,
    /// transition between tracks: 0 gapless, 1 crossfade (equal power), 2 linear, 3 dip, 4 DJ (filter sweep)
    pub xf_mode: AtomicU8,
    pub xf_ms: AtomicU32,
    /// keep albums gapless (no crossfade between tracks of the same album)
    pub xf_keep_album: AtomicBool,
    /// pause/resume fade length
    pub fade_ms: AtomicU32,
    /// short fade-out on manual skip/seek
    pub skip_fade: AtomicBool,
    /// callback is outputting pure silence because of pause
    silent: AtomicBool,
    stream_paused: AtomicBool,
    wake: Mutex<Option<Sender<OutCmd>>>,
    /// visualizer: spectrum frames keyed by produced-frame index; computed only while the UI asks for it
    viz_req: AtomicU64,
    levels: Mutex<VecDeque<(u64, [u8; BANDS])>>,
}

pub const BANDS: usize = 24;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Shared {
    fn new(rate: u32, paused: bool) -> Shared {
        Shared {
            volume: AtomicU32::new(0.8f32.to_bits()),
            muted: AtomicBool::new(false),
            paused: AtomicBool::new(paused),
            played: AtomicU64::new(0),
            flush: AtomicBool::new(false),
            markers: Mutex::new(VecDeque::new()),
            dev_rate: AtomicU32::new(rate),
            done: AtomicBool::new(true),
            produced: AtomicU64::new(0),
            rg_mode: AtomicU8::new(1),
            eq: Mutex::new((false, [0.0; 10])),
            eq_ver: AtomicU64::new(0),
            alive: AtomicBool::new(false),
            xf_mode: AtomicU8::new(0),
            xf_ms: AtomicU32::new(6000),
            xf_keep_album: AtomicBool::new(true),
            fade_ms: AtomicU32::new(120),
            skip_fade: AtomicBool::new(true),
            silent: AtomicBool::new(false),
            stream_paused: AtomicBool::new(false),
            wake: Mutex::new(None),
            viz_req: AtomicU64::new(0),
            levels: Mutex::new(VecDeque::new()),
        }
    }
}

enum Cmd {
    Output(Producer<f32>, u32, usize),
    Load { qidx: usize, pos: f64 },
    Requeue,
    Stop,
}

enum OutCmd {
    Rebuild(String),
    Wake,
}

#[derive(Debug, Clone)]
pub enum Event {
    Track { qidx: usize, track_id: i64 },
    Pos(f64),
    Ended,
    Error { track_id: i64, msg: String, missing: bool },
}

pub struct Player {
    tx: Sender<Cmd>,
    out_tx: Sender<OutCmd>,
    pub sh: Arc<Shared>,
    pub queue: Arc<Mutex<Queue>>,
    device: Mutex<String>,
}

const FREQS: [f32; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];

impl Player {
    pub fn new<F: Fn(Event) + Send + Sync + 'static>(on_event: F, device: String) -> Arc<Player> {
        let sh = Arc::new(Shared::new(48000, true));
        let queue = Arc::new(Mutex::new(Queue { items: vec![], orig: None, play_idx: 0, dec_idx: 0, repeat: Repeat::Off }));
        let (tx, rx) = unbounded::<Cmd>();
        let (out_tx, out_rx) = unbounded::<OutCmd>();
        let on_event = Arc::new(on_event);
        {
            let (sh, q, ev) = (sh.clone(), queue.clone(), on_event.clone());
            std::thread::Builder::new().name("tide-decoder".into()).spawn(move || {
                crate::prio::high();
                decoder_thread(rx, sh, q, ev)
            }).unwrap();
        }
        {
            let (sh, dtx, otx) = (sh.clone(), tx.clone(), out_tx.clone());
            std::thread::Builder::new().name("tide-output".into()).spawn(move || output_thread(out_rx, otx, dtx, sh)).unwrap();
        }
        {
            let (sh, q, ev) = (sh.clone(), queue.clone(), on_event.clone());
            std::thread::Builder::new().name("tide-position".into()).spawn(move || position_thread(sh, q, ev)).unwrap();
        }
        *sh.wake.lock() = Some(out_tx.clone());
        let _ = out_tx.send(OutCmd::Rebuild(device.clone()));
        Arc::new(Player { tx, out_tx, sh, queue, device: Mutex::new(device) })
    }

    pub fn set_device(&self, name: String) {
        *self.device.lock() = name.clone();
        let _ = self.out_tx.send(OutCmd::Rebuild(name));
    }

    pub fn devices() -> Vec<String> {
        cpal::default_host().output_devices().map(|it| it.filter_map(|d| d.name().ok()).collect()).unwrap_or_default()
    }

    pub fn load(&self, items: Vec<PlayItem>, idx: usize, pos: f64, play: bool, shuffle: bool) {
        let n = items.len();
        if n == 0 {
            return;
        }
        let idx = idx.min(n - 1);
        {
            let mut q = self.queue.lock();
            q.items = items;
            q.orig = None;
            q.play_idx = idx;
            q.dec_idx = idx;
            if shuffle {
                shuffle_queue(&mut q);
            }
        }
        let qidx = self.queue.lock().play_idx;
        self.sh.paused.store(!play, SeqCst);
        if play {
            self.wake();
        }
        let _ = self.tx.send(Cmd::Load { qidx, pos });
    }

    /// Plays an already mixed order (smart shuffle computed by the UI); `orig` is restored when shuffle is turned off.
    pub fn load_mixed(&self, orig: Vec<PlayItem>, mixed: Vec<PlayItem>) {
        if mixed.is_empty() {
            return;
        }
        {
            let mut q = self.queue.lock();
            q.items = mixed;
            q.orig = Some(orig);
            q.play_idx = 0;
            q.dec_idx = 0;
        }
        self.sh.paused.store(false, SeqCst);
        self.wake();
        let _ = self.tx.send(Cmd::Load { qidx: 0, pos: 0.0 });
    }

    pub fn position(&self) -> f64 {
        current(&self.sh).map(|(m, p)| {
            let _ = m;
            p
        }).unwrap_or(0.0)
    }

    pub fn current_track(&self) -> Option<i64> {
        current(&self.sh).map(|(m, _)| m.track_id)
    }

    pub fn is_playing(&self) -> bool {
        !self.sh.paused.load(SeqCst)
    }

    pub fn play(&self) {
        if self.sh.done.load(SeqCst) && self.sh.played.load(SeqCst) >= self.sh.produced.load(SeqCst) {
            // queue had ended: restart current item
            let q = self.queue.lock();
            if q.items.is_empty() {
                return;
            }
            let qidx = q.play_idx;
            drop(q);
            self.sh.paused.store(false, SeqCst);
            self.wake();
            let _ = self.tx.send(Cmd::Load { qidx, pos: 0.0 });
            return;
        }
        self.sh.paused.store(false, SeqCst);
        self.wake();
    }
    fn wake(&self) {
        if self.sh.stream_paused.load(SeqCst) {
            let _ = self.out_tx.send(OutCmd::Wake);
        }
    }
    pub fn pause(&self) {
        self.sh.paused.store(true, SeqCst);
    }
    pub fn toggle(&self) {
        if self.is_playing() { self.pause() } else { self.play() }
    }

    pub fn seek(&self, pos: f64) {
        let qidx = self.queue.lock().play_idx;
        if self.queue.lock().items.is_empty() {
            return;
        }
        let _ = self.tx.send(Cmd::Load { qidx, pos: pos.max(0.0) });
    }

    pub fn jump(&self, qidx: usize) {
        if qidx < self.queue.lock().items.len() {
            self.sh.paused.store(false, SeqCst);
            self.wake();
            let _ = self.tx.send(Cmd::Load { qidx, pos: 0.0 });
        }
    }

    pub fn next(&self) {
        let q = self.queue.lock();
        let n = q.items.len();
        if n == 0 {
            return;
        }
        let i = q.play_idx;
        let target = if i + 1 < n { Some(i + 1) } else if q.repeat != Repeat::Off { Some(0) } else { None };
        drop(q);
        match target {
            Some(t) => {
                let _ = self.tx.send(Cmd::Load { qidx: t, pos: 0.0 });
            }
            None => {
                self.sh.paused.store(true, SeqCst);
                let _ = self.tx.send(Cmd::Stop);
            }
        }
    }

    pub fn prev(&self) {
        if self.position() > 3.0 {
            return self.seek(0.0);
        }
        let q = self.queue.lock();
        let n = q.items.len();
        if n == 0 {
            return;
        }
        let i = q.play_idx;
        let t = if i > 0 { i - 1 } else if q.repeat == Repeat::All { n - 1 } else { 0 };
        drop(q);
        let _ = self.tx.send(Cmd::Load { qidx: t, pos: 0.0 });
    }

    pub fn set_volume(&self, v: f32) {
        self.sh.volume.store(v.clamp(0.0, 1.0).to_bits(), SeqCst);
    }
    pub fn volume(&self) -> f32 {
        f32::from_bits(self.sh.volume.load(SeqCst))
    }
    pub fn set_muted(&self, m: bool) {
        self.sh.muted.store(m, SeqCst);
    }
    pub fn muted(&self) -> bool {
        self.sh.muted.load(SeqCst)
    }

    pub fn set_eq(&self, on: bool, bands: [f32; 10]) {
        *self.sh.eq.lock() = (on, bands);
        self.sh.eq_ver.fetch_add(1, SeqCst);
    }

    pub fn set_repeat(&self, r: Repeat) {
        self.queue.lock().repeat = r;
        let _ = self.tx.send(Cmd::Requeue);
    }

    pub fn set_shuffle(&self, on: bool) {
        let mut q = self.queue.lock();
        if q.items.is_empty() {
            return;
        }
        let cur_id = q.items[q.play_idx].id;
        if on && q.orig.is_none() {
            shuffle_queue(&mut q);
        } else if !on {
            if let Some(o) = q.orig.take() {
                q.items = o;
                q.play_idx = q.items.iter().position(|x| x.id == cur_id).unwrap_or(0);
            }
        }
        let pi = q.play_idx;
        drop(q);
        remap_markers(&self.sh, pi);
        let _ = self.tx.send(Cmd::Requeue);
    }

    pub fn shuffled(&self) -> bool {
        self.queue.lock().orig.is_some()
    }

    pub fn enqueue(&self, items: Vec<PlayItem>, next: bool) {
        let mut q = self.queue.lock();
        if q.items.is_empty() {
            drop(q);
            return self.load(items, 0, 0.0, true, false);
        }
        if next {
            let at = q.play_idx + 1;
            let tail = q.items.split_off(at);
            q.items.extend(items.iter().cloned());
            q.items.extend(tail);
        } else {
            q.items.extend(items.iter().cloned());
        }
        if let Some(o) = q.orig.as_mut() {
            o.extend(items);
        }
        drop(q);
        let _ = self.tx.send(Cmd::Requeue);
    }

    pub fn remove(&self, idx: usize) {
        let mut q = self.queue.lock();
        if idx >= q.items.len() || idx == q.play_idx {
            return;
        }
        let it = q.items.remove(idx);
        if let Some(o) = q.orig.as_mut() {
            if let Some(p) = o.iter().position(|x| x.id == it.id) {
                o.remove(p);
            }
        }
        if idx < q.play_idx {
            q.play_idx -= 1;
        }
        let pi = q.play_idx;
        drop(q);
        remap_markers(&self.sh, pi);
        let _ = self.tx.send(Cmd::Requeue);
    }

    /// Spectrum (0..1 per band) of what is audible right now. Calling this keeps the analyser running for 1 s.
    pub fn levels(&self) -> Vec<f32> {
        self.sh.viz_req.store(now_ms(), Relaxed);
        if self.sh.paused.load(Relaxed) {
            return vec![0.0; BANDS];
        }
        let played = self.sh.played.load(Relaxed);
        let mut l = self.sh.levels.lock();
        while l.len() > 1 && l[1].0 <= played {
            l.pop_front();
        }
        match l.front() {
            Some((at, b)) if *at <= played + 4096 => b.iter().map(|&x| x as f32 / 255.0).collect(),
            _ => vec![0.0; BANDS],
        }
    }

    pub fn alive(&self) -> bool {
        self.sh.alive.load(SeqCst)
    }
}

fn shuffle_queue(q: &mut Queue) {
    let cur = q.items[q.play_idx].clone();
    q.orig = Some(q.items.clone());
    let mut rest: Vec<PlayItem> = q.items.iter().enumerate().filter(|(i, _)| *i != q.play_idx).map(|(_, x)| x.clone()).collect();
    fastrand::shuffle(&mut rest);
    let mut out = Vec::with_capacity(rest.len() + 1);
    out.push(cur);
    spread_albums(&mut out, rest);
    q.items = out;
    q.play_idx = 0;
}

/// Smart shuffle: keeps tracks of the same album apart (looks ahead for a non-clashing pick).
fn spread_albums(out: &mut Vec<PlayItem>, mut pool: Vec<PlayItem>) {
    let albums = {
        let mut v: Vec<i64> = pool.iter().map(|x| x.album_id).collect();
        v.sort_unstable();
        v.dedup();
        v.len()
    };
    let gap = albums.saturating_sub(1).clamp(0, 4);
    while !pool.is_empty() {
        let look = pool.len().min(48);
        let pick = (0..look)
            .find(|&j| {
                let a = pool[j].album_id;
                out.iter().rev().take(gap).all(|p| p.album_id != a)
            })
            .unwrap_or(0);
        out.push(pool.remove(pick));
    }
}

fn remap_markers(sh: &Shared, play_idx: usize) {
    let mut m = sh.markers.lock();
    if let Some(first) = m.front_mut() {
        first.qidx = play_idx;
    }
}

/// (current marker, position seconds)
fn current(sh: &Shared) -> Option<(Marker, f64)> {
    let played = sh.played.load(SeqCst);
    let rate = sh.dev_rate.load(SeqCst).max(1) as f64;
    let mut m = sh.markers.lock();
    while m.len() > 1 && m[1].at <= played {
        m.pop_front();
    }
    let k = *m.front()?;
    Some((k, k.offset + played.saturating_sub(k.at) as f64 / rate))
}

fn position_thread(sh: Arc<Shared>, q: Arc<Mutex<Queue>>, ev: Arc<dyn Fn(Event) + Send + Sync>) {
    let mut last_track: Option<(usize, i64)> = None;
    let mut last_emit = Instant::now();
    let mut ended_sent = true;
    loop {
        // 20 Hz while playing, 4 Hz while paused: near-zero CPU when idle / hidden in tray
        std::thread::sleep(Duration::from_millis(if sh.paused.load(Relaxed) { 250 } else { 50 }));
        if let Some((m, pos)) = current(&sh) {
            if last_track.map(|t| t.1) != Some(m.track_id) || last_track.map(|t| t.0) != Some(m.qidx) {
                {
                    let mut qq = q.lock();
                    if m.qidx < qq.items.len() {
                        qq.play_idx = m.qidx;
                    }
                }
                last_track = Some((m.qidx, m.track_id));
                ev(Event::Track { qidx: m.qidx, track_id: m.track_id });
                ended_sent = false;
            }
            let ended = sh.done.load(SeqCst) && sh.played.load(SeqCst) >= sh.produced.load(SeqCst);
            if ended && !ended_sent && !sh.paused.load(SeqCst) {
                ended_sent = true;
                sh.paused.store(true, SeqCst);
                ev(Event::Ended);
            } else if !ended {
                ended_sent = false;
            }
            if !sh.paused.load(SeqCst) && last_emit.elapsed() >= Duration::from_millis(250) {
                last_emit = Instant::now();
                ev(Event::Pos(pos));
            }
        }
    }
}

// ---------------- output ----------------

fn output_thread(rx: Receiver<OutCmd>, self_tx: Sender<OutCmd>, dtx: Sender<Cmd>, sh: Arc<Shared>) {
    let mut _stream: Option<cpal::Stream> = None;
    let mut want = String::new();
    let mut silent_since: Option<Instant> = None;
    let mut last_retry = Instant::now();
    loop {
        let cmd = match rx.recv_timeout(Duration::from_millis(400)) {
            Ok(c) => Some(c),
            Err(RecvTimeoutError::Timeout) => None,
            Err(_) => return,
        };
        let rebuild = match cmd {
            Some(OutCmd::Rebuild(name)) => {
                want = name;
                true
            }
            Some(OutCmd::Wake) => false,
            // retry periodically when no device
            None => !sh.alive.load(SeqCst) && last_retry.elapsed() > Duration::from_secs(2),
        };
        if rebuild {
            last_retry = Instant::now();
            _stream = None;
            sh.alive.store(false, SeqCst);
            sh.stream_paused.store(false, SeqCst);
            match open_stream(&want, &sh, self_tx.clone()) {
                Ok((stream, prod, rate, ch)) => {
                    sh.dev_rate.store(rate, SeqCst);
                    let _ = dtx.send(Cmd::Output(prod, rate, ch));
                    sh.alive.store(true, SeqCst);
                    _stream = Some(stream);
                }
                Err(e) => {
                    eprintln!("audio output error: {e}");
                }
            }
            continue;
        }
        // Idle power saving: stop the WASAPI stream after ~2 s of silent pause, restart instantly on demand.
        let Some(st) = _stream.as_ref() else { continue };
        let want_run = !sh.paused.load(SeqCst) || sh.flush.load(SeqCst);
        if sh.stream_paused.load(SeqCst) {
            if want_run && st.play().is_ok() {
                sh.stream_paused.store(false, SeqCst);
                silent_since = None;
            }
        } else if !want_run && sh.silent.load(SeqCst) {
            let t = *silent_since.get_or_insert_with(Instant::now);
            if t.elapsed() > Duration::from_secs(2) && st.pause().is_ok() {
                sh.stream_paused.store(true, SeqCst);
            }
        } else {
            silent_since = None;
        }
    }
}

fn open_stream(name: &str, sh: &Arc<Shared>, self_tx: Sender<OutCmd>) -> Result<(cpal::Stream, Producer<f32>, u32, usize), String> {
    let host = cpal::default_host();
    let dev = if name.is_empty() {
        host.default_output_device()
    } else {
        host.output_devices().ok().and_then(|mut it| it.find(|d| d.name().map(|n| n == name).unwrap_or(false))).or_else(|| host.default_output_device())
    }
    .ok_or("нет устройства вывода")?;
    let cfg = dev.default_output_config().map_err(|e| e.to_string())?;
    let rate = cfg.sample_rate().0;
    let ch = cfg.channels() as usize;
    let fmt = cfg.sample_format();
    let config: cpal::StreamConfig = cfg.into();
    let (prod, cons) = RingBuffer::<f32>::new((rate as usize * ch * 3) / 10); // 300 ms
    let err_tx = self_tx.clone();
    let err = move |e: cpal::StreamError| {
        eprintln!("stream error: {e}");
        let _ = err_tx.send(OutCmd::Rebuild(String::new()));
    };
    let mut cb = Callback { cons, sh: sh.clone(), ch, fade: 0.0, gain: 0.0, rate: rate as f32, fast_in: false };
    let stream = match fmt {
        cpal::SampleFormat::F32 => dev.build_output_stream(&config, move |d: &mut [f32], _: &cpal::OutputCallbackInfo| cb.fill(d), err, None),
        cpal::SampleFormat::I16 => {
            let mut tmp = Vec::new();
            dev.build_output_stream(&config, move |d: &mut [i16], _: &cpal::OutputCallbackInfo| {
                tmp.resize(d.len(), 0.0);
                cb.fill(&mut tmp);
                for (o, x) in d.iter_mut().zip(&tmp) {
                    *o = (x.clamp(-1.0, 1.0) * 32767.0) as i16;
                }
            }, err, None)
        }
        cpal::SampleFormat::I32 => {
            let mut tmp = Vec::new();
            dev.build_output_stream(&config, move |d: &mut [i32], _: &cpal::OutputCallbackInfo| {
                tmp.resize(d.len(), 0.0);
                cb.fill(&mut tmp);
                for (o, x) in d.iter_mut().zip(&tmp) {
                    *o = (x.clamp(-1.0, 1.0) as f64 * 2147483647.0) as i32;
                }
            }, err, None)
        }
        cpal::SampleFormat::U16 => {
            let mut tmp = Vec::new();
            dev.build_output_stream(&config, move |d: &mut [u16], _: &cpal::OutputCallbackInfo| {
                tmp.resize(d.len(), 0.0);
                cb.fill(&mut tmp);
                for (o, x) in d.iter_mut().zip(&tmp) {
                    *o = ((x.clamp(-1.0, 1.0) + 1.0) * 32767.5) as u16;
                }
            }, err, None)
        }
        f => return Err(format!("формат {f:?} не поддерживается")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, prod, rate, ch))
}

struct Callback {
    cons: Consumer<f32>,
    sh: Arc<Shared>,
    ch: usize,
    fade: f32,
    gain: f32,
    rate: f32,
    fast_in: bool,
}

impl Callback {
    fn fill(&mut self, data: &mut [f32]) {
        let ch = self.ch.max(1);
        let flushing = self.sh.flush.load(Acquire);
        let skip_fade = self.sh.skip_fade.load(Relaxed);
        if flushing && (self.fade <= 0.0 || !skip_fade) {
            let n = self.cons.slots();
            if let Ok(c) = self.cons.read_chunk(n) {
                c.commit_all();
            }
            self.fade = 0.0;
            self.fast_in = true;
            self.sh.flush.store(false, Release);
            if self.sh.paused.load(Relaxed) {
                data.fill(0.0);
                return;
            }
        }
        let flushing = self.sh.flush.load(Relaxed);
        let paused = self.sh.paused.load(Relaxed);
        let target = if paused || flushing { 0.0 } else { 1.0 };
        if target == 0.0 && self.fade <= 0.0 {
            self.sh.silent.store(true, Relaxed);
            data.fill(0.0);
            return;
        }
        self.sh.silent.store(false, Relaxed);
        // fade lengths: user-defined for pause/resume, 60 ms for skip/seek
        let pause_ms = self.sh.fade_ms.load(Relaxed).clamp(5, 2000) as f32;
        let ms = if flushing || self.fast_in { 60.0 } else { pause_ms };
        let step = 1.0 / (self.rate * ms / 1000.0);
        let avail = self.cons.slots();
        let n = data.len().min(avail - avail % ch);
        if let Ok(chunk) = self.cons.read_chunk(n) {
            let (a, b) = chunk.as_slices();
            data[..a.len()].copy_from_slice(a);
            data[a.len()..a.len() + b.len()].copy_from_slice(b);
            chunk.commit_all();
        }
        data[n..].fill(0.0);
        let v = f32::from_bits(self.sh.volume.load(Relaxed));
        let tg = if self.sh.muted.load(Relaxed) { 0.0 } else { v * v };
        let frames = n / ch;
        let gstep = (tg - self.gain) / frames.max(1) as f32;
        for f in 0..frames {
            if self.fade < target {
                self.fade = (self.fade + step).min(1.0);
            } else if self.fade > target {
                self.fade = (self.fade - step).max(0.0);
            }
            self.gain += gstep;
            // smoothstep fade curve: no clicks, natural loudness change
            let x = self.fade;
            let g = x * x * (3.0 - 2.0 * x) * self.gain;
            for s in &mut data[f * ch..f * ch + ch] {
                *s *= g;
            }
        }
        if self.fade >= 1.0 {
            self.fast_in = false;
        }
        if flushing && frames == 0 {
            self.fade = 0.0;
        }
        self.gain = tg;
        self.sh.played.fetch_add(frames as u64, Relaxed);
    }
}

// ---------------- decoder ----------------

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: [f32; 2],
    z2: [f32; 2],
}

impl Biquad {
    fn peaking(fs: f32, f0: f32, gain_db: f32, q: f32) -> Biquad {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * f0 / fs;
        let (s, c) = w0.sin_cos();
        let alpha = s / (2.0 * q);
        let a0 = 1.0 + alpha / a;
        Biquad { b0: (1.0 + alpha * a) / a0, b1: -2.0 * c / a0, b2: (1.0 - alpha * a) / a0, a1: -2.0 * c / a0, a2: (1.0 - alpha / a) / a0, z1: [0.0; 2], z2: [0.0; 2] }
    }
    #[inline]
    fn run(&mut self, ch: usize, x: f32) -> f32 {
        // transposed direct form II
        let y = self.b0 * x + self.z1[ch];
        self.z1[ch] = self.b1 * x - self.a1 * y + self.z2[ch];
        self.z2[ch] = self.b2 * x - self.a2 * y;
        y
    }
}

struct Eq {
    ver: u64,
    rate: u32,
    bands: Vec<Biquad>,
    pre: f32,
}

impl Eq {
    fn update(&mut self, sh: &Shared, rate: u32) {
        let v = sh.eq_ver.load(SeqCst);
        if v == self.ver && rate == self.rate {
            return;
        }
        self.ver = v;
        self.rate = rate;
        let (on, g) = *sh.eq.lock();
        self.bands.clear();
        if !on || g.iter().all(|x| x.abs() < 0.01) {
            self.pre = 1.0;
            return;
        }
        let maxg = g.iter().cloned().fold(0.0f32, f32::max);
        self.pre = 10f32.powf(-maxg * 0.8 / 20.0);
        for (i, f) in FREQS.iter().enumerate() {
            if g[i].abs() >= 0.01 && *f < rate as f32 * 0.45 {
                self.bands.push(Biquad::peaking(rate as f32, *f, g[i], 1.41));
            }
        }
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if self.bands.is_empty() {
            return;
        }
        for i in 0..l.len() {
            let (mut a, mut b) = (l[i] * self.pre, r[i] * self.pre);
            for bq in self.bands.iter_mut() {
                a = bq.run(0, a);
                b = bq.run(1, b);
            }
            l[i] = a;
            r[i] = b;
        }
    }
}

struct Cur {
    src: Source,
    rs: Option<FftFixedIn<f32>>,
    rs_skip: usize,
    in_l: Vec<f32>,
    in_r: Vec<f32>,
    in_total: u64,
    out_total: u64,
    ratio: f64,
    gain: f32,
    eof: bool,
    finished: bool,
    /// device-rate frames emitted so far / expected total (from the tag duration)
    emitted: u64,
    total: u64,
    album_id: i64,
}

fn rg_gain(it: &PlayItem, mode: u8) -> f32 {
    let (g, p) = match mode {
        1 => (it.rg_track.or(it.rg_album), it.rg_track_peak.or(it.rg_album_peak)),
        2 => (it.rg_album.or(it.rg_track), it.rg_album_peak.or(it.rg_track_peak)),
        _ => (None, None),
    };
    let Some(g) = g else {
        // no ReplayGain tags: the loudness measured in the background (crate::loudness), like on the phone
        let (l, pk) = match mode {
            1 => (it.lufs.or(it.album_lufs), it.peak.or(it.album_peak)),
            2 => (it.album_lufs.or(it.lufs), it.album_peak.or(it.peak)),
            _ => (None, None),
        };
        return l.map(|l| crate::loudness::gain(l, pk.unwrap_or(0.0))).unwrap_or(1.0);
    };
    let lin = 10f32.powf(g / 20.0);
    match p {
        Some(p) if p > 0.0 => lin.min(1.0 / p),
        _ => lin,
    }
}

fn open_cur(it: &PlayItem, pos: f64, dev_rate: u32, rg: u8) -> Result<Cur, OpenErr> {
    let mut src = Source::open(Path::new(&it.path))?;
    if pos > 0.05 {
        src.seek(pos);
    }
    let rs = if src.rate != dev_rate {
        FftFixedIn::<f32>::new(src.rate as usize, dev_rate as usize, 1024, 2, 2).ok()
    } else {
        None
    };
    let rs_skip = rs.as_ref().map(|r| r.output_delay()).unwrap_or(0);
    let ratio = dev_rate as f64 / src.rate as f64;
    let total = ((it.dur - pos).max(0.0) * dev_rate as f64) as u64;
    Ok(Cur { src, rs, rs_skip, in_l: Vec::new(), in_r: Vec::new(), in_total: 0, out_total: 0, ratio, gain: rg_gain(it, rg), eof: false, finished: false, emitted: 0, total, album_id: it.album_id })
}

impl Cur {
    /// Produce some device-rate stereo frames. Returns false when the track is completely drained.
    fn produce(&mut self, out_l: &mut Vec<f32>, out_r: &mut Vec<f32>) -> bool {
        if self.finished {
            return false;
        }
        let Some(rs) = self.rs.as_mut() else {
            let (a, b) = (out_l.len(), out_r.len());
            if !self.src.next(out_l, out_r) {
                self.finished = true;
                return false;
            }
            apply_gain(&mut out_l[a..], &mut out_r[b..], self.gain);
            self.emitted += (out_l.len() - a) as u64;
            return true;
        };
        let need = rs.input_frames_next();
        while !self.eof && self.in_l.len() < need {
            if !self.src.next(&mut self.in_l, &mut self.in_r) {
                self.eof = true;
            }
        }
        let ratio = self.ratio;
        let flushing = self.in_l.len() < need;
        let res = if !flushing {
            let r = rs.process(&[&self.in_l[..need], &self.in_r[..need]], None);
            self.in_l.drain(..need);
            self.in_r.drain(..need);
            self.in_total += need as u64;
            r
        } else {
            // EOF: flush remaining input + resampler delay with zero padding
            let have = self.in_l.len();
            self.in_total += have as u64;
            let mut l = std::mem::take(&mut self.in_l);
            let mut r = std::mem::take(&mut self.in_r);
            l.resize(need, 0.0);
            r.resize(need, 0.0);
            let expected = (self.in_total as f64 * ratio).round() as u64;
            if self.out_total >= expected {
                self.finished = true;
                return false;
            }
            rs.process(&[&l, &r], None)
        };
        let Ok(mut o) = res else {
            self.finished = true;
            return false;
        };
        let (mut ol, mut or_) = (std::mem::take(&mut o[0]), std::mem::take(&mut o[1]));
        if self.rs_skip > 0 {
            let k = self.rs_skip.min(ol.len());
            ol.drain(..k);
            or_.drain(..k);
            self.rs_skip -= k;
        }
        if flushing {
            let expected = (self.in_total as f64 * ratio).round() as u64;
            let left = expected.saturating_sub(self.out_total) as usize;
            ol.truncate(left);
            or_.truncate(left);
        }
        self.out_total += ol.len() as u64;
        self.emitted += ol.len() as u64;
        apply_gain(&mut ol, &mut or_, self.gain);
        out_l.extend_from_slice(&ol);
        out_r.extend_from_slice(&or_);
        true
    }
}

struct Analyser {
    fft: std::sync::Arc<dyn realfft::RealToComplex<f32>>,
    inp: Vec<f32>,
    out: Vec<realfft::num_complex::Complex<f32>>,
    win: Vec<f32>,
    edges: Vec<usize>,
    rate: u32,
}
impl Analyser {
    const N: usize = 1024;
    fn new(rate: u32) -> Analyser {
        let mut pl = realfft::RealFftPlanner::<f32>::new();
        let fft = pl.plan_fft_forward(Self::N);
        let win = (0..Self::N).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / Self::N as f32).cos()).collect();
        // log-spaced band edges 40 Hz .. 16 kHz
        let bin = |f: f32| ((f / rate as f32 * Self::N as f32) as usize).clamp(1, Self::N / 2);
        let edges = (0..=BANDS).map(|i| bin(40.0 * (16000.0f32 / 40.0).powf(i as f32 / BANDS as f32))).collect();
        Analyser { inp: fft.make_input_vec(), out: fft.make_output_vec(), fft, win, edges, rate }
    }
    fn run(&mut self, l: &[f32], r: &[f32]) -> [u8; BANDS] {
        let n = Self::N.min(l.len());
        for i in 0..Self::N {
            self.inp[i] = if i < n { (l[i] + r[i]) * 0.5 * self.win[i] } else { 0.0 };
        }
        let mut b = [0u8; BANDS];
        if self.fft.process(&mut self.inp, &mut self.out).is_err() {
            return b;
        }
        for k in 0..BANDS {
            let (a, e) = (self.edges[k], self.edges[k + 1].max(self.edges[k] + 1));
            let mut m = 0f32;
            for c in &self.out[a..e.min(self.out.len())] {
                m = m.max(c.norm());
            }
            let db = 20.0 * (m * 4.0 / Self::N as f32).max(1e-6).log10();
            b[k] = (((db + 60.0) / 60.0).clamp(0.0, 1.0) * 255.0) as u8;
        }
        b
    }
}

/// An in-progress transition into the next queue item.
struct Xf {
    next: Cur,
    len: u64,
    done: u64,
    mode: u8,
    bl: Vec<f32>,
    br: Vec<f32>,
    hp: [f32; 2], // outgoing low-pass state (for the high-pass sweep)
    lp: [f32; 2], // incoming low-pass state
}

fn smooth(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

impl Xf {
    /// Gains for outgoing / incoming at progress t (0..1).
    fn gains(&self, t: f32) -> (f32, f32) {
        use std::f32::consts::FRAC_PI_2;
        match self.mode {
            2 => (1.0 - t, t),
            3 => (1.0 - smooth(t / 0.55), smooth((t - 0.45) / 0.55)),
            4 => (if t < 0.7 { 1.0 } else { ((t - 0.7) / 0.3 * FRAC_PI_2).cos() }, smooth(t / 0.35)),
            _ => ((t * FRAC_PI_2).cos(), (t * FRAC_PI_2).sin()),
        }
    }
    /// Mix `b` (incoming) into `a` (outgoing) in place.
    fn mix(&mut self, al: &mut [f32], ar: &mut [f32], rate: f32) {
        let k = al.len();
        while self.bl.len() < k {
            if !self.next.produce(&mut self.bl, &mut self.br) {
                self.bl.resize(k, 0.0);
                self.br.resize(k, 0.0);
            }
        }
        let len = self.len.max(1) as f32;
        let tm = ((self.done as f32 + k as f32 * 0.5) / len).clamp(0.0, 1.0);
        let dj = self.mode == 4;
        // DJ mode: one-pole filters swept per block (bass out of the old track, highs into the new one)
        let coef = |fc: f32| 1.0 - (-2.0 * std::f32::consts::PI * fc / rate).exp();
        let (c_hp, c_lp) = if dj { (coef(20.0 * 60f32.powf(tm)), coef((250.0 * 80f32.powf(tm)).min(rate * 0.45))) } else { (0.0, 0.0) };
        for i in 0..k {
            let t = ((self.done + i as u64) as f32 / len).min(1.0);
            let (ga, gb) = self.gains(t);
            let (mut xl, mut xr, mut yl, mut yr) = (al[i], ar[i], self.bl[i], self.br[i]);
            if dj {
                self.hp[0] += c_hp * (xl - self.hp[0]);
                self.hp[1] += c_hp * (xr - self.hp[1]);
                xl -= self.hp[0];
                xr -= self.hp[1];
                self.lp[0] += c_lp * (yl - self.lp[0]);
                self.lp[1] += c_lp * (yr - self.lp[1]);
                yl = self.lp[0];
                yr = self.lp[1];
            }
            al[i] = xl * ga + yl * gb;
            ar[i] = xr * ga + yr * gb;
        }
        self.bl.drain(..k);
        self.br.drain(..k);
        self.done += k as u64;
    }
}

fn apply_gain(l: &mut [f32], r: &mut [f32], g: f32) {
    if (g - 1.0).abs() < 1e-4 {
        return;
    }
    for x in l.iter_mut().chain(r.iter_mut()) {
        *x *= g;
    }
}

fn decoder_thread(rx: Receiver<Cmd>, sh: Arc<Shared>, q: Arc<Mutex<Queue>>, ev: Arc<dyn Fn(Event) + Send + Sync>) {
    let mut prod: Option<Producer<f32>> = None;
    let mut dev_rate = 48000u32;
    let mut dev_ch = 2usize;
    let mut cur: Option<Cur> = None;
    let mut xf: Option<Xf> = None;
    let mut an: Option<Analyser> = None;
    let mut pending: Vec<f32> = Vec::new();
    let mut pend_off = 0usize;
    let mut produced: u64 = 0;
    let mut eq = Eq { ver: u64::MAX, rate: 0, bands: vec![], pre: 1.0 };
    let (mut tl, mut tr) = (Vec::<f32>::new(), Vec::<f32>::new());

    let flush = |prod: &Option<Producer<f32>>, sh: &Shared| {
        if prod.is_some() && sh.alive.load(SeqCst) {
            sh.flush.store(true, Release);
            let t0 = Instant::now();
            while sh.flush.load(Acquire) && t0.elapsed() < Duration::from_millis(300) {
                std::thread::sleep(Duration::from_micros(500));
            }
        }
        sh.flush.store(false, SeqCst);
        sh.markers.lock().clear();
        sh.levels.lock().clear();
        sh.played.store(0, SeqCst);
        sh.produced.store(0, SeqCst);
    };

    // opens queue item `qidx` (skipping unplayable ones) and records a marker
    let start = |qidx: usize, pos: f64, produced: u64, dev_rate: u32, cur: &mut Option<Cur>| -> bool {
        let mut i = qidx;
        let n = q.lock().items.len();
        for _ in 0..n.max(1) {
            let it = match q.lock().items.get(i).cloned() {
                Some(it) => it,
                None => return false,
            };
            match open_cur(&it, pos, dev_rate, sh.rg_mode.load(SeqCst)) {
                Ok(c) => {
                    *cur = Some(c);
                    q.lock().dec_idx = i;
                    sh.markers.lock().push_back(Marker { at: produced, qidx: i, track_id: it.id, offset: if i == qidx { pos } else { 0.0 } });
                    sh.done.store(false, SeqCst);
                    return true;
                }
                Err(e) => {
                    let (msg, missing) = match e {
                        OpenErr::NotFound => ("Файл не найден".to_string(), true),
                        OpenErr::Unsupported(s) => (format!("Не удалось открыть: {s}"), false),
                    };
                    ev(Event::Error { track_id: it.id, msg, missing });
                    match q.lock().auto_next(i) {
                        Some(nx) if nx != i => i = nx,
                        _ => return false,
                    }
                }
            }
        }
        false
    };

    loop {
        // commands
        let idle = cur.is_none() && pend_off >= pending.len();
        let cmd = if idle {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(c) => Some(c),
                Err(RecvTimeoutError::Timeout) => None,
                Err(_) => return,
            }
        } else {
            rx.try_recv().ok()
        };
        if let Some(cmd) = cmd {
            xf = None;
            match cmd {
                Cmd::Output(p, rate, ch) => {
                    // device changed: continue the playing track at the same position
                    let pos_now = current(&sh).map(|(m, p)| (m.qidx, p));
                    prod = Some(p);
                    dev_ch = ch;
                    let changed = rate != dev_rate;
                    dev_rate = rate;
                    sh.markers.lock().clear();
                    sh.levels.lock().clear();
                    sh.played.store(0, SeqCst);
                    pending.clear();
                    pend_off = 0;
                    produced = 0;
                    if let Some((qi, p)) = pos_now {
                        if cur.is_some() || changed {
                            cur = None;
                            start(qi, p, 0, dev_rate, &mut cur);
                        }
                    } else if cur.is_some() {
                        let qi = q.lock().dec_idx;
                        cur = None;
                        start(qi, 0.0, 0, dev_rate, &mut cur);
                    }
                }
                Cmd::Load { qidx, pos } => {
                    flush(&prod, &sh);
                    pending.clear();
                    pend_off = 0;
                    produced = 0;
                    cur = None;
                    if !start(qidx, pos, 0, dev_rate, &mut cur) {
                        sh.done.store(true, SeqCst);
                    }
                }
                Cmd::Requeue => {
                    // queue order changed: if the next track was already pre-buffered, drop it
                    let (dec, play) = { let qq = q.lock(); (qq.dec_idx, qq.play_idx) };
                    let ahead = sh.markers.lock().len() > 1 || dec != play;
                    if ahead {
                        if let Some((m, p)) = current(&sh) {
                            flush(&prod, &sh);
                            pending.clear();
                            pend_off = 0;
                            produced = 0;
                            cur = None;
                            start(m.qidx.min(q.lock().items.len().saturating_sub(1)), p, 0, dev_rate, &mut cur);
                        }
                    }
                }
                Cmd::Stop => {
                    flush(&prod, &sh);
                    pending.clear();
                    pend_off = 0;
                    produced = 0;
                    cur = None;
                    sh.done.store(true, SeqCst);
                    let qi = q.lock().play_idx;
                    let id = q.lock().items.get(qi).map(|x| x.id).unwrap_or(0);
                    sh.markers.lock().push_back(Marker { at: 0, qidx: qi, track_id: id, offset: 0.0 });
                }
            }
            continue;
        }
        let Some(p) = prod.as_mut() else {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        };
        // push pending samples
        if pend_off < pending.len() {
            let free = p.slots();
            let k = free.min(pending.len() - pend_off);
            if k == 0 {
                std::thread::sleep(Duration::from_millis(4));
                continue;
            }
            if let Ok(mut ch) = p.write_chunk_uninit(k) {
                let (a, b) = ch.as_mut_slices();
                let src = &pending[pend_off..pend_off + k];
                for (d, s) in a.iter_mut().zip(src) {
                    d.write(*s);
                }
                for (d, s) in b.iter_mut().zip(&src[a.len()..]) {
                    d.write(*s);
                }
                unsafe { ch.commit_all() };
            }
            pend_off += k;
            continue;
        }
        pending.clear();
        pend_off = 0;
        // produce more
        let Some(c) = cur.as_mut() else {
            sh.done.store(true, SeqCst);
            continue;
        };
        tl.clear();
        tr.clear();
        let mut more = c.produce(&mut tl, &mut tr);
        // start a transition when the tail of the track is reached
        let mode = sh.xf_mode.load(Relaxed);
        if xf.is_none() && mode != 0 && more {
            let len = (sh.xf_ms.load(Relaxed) as u64 * dev_rate as u64) / 1000;
            let remaining = c.total.saturating_sub(c.emitted);
            if len > 0 && remaining <= len && c.total > len * 2 {
                let (nx, item) = {
                    let qq = q.lock();
                    let nx = qq.auto_next(qq.dec_idx);
                    (nx, nx.filter(|&n| n != qq.dec_idx).and_then(|n| qq.items.get(n).cloned()))
                };
                if let (Some(nx), Some(it)) = (nx, item) {
                    let same = it.album_id == c.album_id && it.album_id != 0;
                    if !(same && sh.xf_keep_album.load(Relaxed)) {
                        if let Ok(n) = open_cur(&it, 0.0, dev_rate, sh.rg_mode.load(SeqCst)) {
                            q.lock().dec_idx = nx;
                            // the UI switches to the incoming track when the transition starts
                            sh.markers.lock().push_back(Marker { at: produced, qidx: nx, track_id: it.id, offset: 0.0 });
                            xf = Some(Xf { next: n, len: remaining.max(1), done: 0, mode, bl: Vec::new(), br: Vec::new(), hp: [0.0; 2], lp: [0.0; 2] });
                        }
                    }
                }
            }
        }
        if let Some(x) = xf.as_mut() {
            if tl.is_empty() {
                // outgoing track ended earlier than its tag duration: continue with silence
                tl.resize(1024, 0.0);
                tr.resize(1024, 0.0);
            }
            x.mix(&mut tl, &mut tr, dev_rate as f32);
            if x.done >= x.len {
                let x = xf.take().unwrap();
                tl.extend_from_slice(&x.bl);
                tr.extend_from_slice(&x.br);
                cur = Some(x.next);
            }
            more = true;
        }
        if !tl.is_empty() {
            eq.update(&sh, dev_rate);
            eq.process(&mut tl, &mut tr);
            if now_ms().saturating_sub(sh.viz_req.load(Relaxed)) < 1000 {
                let a = match an.as_mut() {
                    Some(a) if a.rate == dev_rate => a,
                    _ => an.insert(Analyser::new(dev_rate)),
                };
                let mut off = 0;
                let mut lv = sh.levels.lock();
                while off < tl.len() {
                    let e = (off + Analyser::N).min(tl.len());
                    let b = a.run(&tl[off..e], &tr[off..e]);
                    lv.push_back((produced + off as u64, b));
                    off = e;
                }
                while lv.len() > 256 {
                    lv.pop_front();
                }
            }
            pending.reserve(tl.len() * dev_ch);
            if dev_ch == 1 {
                pending.extend(tl.iter().zip(&tr).map(|(a, b)| (a + b) * 0.5));
            } else {
                for i in 0..tl.len() {
                    pending.push(tl[i]);
                    pending.push(tr[i]);
                    for _ in 2..dev_ch {
                        pending.push(0.0);
                    }
                }
            }
            produced += tl.len() as u64;
            sh.produced.store(produced, SeqCst);
        }
        if !more {
            // gapless: open the next item and keep filling the same stream
            cur = None;
            let next = { let qq = q.lock(); qq.auto_next(qq.dec_idx) };
            match next {
                Some(nx) => {
                    if !start(nx, 0.0, produced, dev_rate, &mut cur) {
                        sh.done.store(true, SeqCst);
                    }
                }
                None => sh.done.store(true, SeqCst),
            }
        }
    }
}

/// Test helper: run the real decoder pipeline into memory (no device, no underruns).
#[doc(hidden)]
pub fn render_offline(items: Vec<PlayItem>, rate: u32, eq: Option<[f32; 10]>, seek_after: Option<(usize, f64)>) -> (Vec<f32>, Vec<(u64, i64, f64)>) {
    let mut shv = Shared::new(rate, false);
    shv.volume = AtomicU32::new(1.0f32.to_bits());
    shv.done = AtomicBool::new(false);
    shv.eq = Mutex::new((eq.is_some(), eq.unwrap_or([0.0; 10])));
    shv.eq_ver = AtomicU64::new(1);
    shv.alive = AtomicBool::new(true);
    if let Ok(m) = std::env::var("TIDE_XF") {
        // "mode:ms", e.g. 1:4000
        let mut it = m.split(':');
        shv.xf_mode = AtomicU8::new(it.next().and_then(|x| x.parse().ok()).unwrap_or(1));
        shv.xf_ms = AtomicU32::new(it.next().and_then(|x| x.parse().ok()).unwrap_or(4000));
        shv.xf_keep_album = AtomicBool::new(false);
    }
    let sh = Arc::new(shv);
    let q = Arc::new(Mutex::new(Queue { items, orig: None, play_idx: 0, dec_idx: 0, repeat: Repeat::Off }));
    let (tx, rx) = unbounded::<Cmd>();
    let (prod, mut cons) = RingBuffer::<f32>::new(rate as usize * 2 * 3 / 10);
    {
        let (sh, q) = (sh.clone(), q.clone());
        std::thread::spawn(move || decoder_thread(rx, sh, q, Arc::new(|_| {})));
    }
    tx.send(Cmd::Output(prod, rate, 2)).unwrap();
    tx.send(Cmd::Load { qidx: 0, pos: 0.0 }).unwrap();
    let mut out = Vec::new();
    let mut marks = Vec::new();
    let mut sought = false;
    std::thread::sleep(Duration::from_millis(50));
    loop {
        if sh.flush.load(Acquire) {
            let n = cons.slots();
            if let Ok(c) = cons.read_chunk(n) {
                c.commit_all();
            }
            sh.flush.store(false, Release);
        }
        let n = cons.slots() & !1;
        if n > 0 {
            if let Ok(c) = cons.read_chunk(n) {
                let (a, b) = c.as_slices();
                out.extend_from_slice(a);
                out.extend_from_slice(b);
                c.commit_all();
            }
            sh.played.fetch_add((n / 2) as u64, SeqCst);
        }
        for m in sh.markers.lock().iter() {
            if !marks.iter().any(|x: &(u64, i64, f64)| x.0 == m.at && x.1 == m.track_id) {
                marks.push((m.at, m.track_id, m.offset));
            }
        }
        if let Some((frames, pos)) = seek_after {
            if !sought && (out.len() / 2) >= frames {
                sought = true;
                tx.send(Cmd::Load { qidx: 0, pos }).unwrap();
                std::thread::sleep(Duration::from_millis(30));
                continue;
            }
        }
        if n == 0 {
            if sh.done.load(SeqCst) && cons.slots() == 0 && sh.played.load(SeqCst) >= sh.produced.load(SeqCst) {
                std::thread::sleep(Duration::from_millis(30));
                if cons.slots() == 0 {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    (out, marks)
}
