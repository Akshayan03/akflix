//! Akflix Tauri backend.
//!
//! The heavy lifting (Jellyfin, qBittorrent, Prowlarr) happens over HTTP from
//! the frontend via tauri-plugin-http, which performs requests in the Rust
//! process and is therefore exempt from webview CORS restrictions.
//!
//! Desktop features owned here:
//!   - single instance (second launch focuses the existing window)
//!   - deep links (magnet: URLs forwarded to the frontend)
//!   - system tray with Open / Quit, and hide-to-tray on window close
//!   - auto-updates (tauri-plugin-updater; config in tauri.conf.json)

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    net::{SocketAddr, TcpStream},
    path::{Component, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tiny_http::{Header, Method, Response, Server, StatusCode};

const RQBIT_API: &str = "127.0.0.1:3031";
static APP_MEDIA_ROOT: OnceLock<PathBuf> = OnceLock::new();
static RQBIT_PROCESS: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid HTTP header")
}

fn media_type(path: &PathBuf) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "ts" | "m2ts" => "video/mp2t",
        "m3u8" => "application/vnd.apple.mpegurl",
        "m4s" => "video/iso.segment",
        "vtt" => "text/vtt",
        _ => "application/octet-stream",
    }
}

fn downloads_root() -> Option<PathBuf> {
    if let Some(path) = APP_MEDIA_ROOT.get() {
        return Some(path.clone());
    }
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .to_path_buf();
    Some(project.join("docker/downloads"))
}

fn target_binary_name(name: &str) -> String {
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    if cfg!(target_os = "windows") {
        format!("{name}-{arch}-pc-windows-msvc.exe")
    } else if cfg!(target_os = "macos") {
        format!("{name}-{arch}-apple-darwin")
    } else {
        format!("{name}-{arch}-unknown-linux-gnu")
    }
}

fn find_bundled_binary(name: &str) -> Option<PathBuf> {
    let installed_name = if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let installed = std::env::current_exe().ok()?.parent()?.join(installed_name);
    if installed.is_file() {
        return Some(installed);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(target_binary_name(name));
    development.is_file().then_some(development)
}

fn rqbit_process() -> &'static Mutex<Option<Child>> {
    RQBIT_PROCESS.get_or_init(|| Mutex::new(None))
}

fn rqbit_ready() -> bool {
    RQBIT_API
        .parse::<SocketAddr>()
        .ok()
        .and_then(|address| TcpStream::connect_timeout(&address, Duration::from_millis(150)).ok())
        .is_some()
}

fn start_embedded_torrent_engine(app: &tauri::AppHandle) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let media = app_data.join("Media");
    let state = app_data.join("Engine");
    fs::create_dir_all(&media).map_err(|error| error.to_string())?;
    fs::create_dir_all(&state).map_err(|error| error.to_string())?;
    let _ = APP_MEDIA_ROOT.set(media.clone());

    if rqbit_ready() {
        return Ok(());
    }
    let executable = find_bundled_binary("rqbit")
        .ok_or("The bundled torrent engine is missing from this Akflix build")?;
    let child = Command::new(executable)
        .args([
            "--http-api-listen-addr",
            RQBIT_API,
            "--peer-limit",
            "250",
            "--listen-port",
            "4240",
            "server",
            "start",
            "--fastresume",
            "--persistence-location",
        ])
        .arg(&state)
        .arg(&media)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start the embedded torrent engine: {error}"))?;
    *rqbit_process()
        .lock()
        .map_err(|_| "Torrent engine process lock failed")? = Some(child);

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(6) {
        if rqbit_ready() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    stop_embedded_torrent_engine();
    Err("The embedded torrent engine did not start in time".into())
}

fn stop_embedded_torrent_engine() {
    if let Ok(mut process) = rqbit_process().lock() {
        if let Some(mut child) = process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn safe_media_path(url: &str) -> Option<PathBuf> {
    let encoded = url.split('?').next()?.trim_start_matches('/');
    let decoded = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .ok()?;
    let relative = PathBuf::from(decoded.as_ref());
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some(downloads_root()?.join(relative))
}

static HLS_PROCESSES: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();
static AUDIO_STREAM_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn hls_processes() -> &'static Mutex<HashMap<String, Child>> {
    HLS_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn audio_stream_cache() -> &'static Mutex<HashMap<String, String>> {
    AUDIO_STREAM_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn safe_stream_id(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 80
        && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
    .then(|| value.to_ascii_lowercase())
}

fn find_ffmpeg() -> Option<PathBuf> {
    std::env::var_os("AKFLIX_FFMPEG")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| find_bundled_binary("ffmpeg"))
        .or_else(|| {
            [
                "/opt/homebrew/bin/ffmpeg",
                "/usr/local/bin/ffmpeg",
                "/usr/bin/ffmpeg",
            ]
            .iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())
        })
}

