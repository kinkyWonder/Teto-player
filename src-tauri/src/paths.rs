use std::path::PathBuf;
use std::sync::OnceLock;

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// %LOCALAPPDATA%\Teto Player (override with TIDE_DATA for tests)
pub fn root() -> &'static PathBuf {
    ROOT.get_or_init(|| {
        let p = std::env::var_os("TIDE_DATA")
            .map(PathBuf::from)
            .or_else(|| dirs::data_local_dir().map(|d| d.join("Teto Player")))
            .unwrap_or_else(|| PathBuf::from("teto-data"));
        let _ = std::fs::create_dir_all(&p);
        p
    })
}

pub fn covers() -> PathBuf {
    let p = root().join("covers");
    let _ = std::fs::create_dir_all(&p);
    p
}

pub fn lyrics() -> PathBuf {
    let p = root().join("lyrics");
    let _ = std::fs::create_dir_all(&p);
    p
}

pub fn db() -> PathBuf {
    root().join("library.db")
}
