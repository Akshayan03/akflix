# AKFLIX

A standalone desktop streaming app with movie/series discovery, one-click
playback, temporary streaming and offline downloads. Jellyfin, Prowlarr and
qBittorrent remain available as optional integrations for advanced setups.

- **Frontend:** React + TypeScript + Vite + TailwindCSS + Framer Motion
- **Desktop shell:** Tauri 2 (Rust)
- **Catalog:** Cinemeta metadata + the configured Stremio/Torrentio source
- **Playback engine:** bundled rqbit + bundled static FFmpeg
- **Optional integrations:** Jellyfin, Prowlarr and external qBittorrent

> ⚖️ **Legal disclaimer** — see [LEGAL.md](LEGAL.md). BitTorrent is a legal
> protocol, but downloading or sharing copyrighted material without
> authorization is illegal in most countries. Akflix ships with **no**
> indexers configured; you are solely responsible for what you configure and
> download. Use it with public-domain / Creative Commons media, your own
> content, or sources you're licensed to access.

---

## Features

- 🎬 Full Netflix-like UI — hero banner, horizontal rows (Continue Watching,
  Next Up, My List, Recently Added, genre rows), hover zoom, loading
  skeletons, toast notifications, dark cinematic theme
- 🎯 **Persistent mini player** — navigate anywhere while watching: floating
  picture-in-picture video + Spotify-style now-playing bar with
  play/pause, ±10s, next-episode, seek and close; click to expand back
- 🔑 No login or local server required; optional Jellyfin **multiple servers/users** with a
  "Who's watching?" profile picker (Jellyfin avatars, per-user colors)
- 🔍 Global search across **your Jellyfin library and torrent indexers** at once
- 🧲 Bundled torrent manager: source race → seekable range stream → live
  progress/speed/ETA, with no Docker or separate daemon to configure
- ▶️ In-app player: direct-play or HLS transcode (hls.js), subtitles,
  global keyboard shortcuts (Space/K, ←/→, F, M, Esc), auto-hiding
  controls, resume, progress sync back to Jellyfin
- 🖥️ Desktop-native: macOS overlay titlebar with draggable navbar, system
  tray (hide-to-tray on close), single instance, magnet-link handler,
  .torrent file association, **auto-updates** from GitHub releases
- 🌍 Multi-language UI (en/es/fr) + preferred subtitle language
- 🐳 Optional Docker stack for Jellyfin + qBittorrent + Prowlarr power users

## Project structure

```
akflix/
├── docker/docker-compose.yml   # Jellyfin + qBittorrent + Prowlarr (+ *arr)
├── src-tauri/                  # Tauri 2 desktop shell (Rust)
│   ├── src/lib.rs              # plugin registration (CORS-free HTTP)
│   ├── tauri.conf.json
│   └── capabilities/default.json
├── website/index.html          # self-contained download/landing page
├── .github/workflows/release.yml  # multi-platform release + updater artifacts
└── src/
    ├── api/
    │   ├── jellyfin.ts         # auth, library, images, playback, progress
    │   ├── prowlarr.ts         # torrent search (Prowlarr / Jackett-style)
    │   └── qbittorrent.ts      # torrent client (add/pause/stream/delete)
    ├── stores/                 # zustand: auth (multi-server), settings,
    │                           # torrents, playback (mini-player engine)
    ├── lib/desktop.ts          # deep links (magnet:) + auto-updater glue
    ├── i18n/                   # en / es / fr dictionaries
    ├── components/             # Navbar, HeroBanner, MediaRow, MediaCard,
    │                           # TorrentModal, PlayerHost, MiniPlayer, Skeletons
    └── pages/                  # Login, Home, Search, Details, Player (shim),
                                # Downloads, Settings
```

## Getting started

### Install the app

Download and drag `Akflix.app` to Applications. On first launch Akflix creates
its private media and engine folders, launches the bundled playback engine,
and opens directly to the catalog. No Docker, Jellyfin, Homebrew or command
line setup is required.

Use **Watch now** for temporary playback or **Download** to keep a complete
offline copy. Settings → Source provider accepts a configured Torrentio
manifest. Hosted/debrid sources are preferred automatically because they have
no peer-discovery delay.

### Optional Jellyfin / external services

