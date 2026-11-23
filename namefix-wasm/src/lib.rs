//! Thin C-ABI wrapper around the very same `namefix.rs` the desktop scanner uses.
//! Strings travel through one shared byte buffer; fields are separated by U+001F.
#[path = "../../src-tauri/src/namefix.rs"]
#[allow(dead_code)]
mod namefix;

use namefix::{Confidence, Input, Known, Origin};
use std::cell::RefCell;

thread_local! {
    static BUF: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static OUT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static KNOWN: RefCell<Known> = RefCell::new(Known::new());
}

const SEP: char = '\u{1f}';

fn input() -> String { BUF.with(|b| String::from_utf8_lossy(&b.borrow()).into_owned()) }
fn output(s: String) -> usize { OUT.with(|o| { let mut o = o.borrow_mut(); *o = s.into_bytes(); o.len() }) }

/// Make room for `len` input bytes and return where JS should write them.
#[no_mangle]
pub extern "C" fn nf_buf(len: usize) -> *mut u8 { BUF.with(|b| { let mut b = b.borrow_mut(); b.clear(); b.resize(len, 0); b.as_mut_ptr() }) }
#[no_mangle]
pub extern "C" fn nf_out() -> *const u8 { OUT.with(|o| o.borrow().as_ptr()) }

#[no_mangle]
pub extern "C" fn nf_reset() { KNOWN.with(|k| *k.borrow_mut() = Known::new()) }

#[no_mangle]
pub extern "C" fn nf_artists() -> usize { KNOWN.with(|k| k.borrow().artist_count()) }

/// "artist␟title␟album␟weight"
#[no_mangle]
pub extern "C" fn nf_add_track() {
    let s = input();
    let p: Vec<&str> = s.split(SEP).collect();
    if p.len() < 3 { return; }
    let w = p.get(3).and_then(|x| x.parse().ok()).unwrap_or(1);
    KNOWN.with(|k| k.borrow_mut().add_track(p[0], p[1], p[2], w));
}

/// "from␟to"
#[no_mangle]
pub extern "C" fn nf_add_alias() {
    let s = input();
    if let Some((a, b)) = s.split_once(SEP) { KNOWN.with(|k| k.borrow_mut().add_alias(a, b)); }
}

/// in: "stem␟title␟artist␟album␟album_artist"
/// out: "title␟artist␟album␟album_artist␟track_no␟confidence␟origin␟swapped"
#[no_mangle]
pub extern "C" fn nf_resolve() -> usize {
    let s = input();
    let p: Vec<&str> = s.split(SEP).collect();
    let g = |i: usize| p.get(i).copied().unwrap_or("");
    let inp = Input { stem: g(0), title: g(1), artist: g(2), album: g(3), album_artist: g(4) };
    let o = KNOWN.with(|k| namefix::resolve(&inp, &k.borrow()));
    let conf = match o.confidence { Confidence::Guess => 0, Confidence::Medium => 1, Confidence::High => 2 };
    let origin = match o.origin { Origin::Tags => "tags", Origin::TagsCleaned => "cleaned", Origin::FileName => "file" };
    output([o.title, o.artist, o.album, o.album_artist, o.track_no.to_string(), conf.to_string(), origin.into(), (o.swapped as u8).to_string()].join("\u{1f}"))
}

/// in: "title␟artist␟album" → 1 if the stored names look like they need a re-parse
#[no_mangle]
pub extern "C" fn nf_dirty() -> u32 {
    let s = input();
    let p: Vec<&str> = s.split(SEP).collect();
    let g = |i: usize| p.get(i).copied().unwrap_or("");
    namefix::looks_dirty(g(0), g(1), g(2)) as u32
}

/// Normalized comparison key (ё/е, case, translit).
#[no_mangle]
pub extern "C" fn nf_key() -> usize { output(namefix::key(&input())) }
