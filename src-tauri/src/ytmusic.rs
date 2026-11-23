//! "Download" button on the desktop: finds the song on YouTube Music and downloads its audio with yt-dlp into
//! `<Music>/Teto Downloads` (added to the library folders). yt-dlp.exe is fetched from its GitHub releases on first
//! use (and refreshed every two weeks) into the app data folder; a yt-dlp found in PATH is used as a fallback.
//! Optional: `--cookies-from-browser <browser>` (Settings → Download) for when YouTube asks to sign in.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

#[cfg(windows)]
const EXE: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const EXE: &str = "yt-dlp";
#[cfg(windows)]
const URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(target_os = "macos")]
const URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
#[cfg(all(not(windows), not(target_os = "macos")))]
const URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

/// Player clients tried in turn when YouTube refuses one (same idea as the bot this feature is based on).
const CLIENTS: [&str; 4] = ["", "youtube:player_client=tv,web_safari", "youtube:player_client=android", "youtube:player_client=ios"];

pub fn downloads_dir() -> PathBuf {
    dirs::audio_dir().or_else(dirs::download_dir).unwrap_or_else(|| crate::paths::root().clone()).join("Teto Downloads")
}

fn bin_path() -> PathBuf {
    crate::paths::root().join("bin").join(EXE)
}

fn fetch_bin(dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst.parent().unwrap()).map_err(|e| e.to_string())?;
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout(Duration::from_secs(300)).build();
    let resp = agent.get(URL).call().map_err(|e| format!("yt-dlp: {e}"))?;
    let tmp = dst.with_extension("part");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let n = std::io::copy(&mut resp.into_reader(), &mut f).map_err(|e| e.to_string())?;
    drop(f);
    if n < 1_000_000 {
        let _ = std::fs::remove_file(&tmp);
        return Err("yt-dlp: download is too small".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&tmp, dst).map_err(|e| e.to_string())
}

/// Path to a working yt-dlp (downloads it when missing; refreshes a copy older than 14 days, keeping the old one on failure).
pub fn ensure() -> Result<PathBuf, String> {
    let p = bin_path();
    if p.exists() {
        let old = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).map_or(false, |d| d > Duration::from_secs(14 * 86400));
        if old {
            let _ = fetch_bin(&p);
        }
        return Ok(p);
    }
    match fetch_bin(&p) {
        Ok(()) => Ok(p),
        Err(e) => {
            // yt-dlp installed by the user
            if Command::new(EXE).arg("--version").output().map_or(false, |o| o.status.success()) {
                Ok(PathBuf::from(EXE))
            } else {
                Err(e)
            }
        }
    }
}

fn cmd(bin: &Path, browser: &str, client: &str) -> Command {
    let mut c = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c.args(["--no-warnings", "--no-playlist", "--socket-timeout", "25", "--encoding", "utf-8"]);
    if !browser.is_empty() {
        c.args(["--cookies-from-browser", browser]);
    }
    if !client.is_empty() {
        c.args(["--extractor-args", client]);
    }
    c
}

fn run(mut c: Command) -> Result<String, String> {
    let o = c.output().map_err(|e| e.to_string())?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&o.stderr);
        Err(err.lines().filter(|l| l.contains("ERROR")).last().unwrap_or(err.trim()).chars().take(300).collect())
    }
}

fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn items(json: &str, song: bool) -> Vec<Value> {
    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    let mut out = vec![];
    for e in v["entries"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let id = e["id"].as_str().unwrap_or("");
        let url = e["url"].as_str().map(str::to_string).unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));
        if id.is_empty() && url.is_empty() {
            continue;
        }
        let artist = e["artists"].as_array().and_then(|a| a.first()).and_then(|x| x.as_str())
            .or_else(|| e["artist"].as_str()).or_else(|| e["channel"].as_str()).or_else(|| e["uploader"].as_str()).unwrap_or("");
        let artist = artist.trim_end_matches(" - Topic");
        out.push(json!({ "artist": artist, "title": e["title"].as_str().unwrap_or(""), "url": url, "dur": e["duration"].as_f64().unwrap_or(0.0), "song": song }));
    }
    out
}

/// YouTube Music songs for the query (falls back to an ordinary YouTube search). The UI picks the best match.
pub fn search(q: &str, browser: &str) -> Result<Vec<Value>, String> {
    let bin = ensure()?;
    let mut out = vec![];
    let mut err = String::new();
    for (target, song) in [(format!("https://music.youtube.com/search?q={}#songs", enc(q)), true), (format!("ytsearch10:{q}"), false)] {
        let mut c = cmd(&bin, browser, "");
        c.args(["-J", "--flat-playlist", "--playlist-end", "10", &target]);
        match run(c) {
            Ok(j) => out.extend(items(&j, song)),
            Err(e) => err = e,
        }
    }
    if out.is_empty() && !err.is_empty() {
        return Err(err);
    }
    Ok(out)
}

