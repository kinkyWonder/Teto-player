//! Developer CLI for testing the core without the UI:
//!   tide-cli scan <folder>        scan into the DB at $TIDE_DATA
//!   tide-cli list                 albums
//!   tide-cli search <q>
//!   tide-cli play <file|id...>    play through the audio engine (gapless)
//!   tide-cli analyze <file>
//!   tide-cli lyrics <artist> <title> [album] [dur]
use std::sync::Arc;
use tide_lib::{audio, db::Db, dsp, lyrics, paths, scan};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let db = Arc::new(Db::open(&paths::db()).expect("db"));
    tide_lib::namefix_db::migrate(&db).expect("namefix migrate");
    match args.first().map(|s| s.as_str()) {
        Some("scan") => {
            for f in &args[1..] {
                db.add_folder(&std::fs::canonicalize(f).unwrap().to_string_lossy()).unwrap();
            }
            let (tx, rx) = std::sync::mpsc::channel();
            let s = scan::Scanner::new(db.clone(), Box::new(move |st, ch| {
                if st.state != "scanning" {
                    let _ = tx.send(ch);
                }
            }));
            s.start();
            let ch = rx.recv().unwrap();
            println!("changed={ch} {:?}", db.stats());
        }
        Some("list") => {
            for a in db.albums("artist") {
                println!("{:>4} {} — {} ({}) [{}] {} tracks, cover={:?} {}", a.id, a.artist, a.title, a.year, a.genre, a.tracks, a.cover, a.cover_name);
            }
        }
        Some("tracks") => {
            let id: i64 = args[1].parse().unwrap();
            for t in db.album_tracks(id) {
                println!("{} {:>2} {} — {} {:.1}s {} {}/{} {}kbps lossless={}", t.id, t.no, t.artist, t.title, t.dur, t.codec, t.bits, t.rate, t.kbps, t.lossless);
            }
        }
        Some("search") => {
            let t0 = std::time::Instant::now();
            let (t, a, r) = db.search(&args[1..].join(" "));
            println!("{} tracks, {} albums, {} artists in {:?}", t.len(), a.len(), r.len(), t0.elapsed());
            for x in t.iter().take(5) {
                println!("  {} — {}", x.artist, x.title);
            }
        }
        Some("analyze") => {
            let f = dsp::analyze(std::path::Path::new(&args[1]), args.get(2).and_then(|x| x.parse().ok()).unwrap_or(180.0));
            println!("{f:?}");
        }
        Some("lyrics") => {
            let dur = args.get(4).and_then(|x| x.parse().ok()).unwrap_or(0.0);
            match lyrics::lrclib_get(&args[1], &args[2], args.get(3).map(|s| s.as_str()).unwrap_or(""), dur) {
                Ok(l) => println!("{} {} lines, first: {:?}", l.kind, l.lines.len(), l.lines.first()),
                Err(lyrics::NetErr::NotFound) => println!("not found"),
                Err(lyrics::NetErr::Network(e)) => println!("network: {e}"),
            }
        }
        Some("play") => {
            let items: Vec<_> = args[1..]
                .iter()
                .map(|a| match a.parse::<i64>() {
                    Ok(id) => db.play_items(&[id]).remove(0),
                    Err(_) => tide_lib::db::PlayItem { id: 0, path: a.clone(), ..Default::default() },
                })
                .collect();
            let p = audio::Player::new(|e| println!("event: {e:?}"), String::new());
            std::thread::sleep(std::time::Duration::from_millis(500));
            println!("output alive: {}", p.alive());
            p.load(items, 0, 0.0, true, false);
            std::thread::sleep(std::time::Duration::from_secs(args.len() as u64 * 2 + 2));
        }
        Some("render") => {
            // tide-cli render <out.raw> <rate> files...
            let rate: u32 = args[2].parse().unwrap();
            let items: Vec<_> = args[3..].iter().enumerate().map(|(i, a)| {
                let mut it = tide_lib::db::PlayItem { id: i as i64 + 1, path: a.clone(), ..Default::default() };
                if let Some(m) = tide_lib::tags::read(std::path::Path::new(a)) { it.rg_track = m.rg_track; it.dur = m.dur; }
                it
            }).collect();
            let t0 = std::time::Instant::now();
            let eq = std::env::var("EQ").ok().map(|s| { let mut b = [0f32; 10]; for (i, x) in s.split(',').enumerate() { b[i] = x.parse().unwrap(); } b });
            let seek = std::env::var("SEEK").ok().map(|s| { let (a, b) = s.split_once(':').unwrap(); (a.parse().unwrap(), b.parse().unwrap()) });
            let (out, marks) = audio::render_offline(items, rate, eq, seek);
            println!("rendered {} frames ({:.2}s) in {:?}; markers {:?}", out.len() / 2, out.len() as f64 / 2.0 / rate as f64, t0.elapsed(), marks);
            let bytes: Vec<u8> = out.iter().flat_map(|x| x.to_le_bytes()).collect();
            std::fs::write(&args[1], bytes).unwrap();
        }
        _ => eprintln!("usage: tide-cli scan|list|tracks|search|analyze|lyrics|play"),
    }
}