Jellyfin is useful if you already have a personal media library and want
cross-device watch progress. External qBittorrent and Prowlarr are advanced
alternatives; the normal app does not require them.

```bash
cd docker
docker compose up -d                 # Jellyfin + qBittorrent + Prowlarr
docker compose --profile arr up -d   # optionally add Radarr/Sonarr/FlareSolverr
```

Then do the one-time setup (details in comments inside
[docker-compose.yml](docker/docker-compose.yml)):

1. **Jellyfin** (http://localhost:8096): create a user; add a *Movies/Shows*
   library on `/media` **and a "Downloads" library on `/downloads`** — the
   latter is what makes torrent streaming work.
2. **qBittorrent** (http://localhost:8080): grab the temporary password from
   `docker logs qbittorrent`, set a permanent one, keep save path `/downloads`.
3. **Prowlarr** (http://localhost:9696): add indexers; copy the API key.

### Run from source

```bash
npm install

# Web dev mode (browser, uses Vite proxies for qBittorrent/Prowlarr):
npm run dev

# Desktop dev mode (requires Rust: https://rustup.rs, then):
npx tauri icon assets/icon.png   # one-time: generate platform icons
npm run tauri:dev
```

The desktop development build uses the same bundled executables under
`src-tauri/binaries`. A plain browser build cannot launch the native engine.

### 3. Production build & distribution

```bash
# One-time: generate the updater signing key (keep the private half secret!)
npm run updater:keygen
# → paste the PUBLIC key into src-tauri/tauri.conf.json > plugins.updater.pubkey
# → set the endpoint URL to your GitHub repo's releases

# Build unsigned/local installers for the current platform. These use
# src-tauri/tauri.local.conf.json to skip updater signatures:
npm run build:mac            # .app + .dmg          (run on macOS)
npm run build:mac:universal  # universal Intel+ARM  (run on macOS)
npm run build:win            # .msi + NSIS .exe     (run on Windows)
npm run build:linux          # .deb + .AppImage     (run on Linux)

# Signed updater-capable build (requires TAURI_SIGNING_PRIVATE_KEY):
npm run tauri:build:signed
```

Installers land in `src-tauri/target/release/bundle/`.

**GitHub releases (all platforms at once):** push a tag like `v1.0.0` and the
[release workflow](.github/workflows/release.yml) builds Windows/macOS/Linux
installers, signs the updater artifacts, emits `latest.json` (which powers
in-app auto-updates) and attaches everything to a draft GitHub Release.
Required repo secrets: `TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Code-signing (macOS notarization /
Windows certs) has placeholders in `tauri.conf.json > bundle`.

### 4. Download website

A self-contained, dependency-free landing page lives in
[website/index.html](website/index.html) — Akflix branding, feature grid,
download buttons wired to GitHub release URLs, system requirements, and
release notes. Host it anywhere static (GitHub Pages: point Pages at the
`/website` folder). Preview locally with `npm run website:dev`.

## How streaming works

1. **Watch now** asks the configured source for the selected movie or episode.
2. A hosted/debrid URL plays immediately when available. Otherwise Akflix
   briefly races healthy sources and gives the winner to its embedded engine.
3. The player reads the selected file through a seekable local HTTP stream;
   rqbit prioritizes the ranges playback requests, so there is no separate
   opening-download gate.
4. Containers/codecs WebKit cannot play are converted by the bundled FFmpeg
   into one-second hardware-accelerated HLS segments.
5. Temporary stream data is removed when playback closes. Offline downloads
   are retained until the user deletes them.

## Notes & troubleshooting

- **CORS:** the desktop build performs HTTP from the Rust process
  (tauri-plugin-http), so no CORS setup is needed anywhere. Plain-browser dev
  (`npm run dev`) reaches qBittorrent/Prowlarr through Vite proxies
  (see [vite.config.ts](vite.config.ts)) at their default local ports.
- **External qBittorrent:** only needed if selected in Settings. Its URL and
  credentials are not part of the default first-run experience.
- **Playback:** Akflix negotiates via `/Items/{id}/PlaybackInfo`; files the
  webview can't direct-play fall back to an h264/aac HLS transcode
  automatically (requires no extra config).
- **Jellyfin:** add a server from the profile screen if desired. Every
  session is saved as a profile you can switch between instantly.