pub fn sanitize(name: &str) -> String {
    let s: String = name.chars().map(|c| if r#"<>:"/\|?*%"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let s = s.trim().trim_end_matches('.').chars().take(120).collect::<String>();
    if s.is_empty() { "track".to_string() } else { s }
}

/// What a finished download gives back (names as yt-dlp knew them — used when the caller had none, e.g. a plain link).
pub struct Done {
    pub path: PathBuf,
    pub title: String,
    pub artist: String,
    pub album: String,
}

type Running = Mutex<HashMap<String, Arc<Mutex<Option<Child>>>>>;
fn running() -> &'static Running {
    static R: OnceLock<Running> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cancelled() -> &'static Mutex<HashSet<String>> {
    static C: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashSet::new()))
}
/// "✕" on a download (ported from the phone): stops the yt-dlp process of this job.
pub fn cancel(id: &str) {
    cancelled().lock().unwrap().insert(id.to_string());
    if let Some(c) = running().lock().unwrap().get(id).cloned() {
        if let Some(ch) = c.lock().unwrap().as_mut() {
            let _ = ch.kill();
        }
    }
}

pub fn allowed(url: &str) -> bool {
    ["https://www.youtube.com/", "https://music.youtube.com/", "https://youtu.be/", "https://m.youtube.com/", "https://youtube.com/", "https://soundcloud.com/", "https://m.soundcloud.com/", "https://on.soundcloud.com/"]
        .iter()
        .any(|p| url.starts_with(p))
}

/// "TETO <downloaded> <total> <estimate>" → 0…1
fn parse_progress(l: &str) -> Option<f64> {
    let mut it = l.strip_prefix("TETO ")?.split_whitespace().map(|x| x.parse::<f64>().ok());
    let d = it.next()??;
    let t = it.next().flatten().or_else(|| it.next().flatten())?;
    (t > 0.0).then(|| (d / t).clamp(0.0, 1.0))
}

/// Downloads the audio (m4a when available — no ffmpeg needed) into the Teto Downloads folder.
/// `progress(fraction)` is called while yt-dlp reports progress; `id` lets [`cancel`] stop it.
pub fn download(url: &str, artist: &str, title: &str, browser: &str, id: &str, progress: &(dyn Fn(f64) + Sync)) -> Result<Done, String> {
    if !allowed(url) {
        return Err("not a YouTube / SoundCloud address".into());
    }
    let bin = ensure()?;
    let dir = downloads_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let named = !title.is_empty();
    let base = sanitize(&if artist.is_empty() { title.to_string() } else { format!("{artist} - {title}") });
    let mut stem = base.clone();
    let mut n = 2;
    while named && ["m4a", "webm", "opus", "mp3"].iter().any(|x| dir.join(format!("{stem}.{x}")).exists()) {
        stem = format!("{base} ({n})");
        n += 1;
    }
    // a plain link: let yt-dlp name the file after the video
    let tpl = if named { dir.join(format!("{stem}.%(ext)s")) } else { dir.join("%(artist,creator,uploader)s - %(track,title)s.%(ext)s") }.to_string_lossy().into_owned();
    cancelled().lock().unwrap().remove(id);
    let mut err = String::new();
    for client in CLIENTS {
        let mut c = cmd(&bin, browser, client);
        c.args(["-f", "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio", "--no-part", "--no-mtime", "--windows-filenames", "--no-overwrites", "-o", &tpl])
            .args(["--progress", "--newline", "--progress-template", "download:TETO %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s"])
            .args(["--print", "after_move:TETOMETA %(artist,creator,uploader)s ||| %(track,title)s ||| %(album)s", "--print", "after_move:filepath", url])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = c.spawn().map_err(|e| e.to_string())?;
        let (out, er) = (child.stdout.take(), child.stderr.take());
        let slot = Arc::new(Mutex::new(Some(child)));
        running().lock().unwrap().insert(id.to_string(), slot.clone());
        let mut lines: Vec<String> = Vec::new();
        let mut errs: Vec<String> = Vec::new();
        std::thread::scope(|sc| {
            let h = sc.spawn(|| {
                let mut e = Vec::new();
                if let Some(er) = er {
                    for l in BufReader::new(er).lines().map_while(Result::ok) {
                        if let Some(p) = parse_progress(l.trim()) {
                            progress(p);
                        } else if !l.trim().is_empty() {
                            e.push(l);
                        }
                    }
                }
                e
            });
            if let Some(out) = out {
                for l in BufReader::new(out).lines().map_while(Result::ok) {
                    if let Some(p) = parse_progress(l.trim()) {
                        progress(p);
                    } else if !l.trim().is_empty() {
                        lines.push(l.trim().to_string());
                    }
                }
            }
            errs = h.join().unwrap_or_default();
        });
        let ok = slot.lock().unwrap().take().map(|mut ch| ch.wait().map(|s| s.success()).unwrap_or(false)).unwrap_or(false);
        running().lock().unwrap().remove(id);
        if cancelled().lock().unwrap().remove(id) {
            return Err("Отменено".into());
        }
        if !ok {
            err = errs.iter().filter(|l| l.contains("ERROR")).last().or(errs.last()).map(|s| s.chars().take(300).collect()).unwrap_or_else(|| "yt-dlp error".into());
            continue;
        }
        let (mut ma, mut mt, mut mal) = (String::new(), String::new(), String::new());
        let mut path: Option<PathBuf> = None;
        for l in &lines {
            if let Some(m) = l.strip_prefix("TETOMETA ") {
                let p: Vec<&str> = m.split(" ||| ").collect();
                let clean = |s: Option<&&str>| s.map(|x| x.trim()).filter(|x| *x != "NA").unwrap_or("").to_string();
                ma = clean(p.first()).trim_end_matches(" - Topic").to_string();
                mt = clean(p.get(1));
                mal = clean(p.get(2));
            } else {
                let p = PathBuf::from(l);
                if p.exists() {
                    path = Some(p);
                }
            }
        }
        let path = path.or_else(|| ["m4a", "mp3", "webm", "opus"].iter().map(|x| dir.join(format!("{stem}.{x}"))).find(|p| p.exists()));
        match path {
            Some(path) => return Ok(Done { path, title: mt, artist: ma, album: mal }),
            None => err = "file not found".into(),
        }
    }
    Err(err)
}

