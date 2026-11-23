//! Album covers: embedded -> folder image -> generated (by the UI). Thumbnail cache 64/168/300/600.
use crate::db::Db;
use crate::paths;
use image::imageops::FilterType;
use std::path::{Path, PathBuf};

const NAMES: &[&str] = &["cover", "folder", "front", "album", "albumart", "albumartsmall"];
const EXTS: &[&str] = &["jpg", "jpeg", "png"];
pub const SIZES: &[u32] = &[64, 168, 300, 600];

pub fn folder_cover(dir: &Path) -> Option<PathBuf> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut found: Vec<(usize, PathBuf)> = Vec::new();
    for ent in rd.flatten() {
        let p = ent.path();
        let (Some(stem), Some(ext)) = (p.file_stem().and_then(|s| s.to_str()), p.extension().and_then(|s| s.to_str())) else { continue };
        if !EXTS.contains(&ext.to_ascii_lowercase().as_str()) {
            continue;
        }
        if let Some(i) = NAMES.iter().position(|n| n.eq_ignore_ascii_case(stem)) {
            found.push((i, p));
        }
    }
    found.sort();
    found.into_iter().next().map(|x| x.1)
}

/// Resolve the cover source for albums that do not have one recorded yet.
pub fn resolve_sources(db: &Db) {
    for (id, tracks) in db.albums_needing_cover() {
        // a picture chosen by the user ("Replace cover with a picture…") wins over everything
        let custom = custom_path(id);
        if custom.exists() {
            db.set_cover_source(id, Some("custom"), &custom.to_string_lossy(), "");
            continue;
        }
        if let Some((p, _)) = tracks.iter().find(|t| t.1) {
            db.set_cover_source(id, Some("file"), p, "");
            continue;
        }
        let dir = tracks.first().and_then(|t| Path::new(&t.0).parent().map(|d| d.to_path_buf()));
        if let Some(img) = dir.as_deref().and_then(folder_cover) {
            let name = img.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            db.set_cover_source(id, Some("folder"), &img.to_string_lossy(), &name);
        } else {
            db.set_cover_source(id, None, "", "");
        }
    }
}

/// The user's own cover for an album (outside the cache folder: "Clear cache" must not delete it).
pub fn custom_path(id: i64) -> PathBuf {
    paths::root().join("custom_covers").join(format!("{id}.jpg"))
}

pub fn cache_path(id: i64, size: u32) -> PathBuf {
    paths::covers().join(format!("{id}_{size}.jpg"))
}
pub fn gen_path(id: i64) -> PathBuf {
    paths::covers().join(format!("{id}_gen.png"))
}

pub fn invalidate(id: i64) {
    for s in SIZES {
        let _ = std::fs::remove_file(cache_path(id, *s));
    }
}

/// JPEG bytes for an album at one of the cache sizes (created on demand).
pub fn get(db: &Db, id: i64, size: u32) -> Option<Vec<u8>> {
    let size = SIZES.iter().copied().find(|s| *s >= size).unwrap_or(600);
    let cp = cache_path(id, size);
    if let Ok(b) = std::fs::read(&cp) {
        return Some(b);
    }
    let (kind, src) = db.cover_source(id)?;
    let raw = if kind == "file" { crate::tags::picture(Path::new(&src))? } else { std::fs::read(&src).ok()? };
    let img = image::load_from_memory(&raw).ok()?;
    // generate all sizes at once (one decode)
    let mut out = None;
    let base = img.resize_to_fill(600, 600, FilterType::CatmullRom);
    for s in SIZES {
        let im = if *s == 600 { base.clone() } else { base.resize_exact(*s, *s, FilterType::Triangle) };
        let mut buf = Vec::new();
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 88);
        if enc.encode_image(&im.to_rgb8()).is_ok() {
            let _ = std::fs::write(cache_path(id, *s), &buf);
            if *s == size {
                out = Some(buf);
            }
        }
    }
    out
}

/// Path to an image file suitable for the OS media overlay.
pub fn thumb_file(db: &Db, id: i64, generated: bool) -> Option<PathBuf> {
    if generated {
        let p = gen_path(id);
        return p.exists().then_some(p);
    }
    get(db, id, 300)?;
    Some(cache_path(id, 300))
}
