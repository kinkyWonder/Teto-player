#!/usr/bin/env sh
# Rebuild the phone copy of the Rust name cleaner (only needed after editing src-tauri/src/namefix*.rs)
set -e
cd "$(dirname "$0")/../namefix-wasm"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/namefix_wasm.wasm ../src/mobile/backend/namefix.wasm
