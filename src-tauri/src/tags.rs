//! Tag reading/writing via lofty.
use crate::db::Meta;
use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::{AudioFile, FileType, TaggedFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag};
use std::path::Path;

pub const AUDIO_EXT: &[&str] = &["flac", "wav", "wave", "aif", "aiff", "aifc", "mp3", "m4a", "mp4", "aac", "alac", "ogg", "oga", "opus"];

pub fn is_audio(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| AUDIO_EXT.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

fn open(path: &Path, props: bool) -> Option<TaggedFile> {
    Probe::open(path).ok()?.options(ParseOptions::new().read_properties(props)).guess_file_type().ok()?.read().ok()
}

fn parse_gain(s: &str) -> Option<f32> {
    s.trim().trim_end_matches(|c: char| c.is_alphabetic() || c == ' ').trim().replace(',', ".").parse().ok()
}

fn tag_of(tf: &TaggedFile) -> Option<&Tag> {
    tf.primary_tag().or_else(|| tf.first_tag())
}

/// Чтение тегов + разбор имени файла без индекса библиотеки (CLI, одиночные файлы).
/// Сканер использует `read_raw` + `namefix_db::Ctx::apply`, чтобы сверяться с уже добавленными исполнителями.
pub fn read(path: &Path) -> Option<Meta> {
    let mut m = read_raw(path)?;
    crate::namefix_db::finalize_one(&mut m);
    Some(m)
}

/// Только то, что реально записано в файле: пустые title/artist/album НЕ заменяются заглушками —
/// это делает `namefix` (он же вытаскивает исполнителя и название из имени файла).
pub fn read_raw(path: &Path) -> Option<Meta> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
    let mut m = Meta { path: path.to_string_lossy().into_owned(), mtime, size: md.len() as i64, ..Default::default() };
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();

    match open(path, true) {
        Some(tf) => {
            let p = tf.properties();
            m.dur = p.duration().as_secs_f64();
            m.rate = p.sample_rate().unwrap_or(0);
            m.bits = p.bit_depth().unwrap_or(0) as u32;
            m.channels = p.channels().unwrap_or(2) as u32;
            m.kbps = p.audio_bitrate().unwrap_or(0);
            let (codec, lossless) = match tf.file_type() {
                FileType::Flac => ("FLAC", true),
                FileType::Wav => ("WAV", true),
                FileType::Aiff => ("AIFF", true),
                FileType::Mpeg => ("MP3", false),
                FileType::Mp4 => {
                    if m.bits > 0 { ("ALAC", true) } else { ("AAC", false) }
                }
                FileType::Aac => ("AAC", false),
                FileType::Opus => ("OPUS", false),
                FileType::Vorbis => ("OGG", false),
                FileType::WavPack => ("WV", true),
                FileType::Ape => ("APE", true),
                _ => ("?", false),
            };
            m.codec = codec.into();
            m.lossless = lossless;
            if lossless && m.bits == 0 {
                m.bits = 16;
            }
            if let Some(t) = tag_of(&tf) {
                m.title = t.title().map(|s| s.trim().to_string()).unwrap_or_default();
                m.artist = t.artist().map(|s| s.trim().to_string()).unwrap_or_default();
                m.album = t.album().map(|s| s.trim().to_string()).unwrap_or_default();
                m.genre = t.genre().map(|s| s.trim().to_string()).unwrap_or_default();
                m.album_artist = t.get_string(&ItemKey::AlbumArtist).map(|s| s.trim().to_string()).unwrap_or_default();
                m.no = t.track().unwrap_or(0);
                m.disc = t.disk().unwrap_or(1);
                m.year = t.year().unwrap_or(0);
                if m.year == 0 {
                    if let Some(d) = t.get_string(&ItemKey::RecordingDate).or_else(|| t.get_string(&ItemKey::OriginalReleaseDate)) {
                        m.year = d.get(..4).and_then(|y| y.parse().ok()).unwrap_or(0);
                    }
                }
                m.rg_track = t.get_string(&ItemKey::ReplayGainTrackGain).and_then(parse_gain);
                m.rg_album = t.get_string(&ItemKey::ReplayGainAlbumGain).and_then(parse_gain);
                m.rg_track_peak = t.get_string(&ItemKey::ReplayGainTrackPeak).and_then(parse_gain);
                m.rg_album_peak = t.get_string(&ItemKey::ReplayGainAlbumPeak).and_then(parse_gain);
            }
            m.has_pic = tf.tags().iter().any(|t| !t.pictures().is_empty());
        }
        None => {
            m.codec = ext.to_uppercase();
        }
    }
    if m.disc == 0 {
        m.disc = 1;
    }
    Some(m)
}