/// Square cover for a downloaded song (ported from the phone): the result's picture (YouTube Music / SoundCloud),
/// or the video's own thumbnail; black letterbox bars are cut, the centre square is kept, JPEG ≤ 600 px.
pub fn square_cover(thumb: &str, url: &str) -> Option<Vec<u8>> {
    let mut urls: Vec<String> = Vec::new();
    if thumb.starts_with("https://") {
        urls.push(thumb.to_string());
    }
    if let Some(id) = video_id(url) {
        urls.push(format!("https://i.ytimg.com/vi/{id}/maxresdefault.jpg"));
        urls.push(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"));
    }
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(8)).timeout(Duration::from_secs(20)).build();
    for u in urls {
        let Ok(r) = agent.get(&u).call() else { continue };
        let mut buf = Vec::new();
        if r.into_reader().take(12 << 20).read_to_end(&mut buf).is_err() {
            continue;
        }
        let Ok(img) = image::load_from_memory(&buf) else { continue };
        if let Some(j) = square_jpeg(img) {
            return Some(j);
        }
    }
    None
}

fn square_jpeg(img: image::DynamicImage) -> Option<Vec<u8>> {
    let rgb = img.to_rgb8();
    let (w, h) = rgb.dimensions();
    if w < 32 || h < 32 {
        return None;
    }
    let dark = |y: u32| (0..w).step_by(4).map(|x| { let p = rgb.get_pixel(x, y); p[0] as u32 + p[1] as u32 + p[2] as u32 }).sum::<u32>() / ((w + 3) / 4) < 3 * 18;
    let (mut top, mut bot) = (0, h);
    while top < h / 3 && dark(top) {
        top += 1;
    }
    while bot > h * 2 / 3 && dark(bot - 1) {
        bot -= 1;
    }
    let ch = bot - top;
    let side = w.min(ch);
    let x0 = (w - side) / 2;
    let y0 = top + (ch - side) / 2;
    let sq = image::DynamicImage::ImageRgb8(rgb).crop_imm(x0, y0, side, side);
    let sq = if side > 600 { sq.resize_exact(600, 600, image::imageops::FilterType::CatmullRom) } else { sq };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&sq.to_rgb8()).ok()?;
    Some(out)
}

pub fn video_id(url: &str) -> Option<String> {
    for k in ["v=", "youtu.be/", "shorts/", "embed/"] {
        if let Some(i) = url.find(k) {
            let id: String = url[i + k.len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
            if id.len() == 11 {
                return Some(id);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_and_parsing() {
        assert_eq!(sanitize("AC/DC - T.N.T."), "AC_DC - T.N.T");
        assert_eq!(enc("a b&c"), "a%20b%26c");
        let j = r#"{"entries":[{"id":"x1","url":"https://music.youtube.com/watch?v=x1","title":"Song","channel":"Band - Topic","duration":200}]}"#;
        let v = items(j, true);
        assert_eq!(v[0]["artist"], "Band");
        assert_eq!(v[0]["dur"], 200.0);
        assert_eq!(parse_progress("TETO 50 100 NA"), Some(0.5));
        assert_eq!(parse_progress("TETO 25 NA 100"), Some(0.25));
        assert_eq!(parse_progress("TETO 25 NA NA"), None);
        assert_eq!(video_id("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(video_id("https://youtu.be/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert!(allowed("https://on.soundcloud.com/abc") && !allowed("https://evil.example/"));
        // letterboxed 4:3 thumbnail → the picture without the bars
        let mut im = image::RgbImage::new(480, 360);
        for (_, y, p) in im.enumerate_pixels_mut() { *p = if (45..315).contains(&y) { image::Rgb([200, 120, 40]) } else { image::Rgb([0, 0, 0]) }; }
        let j = square_jpeg(image::DynamicImage::ImageRgb8(im)).unwrap();
        let back = image::load_from_memory(&j).unwrap().to_rgb8();
        assert_eq!(back.dimensions(), (270, 270));
        assert!(back.get_pixel(135, 2)[0] > 150, "no black bar left");
    }
}
