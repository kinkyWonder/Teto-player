#!/usr/bin/env sh
# Windows exe cross-compiled from Linux/macOS (cargo-xwin). On Windows just run: npm run tauri build
set -e
cd "$(dirname "$0")/.."
sh scripts/build-web.sh
cd src-tauri && cargo xwin build --release --target x86_64-pc-windows-msvc --features custom-protocol --bin teto-player
echo "EXE: src-tauri/target/x86_64-pc-windows-msvc/release/teto-player.exe"