fn stop_hls_process(id: &str) {
    if let Ok(mut processes) = hls_processes().lock() {
        if let Some(mut child) = processes.remove(id) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn audio_language_aliases(value: Option<&str>) -> Vec<String> {
    let requested = value.unwrap_or("eng").trim().to_ascii_lowercase();
    match requested.as_str() {
        "en" | "eng" | "english" => vec!["eng".into(), "en".into()],
        "es" | "spa" | "spanish" => vec!["spa".into(), "es".into()],
        "fr" | "fra" | "fre" | "french" => {
            vec!["fra".into(), "fre".into(), "fr".into()]
        }
        _ if !requested.is_empty()
            && requested.len() <= 12
            && requested
                .chars()
                .all(|character| character.is_ascii_alphabetic()) =>
        {
            vec![requested]
        }
        _ => vec!["eng".into(), "en".into()],
    }
}

/// Ask the bundled ffmpeg to inspect only the container header, then map the
/// preferred language by its absolute stream index. This avoids assuming that
/// audio track zero is English in MULTI releases. If tags are absent, retain
/// ffmpeg's safe first-audio fallback.
fn preferred_audio_map(ffmpeg: &PathBuf, input: &str, language: Option<&str>) -> String {
    let aliases = audio_language_aliases(language);
    let cache_key = format!("{}\0{}", aliases.join(","), input);
    if let Ok(cache) = audio_stream_cache().lock() {
        if let Some(found) = cache.get(&cache_key) {
            return found.clone();
        }
    }

    let mut probe = Command::new(ffmpeg);
    probe.args(["-hide_banner", "-loglevel", "info", "-nostdin"]);
    if input.starts_with("http://") || input.starts_with("https://") {
        // A stalled peer must not make language inspection block forever.
        probe.args(["-rw_timeout", "4000000"]);
    }
    let output = probe.arg("-i").arg(input).output();
    let mut selected = "0:a:0?".to_string();
    let mut found_audio = false;

    if let Ok(output) = output {
        let report = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        for line in report.lines().filter(|line| line.contains("audio:")) {
            found_audio = true;
            if !aliases
                .iter()
                .any(|alias| line.contains(&format!("({alias})")))
            {
                continue;
            }
            let Some(after_marker) = line.split("stream #0:").nth(1) else {
                continue;
            };
            let index = after_marker
                .chars()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>();
            if !index.is_empty() {
                selected = format!("0:{index}");
                break;
            }
        }
    }

    // Do not cache an inconclusive network probe; the next playback retry may
    // have enough torrent header bytes to expose the language tags.
    if found_audio {
        if let Ok(mut cache) = audio_stream_cache().lock() {
            cache.insert(cache_key, selected.clone());
        }
    }
    selected
}

/// Convert containers/codecs WebKit cannot play into a short rolling HLS
/// window. The platform media encoder keeps this hardware accelerated where
/// the operating system exposes one (VideoToolbox on macOS, Media Foundation
/// on Windows).
fn start_hls_input(
    input: String,
    stream_id: String,
    audio_language: Option<String>,
) -> Result<String, String> {
    let id = safe_stream_id(&stream_id).ok_or("Invalid stream id")?;
    let root = downloads_root().ok_or("Could not locate downloads")?;
    let ffmpeg =
        find_ffmpeg().ok_or("The bundled FFmpeg executable is missing from this Akflix build")?;

    stop_hls_process(&id);
    let output = root.join("Streaming Cache/.akflix-hls").join(&id);
    let _ = fs::remove_dir_all(&output);
    fs::create_dir_all(&output).map_err(|error| error.to_string())?;
    let playlist = output.join("index.m3u8");
    let segment_pattern = output.join("segment-%06d.ts");

    let audio_map = preferred_audio_map(&ffmpeg, &input, audio_language.as_deref());
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "warning", "-nostdin", "-i"])
        .arg(&input)
        .args(["-map", "0:v:0", "-map"])
        .arg(audio_map)
        .arg("-c:v");

    if cfg!(target_os = "macos") {
        command.args([
            "h264_videotoolbox",
            "-b:v",
            "4500k",
            "-maxrate",
            "6000k",
            "-bufsize",
            "9000k",
            "-allow_sw",
            "1",
        ]);
    } else if cfg!(target_os = "windows") {
        command.args([
            "h264_mf", "-b:v", "4500k", "-maxrate", "6000k", "-bufsize", "9000k",
        ]);
    } else {
        command.args([
            "libx264", "-preset", "veryfast", "-b:v", "4500k", "-maxrate", "6000k", "-bufsize",
            "9000k",
        ]);
    }

    let child = command
        .args([
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ac",
            "2",
            "-force_key_frames",
            "expr:gte(t,n_forced*1)",
            "-f",
            "hls",
            "-hls_time",
            "1",
            "-hls_list_size",
            "45",
            "-hls_flags",
            "delete_segments+append_list+omit_endlist+independent_segments+temp_file",
            "-hls_segment_filename",
        ])
        .arg(&segment_pattern)
        .arg(&playlist)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start FFmpeg: {error}"))?;

    hls_processes()
        .lock()
        .map_err(|_| "HLS process lock failed")?
        .insert(id.clone(), child);
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        if playlist
            .metadata()
            .map(|meta| meta.len() > 40)
            .unwrap_or(false)
        {
            return Ok(format!("Streaming%20Cache/.akflix-hls/{id}/index.m3u8"));
        }
        let exited = hls_processes()
            .lock()
            .ok()
            .and_then(|mut items| {
                items
                    .get_mut(&id)
                    .and_then(|child| child.try_wait().ok())
                    .flatten()
            })
            .is_some();
        if exited {
            stop_hls_process(&id);
            return Err("FFmpeg could not read this source yet".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    stop_hls_process(&id);
    Err("Timed out preparing the compatibility stream".into())
}

#[tauri::command]
fn start_hls_stream(
    relative_path: String,
    stream_id: String,
    audio_language: Option<String>,
) -> Result<String, String> {
    let root = downloads_root().ok_or("Could not locate downloads")?;
    let relative = PathBuf::from(&relative_path);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Invalid media path".into());
    }
    let input = root.join(&relative);
    if !input.is_file() {
        return Err("The selected video is not ready on disk".into());
    }
    start_hls_input(
        input.to_string_lossy().into_owned(),
        stream_id,
        audio_language,
    )
}

#[tauri::command]
fn start_hls_url(
    input_url: String,
    stream_id: String,
    audio_language: Option<String>,
) -> Result<String, String> {
    if !input_url.starts_with("http://127.0.0.1:3031/torrents/") {
        return Err("Only the embedded local stream can be transcoded".into());
    }
    start_hls_input(input_url, stream_id, audio_language)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedEngineStatus {
    torrent_engine: bool,
    ffmpeg: bool,
    media_path: Option<String>,
}

#[tauri::command]
fn embedded_engine_status() -> EmbeddedEngineStatus {
    EmbeddedEngineStatus {
        torrent_engine: rqbit_ready(),
        ffmpeg: find_ffmpeg().is_some(),
        media_path: downloads_root().map(|path| path.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
fn stop_hls_stream(stream_id: String) -> Result<(), String> {
    let id = safe_stream_id(&stream_id).ok_or("Invalid stream id")?;
    stop_hls_process(&id);
    if let Some(root) = downloads_root() {
        let _ = fs::remove_dir_all(root.join("Streaming Cache/.akflix-hls").join(id));
    }
    Ok(())
}

fn start_stream_gateway() {
    thread::spawn(|| {
        let Ok(server) = Server::http("127.0.0.1:8097") else {
            return; // Another Akflix instance already owns the gateway.
        };
        for request in server.incoming_requests() {
            if request.method() == &Method::Options {
                let response = Response::empty(StatusCode(204))
                    .with_header(header("Access-Control-Allow-Origin", "*"))
                    .with_header(header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"))
                    .with_header(header("Access-Control-Allow-Headers", "Range"));
                let _ = request.respond(response);
                continue;
            }

            let Some(path) = safe_media_path(request.url()) else {
                let _ = request.respond(Response::empty(StatusCode(400)));
                continue;
            };
            let Ok(mut file) = File::open(&path) else {
                let _ = request.respond(Response::empty(StatusCode(404)));
                continue;
            };
            let Ok(metadata) = file.metadata() else {
                let _ = request.respond(Response::empty(StatusCode(404)));
                continue;
            };
            let total = metadata.len();
            let range = request
                .headers()
                .iter()
                .find(|item| item.field.equiv("Range"))
                .and_then(|item| item.value.as_str().strip_prefix("bytes="))
                .and_then(|value| value.split(',').next())
                .and_then(|value| {
                    let (start, end) = value.split_once('-')?;
                    let start = start.parse::<u64>().ok()?;
                    let end = if end.is_empty() {
                        total.saturating_sub(1)
                    } else {
                        end.parse::<u64>().ok()?.min(total.saturating_sub(1))
                    };
                    (start <= end && start < total).then_some((start, end))
                });

            let cors = header("Access-Control-Allow-Origin", "*");
            let ranges = header("Accept-Ranges", "bytes");
            let cache = header("Cache-Control", "no-store");
            let content_type = header("Content-Type", media_type(&path));

            if let Some((start, end)) = range {
                let length = end - start + 1;
                let _ = file.seek(SeekFrom::Start(start));
                if request.method() == &Method::Head {
                    let response = Response::empty(StatusCode(206))
                        .with_header(cors)
                        .with_header(ranges)
                        .with_header(cache)
                        .with_header(content_type)
                        .with_header(header("Content-Length", &length.to_string()))
                        .with_header(header(
                            "Content-Range",
                            &format!("bytes {start}-{end}/{total}"),
                        ));
                    let _ = request.respond(response);
                } else {
                    let reader: Box<dyn Read + Send> = Box::new(file.take(length));
                    let response = Response::new(
                        StatusCode(206),
                        Vec::new(),
                        reader,
                        Some(length as usize),
                        None,
                    )
                    .with_header(cors)
                    .with_header(ranges)
                    .with_header(cache)
                    .with_header(content_type)
                    .with_header(header(
                        "Content-Range",
                        &format!("bytes {start}-{end}/{total}"),
                    ));
                    let _ = request.respond(response);
                }
            } else if request.method() == &Method::Head {
                let response = Response::empty(StatusCode(200))
                    .with_header(cors)
                    .with_header(ranges)
                    .with_header(cache)
                    .with_header(content_type)
                    .with_header(header("Content-Length", &total.to_string()));
                let _ = request.respond(response);
            } else {
                let response = Response::from_file(file)
                    .with_header(cors)
                    .with_header(ranges)
                    .with_header(cache)
                    .with_header(content_type);
                let _ = request.respond(response);
            }
        }
    });
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be registered first: a second app launch (e.g. the OS opening
        // a magnet link) focuses the running instance instead of starting a
        // new one; the deep-link plugin receives the URL.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        // CORS-free fetch for the frontend (Jellyfin / qBittorrent / Prowlarr).
        .plugin(tauri_plugin_http::init())
        // Open external links in the OS default handler.
        .plugin(tauri_plugin_opener::init())
        // magnet: scheme handling (config in tauri.conf.json > plugins.deep-link).
        .plugin(tauri_plugin_deep_link::init())
        // Auto-updates from GitHub releases + relaunch support.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            start_hls_stream,
            start_hls_url,
            stop_hls_stream,
            embedded_engine_status
        ])
        .setup(|app| {
            if let Err(error) = start_embedded_torrent_engine(app.handle()) {
                eprintln!("Akflix embedded engine warning: {error}");
            }
            start_stream_gateway();
            // ── System tray ──────────────────────────────────────────────
            let open = MenuItem::with_id(app, "open", "Open Akflix", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::with_id("akflix-tray")
                .tooltip("Akflix")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => {
                        stop_embedded_torrent_engine();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        // Closing the window hides to tray (playback/downloads keep running).
        // Quit for real via the tray menu or Cmd+Q.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Akflix");

    app.run(|_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            stop_embedded_torrent_engine();
        }
    });
}
