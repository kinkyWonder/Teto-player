fn main() {
    if std::env::var("CARGO_FEATURE_APP").is_ok() {
        tauri_build::build();
    }
}
