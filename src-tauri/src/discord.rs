//! Discord Rich Presence over the local IPC pipe (no SDK, no network from our side).
//! Protocol: frames of [op u32 LE][len u32 LE][json]; op 0 = handshake, 1 = frame, 2 = close.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

#[cfg(windows)]
type Pipe = std::fs::File;
#[cfg(unix)]
type Pipe = std::os::unix::net::UnixStream;

fn connect() -> Option<Pipe> {
    for i in 0..10 {
        #[cfg(windows)]
        {
            let p = format!(r"\\.\pipe\discord-ipc-{i}");
            if let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).open(&p) {
                return Some(f);
            }
        }
        #[cfg(unix)]
        {
            let dirs = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"].iter().filter_map(|k| std::env::var(k).ok()).chain(std::iter::once("/tmp".to_string()));
            for d in dirs {
                if let Ok(s) = std::os::unix::net::UnixStream::connect(format!("{d}/discord-ipc-{i}")) {
                    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
                    return Some(s);
                }
            }
        }
    }
    None
}

fn send(p: &mut Pipe, op: u32, v: &Value) -> std::io::Result<Value> {
    let body = v.to_string().into_bytes();
    let mut buf = Vec::with_capacity(8 + body.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(body.len() as u32).to_le_bytes());
    buf.extend_from_slice(&body);
    p.write_all(&buf)?;
    p.flush()?;
    let mut h = [0u8; 8];
    p.read_exact(&mut h)?;
    let len = u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize;
    if len > 1 << 20 {
        return Err(std::io::Error::other("frame too large"));
    }
    let mut b = vec![0u8; len];
    p.read_exact(&mut b)?;
    Ok(serde_json::from_slice(&b).unwrap_or(Value::Null))
}

pub enum Msg {
    /// client id + activity (None = clear)
    Set(String, Option<Value>),
    Stop,
}

#[derive(Clone)]
pub struct Rpc {
    tx: Sender<Msg>,
    pub status: std::sync::Arc<parking_lot::Mutex<String>>,
}

impl Rpc {
    pub fn start() -> Rpc {
        let (tx, rx) = channel::<Msg>();
        let status = std::sync::Arc::new(parking_lot::Mutex::new("Выключено".to_string()));
        let st = status.clone();
        std::thread::Builder::new()
            .name("tide-discord".into())
            .spawn(move || {
                crate::prio::background();
                let mut pipe: Option<(Pipe, String)> = None;
                let mut want: Option<(String, Option<Value>)> = None;
                let mut sent: Option<Value> = None;
                let mut last_send = Instant::now() - Duration::from_secs(60);
                let mut last_try = Instant::now() - Duration::from_secs(60);
                loop {
                    // coalesce bursts (play/pause spam); Discord allows ~5 updates / 20 s
                    let timeout = if want.is_some() && pipe.is_none() { Duration::from_secs(15) } else { Duration::from_millis(1500) };
                    match rx.recv_timeout(timeout) {
                        Ok(Msg::Set(id, a)) => {
                            want = Some((id, a));
                            while let Ok(m) = rx.try_recv() {
                                match m {
                                    Msg::Set(id, a) => want = Some((id, a)),
                                    Msg::Stop => want = None,
                                }
                            }
                            std::thread::sleep(Duration::from_millis(400));
                            continue_after_drain(&rx, &mut want);
                        }
                        Ok(Msg::Stop) => {
                            want = None;
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(_) => return,
                    }
                    let Some((id, act)) = want.clone() else {
                        if pipe.is_some() {
                            pipe = None; // dropping the pipe clears the presence
                            sent = None;
                            *st.lock() = "Выключено".into();
                        }
                        continue;
                    };
                    if id.trim().is_empty() {
                        *st.lock() = "Укажите Application ID".into();
                        continue;
                    }
                    if pipe.as_ref().map(|p| p.1 != id).unwrap_or(false) {
                        pipe = None;
                        sent = None;
                    }
                    if pipe.is_none() {
                        if last_try.elapsed() < Duration::from_secs(10) {
                            continue;
                        }
                        last_try = Instant::now();
                        match connect() {
                            Some(mut p) => match send(&mut p, 0, &json!({ "v": 1, "client_id": id })) {
                                Ok(r) if r["evt"] == "READY" => {
                                    let user = r["data"]["user"]["global_name"].as_str().or(r["data"]["user"]["username"].as_str()).unwrap_or("").to_string();
                                    *st.lock() = if user.is_empty() { "Подключено".into() } else { format!("Подключено · {user}") };
                                    pipe = Some((p, id.clone()));
                                }
                                Ok(r) => {
                                    *st.lock() = format!("Discord отклонил подключение: {}", r["data"]["message"].as_str().unwrap_or("неверный Application ID?"));
                                    continue;
                                }
                                Err(_) => {
                                    *st.lock() = "Discord не отвечает".into();
                                    continue;
                                }
                            },
                            None => {
                                *st.lock() = "Discord не запущен".into();
                                continue;
                            }
                        }
                    }
                    if sent.as_ref() == Some(&act.clone().unwrap_or(Value::Null)) {
                        continue;
                    }
                    let wait = Duration::from_secs(4).saturating_sub(last_send.elapsed());
                    if !wait.is_zero() {
                        std::thread::sleep(wait);
                        continue_after_drain(&rx, &mut want);
                    }
                    let act = want.as_ref().and_then(|w| w.1.clone());
                    let frame = json!({
                        "cmd": "SET_ACTIVITY",
                        "args": { "pid": std::process::id(), "activity": act.clone().unwrap_or(Value::Null) },
                        "nonce": format!("{:x}", fastrand::u64(..)),
                    });
                    let (p, _) = pipe.as_mut().unwrap();
                    match send(p, 1, &frame) {
                        Ok(r) if r["evt"] == "ERROR" => {
                            *st.lock() = format!("Ошибка Discord: {}", r["data"]["message"].as_str().unwrap_or("?"));
                            sent = Some(act.unwrap_or(Value::Null));
                        }
                        Ok(_) => {
                            sent = Some(act.unwrap_or(Value::Null));
                            last_send = Instant::now();
                        }
                        Err(_) => {
                            pipe = None;
                            sent = None;
                            *st.lock() = "Соединение с Discord потеряно — переподключение…".into();
                            last_try = Instant::now() - Duration::from_secs(60);
                        }
                    }
                }
            })
            .ok();
        Rpc { tx, status }
    }
    pub fn set(&self, client_id: &str, activity: Option<Value>) {
        let _ = self.tx.send(Msg::Set(client_id.to_string(), activity));
    }
    pub fn stop(&self) {
        let _ = self.tx.send(Msg::Stop);
    }
}

fn continue_after_drain(rx: &std::sync::mpsc::Receiver<Msg>, want: &mut Option<(String, Option<Value>)>) {
    while let Ok(m) = rx.try_recv() {
        match m {
            Msg::Set(id, a) => *want = Some((id, a)),
            Msg::Stop => *want = None,
        }
    }
}
