# The torrent engine Akflix bundles

`src-tauri/binaries/rqbit-<target>` is the [rqbit](https://github.com/ikatson/rqbit) 9.0.1 command-line client, built
here from its crates.io source (`rqbit/`, unchanged) against librqbit 9.0.1 with Akflix's fixes
(`vendor/librqbit-9.0.1`, the same copy Akflix for iPhone builds in). Up to Akflix 1.0.31 the Mac and Windows apps
shipped the official rqbit 9.0.0-beta.2 binary, which has the first two problems below.

| File in `vendor/librqbit-9.0.1` | Change |
|---|---|
| `src/torrent_state/live/mod.rs` `update_only_files` | The new file selection is applied under the torrent-state lock, the lock is released, then peers are reconnected. rqbit took that lock and a peer-map lock in opposite orders, so changing the selected file of a torrent with connected peers could lock the engine for good: it accepted requests and never answered them (reproduced after a few hundred selection changes). |
| `src/torrent_state/streaming.rs` `stream` | A stream no longer holds one of the session's blocking-I/O permits for its whole life (8 by default; its reads don't use one). A stream waiting for pieces that never came (a source nobody sends, a player that moved on) kept its permit, and the same permits gate every chunk write and torrent start: with all of them taken, every peer sent one 16 KiB block and then nothing, and new torrents never started. |
| `src/piece_tracker.rs` `try_steal_urgent` | The piece a stream reader waits on is taken from a slow peer after 3x its average piece time (at least 4 s) instead of 10x. |

Build (Rust 1.85+): `sh engine/build.sh [target]` — default this machine's target — writes
`src-tauri/binaries/rqbit-<target>[.exe]`. Features: `rust-tls` only (no web UI, Postgres or Prometheus; Akflix uses
the HTTP API). `Cargo.lock` is rqbit's published lock file with librqbit pointed at the vendored copy. The release
workflows (`.github/workflows/*-standalone.yml`) build it the same way.
