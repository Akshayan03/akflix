#!/bin/sh
# Builds the engine for this Mac's architecture (or $1, a Rust target triple) and puts it where Tauri bundles it:
# src-tauri/binaries/rqbit-<target>. No web UI, Postgres or Prometheus (Akflix only uses the HTTP API); rustls for TLS.
set -eu
cd "$(dirname "$0")"
TARGET="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
cargo build --release --locked --target "$TARGET" -p rqbit --no-default-features --features rust-tls
DIR="${CARGO_TARGET_DIR:-target}/$TARGET/release"
case "$TARGET" in *windows*) EXT=.exe ;; *) EXT= ;; esac
mkdir -p ../src-tauri/binaries
cp "$DIR/rqbit$EXT" "../src-tauri/binaries/rqbit-$TARGET$EXT"
"../src-tauri/binaries/rqbit-$TARGET$EXT" --version