/// Embedded front cover (or the first picture).
pub fn picture(path: &Path) -> Option<Vec<u8>> {
    let tf = open(path, false)?;
    let mut best: Option<&Picture> = None;
    for t in tf.tags() {
        for p in t.pictures() {
            if p.pic_type() == PictureType::CoverFront {
                return Some(p.data().to_vec());
            }
            best.get_or_insert(p);
        }
    }
    best.map(|p| p.data().to_vec())
}

/// Lyrics stored in tags (USLT / LYRICS / ©lyr).
pub fn lyrics(path: &Path) -> Option<String> {
    let tf = open(path, false)?;
    for t in tf.tags() {
        if let Some(s) = t.get_string(&ItemKey::Lyrics) {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Write a PNG front cover into the file's primary tag (explicit user action only).
pub fn embed_cover(path: &Path, png: &[u8]) -> Result<(), String> {
    embed_picture(path, png, MimeType::Png)
}

/// Downloads (desktop, like the phone): names + a square JPEG cover right in the file.
pub fn write_download(path: &Path, title: &str, artist: &str, album: &str, jpeg: Option<&[u8]>) -> Result<(), String> {
    let mut tf = Probe::open(path).map_err(|e| e.to_string())?.guess_file_type().map_err(|e| e.to_string())?.read().map_err(|e| e.to_string())?;
    let tt = tf.primary_tag_type();
    if tf.primary_tag().is_none() {
        tf.insert_tag(Tag::new(tt));
    }
    let tag = tf.primary_tag_mut().ok_or("no tag")?;
    if !title.is_empty() { tag.set_title(title.to_string()); }
    if !artist.is_empty() { tag.set_artist(artist.to_string()); }
    if !album.is_empty() && tag.album().is_none() { tag.set_album(album.to_string()); }
    if let Some(j) = jpeg {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(MimeType::Jpeg), None, j.to_vec()));
    }
    tf.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())
}

fn embed_picture(path: &Path, png: &[u8], mime: MimeType) -> Result<(), String> {
    let mut tf = Probe::open(path).map_err(|e| e.to_string())?.guess_file_type().map_err(|e| e.to_string())?.read().map_err(|e| e.to_string())?;
    let tt = tf.primary_tag_type();
    if tf.primary_tag().is_none() {
        tf.insert_tag(Tag::new(tt));
    }
    let tag = tf.primary_tag_mut().ok_or("no tag")?;
    tag.remove_picture_type(PictureType::CoverFront);
    tag.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, png.to_vec()));
    tf.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())
}

/// "Download" from an album page (desktop): put the song into that album — names, track/disc number and year.
pub fn write_album(path: &Path, title: &str, artist: &str, album: &str, album_artist: &str, no: u32, disc: u32, year: u32) -> Result<(), String> {
    let mut tf = Probe::open(path).map_err(|e| e.to_string())?.guess_file_type().map_err(|e| e.to_string())?.read().map_err(|e| e.to_string())?;
    let tt = tf.primary_tag_type();
    if tf.primary_tag().is_none() {
        tf.insert_tag(Tag::new(tt));
    }
    let tag = tf.primary_tag_mut().ok_or("no tag")?;
    if !title.is_empty() { tag.set_title(title.to_string()); }
    if !artist.is_empty() { tag.set_artist(artist.to_string()); }
    tag.set_album(album.to_string());
    if !album_artist.is_empty() { tag.insert_text(ItemKey::AlbumArtist, album_artist.to_string()); }
    if no > 0 { tag.set_track(no); }
    if disc > 0 { tag.set_disk(disc); }
    if year > 0 { tag.set_year(year); }
    tf.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())
}
