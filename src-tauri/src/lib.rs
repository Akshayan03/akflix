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
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tiny_http::{Header, Method, Response, Server, StatusCode};

#[cfg(unix)]
use std::{ffi::CString, os::unix::ffi::OsStrExt};

mod signin;

const RQBIT_API: &str = "127.0.0.1:3031";
/// Engine state kept beside media stored outside Akflix's default folder.
const MEDIA_ENGINE_STATE: &str = ".akflix-engine";
static APP_MEDIA_ROOT: OnceLock<PathBuf> = OnceLock::new();
static RQBIT_PROCESS: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static RQBIT_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static HLS_STARTUP_CLEANED: OnceLock<()> = OnceLock::new();
#[cfg(target_os = "macos")]
static WHISPER_CONTEXT: OnceLock<whisper_rs::WhisperContext> = OnceLock::new();
#[cfg(target_os = "macos")]
static WHISPER_WORKER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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

#[derive(Default, serde::Deserialize, serde::Serialize)]
struct MediaStoragePreference {
    path: Option<PathBuf>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaStorageStatus {
    path: String,
    active_path: String,
    available: bool,
    active_available: bool,
    writable: bool,
    free_bytes: Option<u64>,
    active_free_bytes: Option<u64>,
    using_external: bool,
    using_default: bool,
    restart_required: bool,
    engine_running: bool,
    volume_name: Option<String>,
}

fn default_media_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("Media"))
}

fn media_storage_preference_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("media-storage.json"))
}

fn preferred_media_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let default = default_media_root(app)?;
    let preference_path = media_storage_preference_path(app)?;
    let Ok(contents) = fs::read(&preference_path) else {
        return Ok(default);
    };
    let Ok(preference) = serde_json::from_slice::<MediaStoragePreference>(&contents) else {
        return Ok(default);
    };
    Ok(preference
        .path
        .filter(|path| path.is_absolute())
        .unwrap_or(default))
}

fn is_external_media_root(path: &std::path::Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        path.starts_with("/Volumes")
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

fn media_volume_name(path: &std::path::Path) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        path.strip_prefix("/Volumes")
            .ok()?
            .components()
            .next()?
            .as_os_str()
            .to_str()
            .map(str::to_owned)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}

fn storage_target_for_selection(selection: &std::path::Path) -> PathBuf {
    if selection.file_name().and_then(|name| name.to_str()) == Some("Akflix Media") {
        selection.to_path_buf()
    } else {
        selection.join("Akflix Media")
    }
}

fn path_is_writable(path: &std::path::Path) -> bool {
    path.metadata()
        .map(|metadata| metadata.is_dir() && !metadata.permissions().readonly())
        .unwrap_or(false)
}

fn write_media_storage_preference(
    app: &tauri::AppHandle,
    path: Option<PathBuf>,
) -> Result<(), String> {
    let preference_path = media_storage_preference_path(app)?;
    let parent = preference_path
        .parent()
        .ok_or("Could not locate Akflix application data")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = preference_path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&MediaStoragePreference { path })
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, preference_path).map_err(|error| error.to_string())
}

fn build_media_storage_status(app: &tauri::AppHandle) -> Result<MediaStorageStatus, String> {
    let default = default_media_root(app)?;
    let preferred = preferred_media_root(app)?;
    let active = downloads_root().unwrap_or_else(|| preferred.clone());
    let available = preferred.is_dir();
    let active_available = active.is_dir();
    Ok(MediaStorageStatus {
        path: preferred.to_string_lossy().into_owned(),
        active_path: active.to_string_lossy().into_owned(),
        available,
        active_available,
        writable: available && path_is_writable(&preferred),
        free_bytes: available_bytes(&preferred).ok().filter(|_| available),
        active_free_bytes: available_bytes(&active).ok().filter(|_| active_available),
        using_external: is_external_media_root(&preferred),
        using_default: preferred == default,
        restart_required: active != preferred,
        engine_running: rqbit_ready(),
        volume_name: media_volume_name(&preferred),
    })
}

/// Synchronous commands run on the macOS main thread inside Tauri's IPC
/// handler. Anything that touches disks, the engine or FFmpeg runs here
/// instead, so a slow drive or source never freezes the window and every
/// other request queued behind it.
async fn off_main_thread<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Akflix background task stopped: {error}"))?
}

#[tauri::command]
async fn media_storage_status(app: tauri::AppHandle) -> Result<MediaStorageStatus, String> {
    off_main_thread(move || build_media_storage_status(&app)).await
}

#[tauri::command]
async fn configure_media_storage(
    app: tauri::AppHandle,
    selected_path: String,
) -> Result<MediaStorageStatus, String> {
    off_main_thread(move || configure_media_storage_sync(&app, selected_path)).await
}

fn configure_media_storage_sync(
    app: &tauri::AppHandle,
    selected_path: String,
) -> Result<MediaStorageStatus, String> {
    let selected = PathBuf::from(selected_path);
    if !selected.is_absolute() || !selected.is_dir() {
        return Err("Choose a connected folder or drive".into());
    }
    let selected = fs::canonicalize(selected).map_err(|error| error.to_string())?;
    let target = storage_target_for_selection(&selected);
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;

    let probe = target.join(format!(".akflix-write-test-{}", std::process::id()));
    fs::write(&probe, b"Akflix storage test")
        .map_err(|error| format!("Akflix cannot write to this location: {error}"))?;
    fs::remove_file(&probe).map_err(|error| error.to_string())?;

    write_media_storage_preference(app, Some(target))?;
    build_media_storage_status(app)
}

#[tauri::command]
async fn reset_media_storage(app: tauri::AppHandle) -> Result<MediaStorageStatus, String> {
    off_main_thread(move || {
        let default = default_media_root(&app)?;
        fs::create_dir_all(&default).map_err(|error| error.to_string())?;
        write_media_storage_preference(&app, None)?;
        build_media_storage_status(&app)
    })
    .await
}

#[cfg(unix)]
fn available_bytes(path: &std::path::Path) -> Result<u64, String> {
    let encoded = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "Invalid media storage path".to_string())?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    let result = unsafe { libc::statvfs(encoded.as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let stats = unsafe { stats.assume_init() };
    Ok((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

#[cfg(not(unix))]
fn available_bytes(_path: &std::path::Path) -> Result<u64, String> {
    Ok(u64::MAX)
}

#[tauri::command]
async fn available_media_storage() -> Result<u64, String> {
    off_main_thread(available_media_storage_sync).await
}

fn available_media_storage_sync() -> Result<u64, String> {
    let root = downloads_root().ok_or("Could not locate media storage")?;
    if !root.is_dir() {
        let name = media_volume_name(&root).unwrap_or_else(|| "selected storage".into());
        return Err(format!(
            "{name} is disconnected. Reconnect it before starting a stream."
        ));
    }
    available_bytes(&root)
}

#[tauri::command]
async fn remove_embedded_media_files(relative_paths: Vec<String>) -> Result<(), String> {
    off_main_thread(move || remove_media_files(relative_paths)).await
}

fn remove_media_files(relative_paths: Vec<String>) -> Result<(), String> {
    let root = downloads_root().ok_or("Could not locate media storage")?;
    for value in relative_paths {
        let relative = PathBuf::from(value);
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            || is_engine_state_path(&relative)
        {
            continue;
        }
        let target = root.join(&relative);
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            if metadata.is_dir() {
                fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
            } else {
                fs::remove_file(&target).map_err(|error| error.to_string())?;
            }
        }

        let mut parent = target.parent();
        while let Some(folder) = parent {
            if folder == root || !folder.starts_with(&root) {
                break;
            }
            if fs::remove_dir(folder).is_err() {
                break;
            }
            parent = folder.parent();
        }
    }
    Ok(())
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

fn pause_persisted_torrents(state: &std::path::Path) -> Result<(), String> {
    let session_path = state.join("session.json");
    if session_path.is_file() {
        let contents = fs::read_to_string(&session_path).map_err(|error| error.to_string())?;
        let mut session: serde_json::Value =
            serde_json::from_str(&contents).map_err(|error| error.to_string())?;
        if let Some(torrents) = session
            .get_mut("torrents")
            .and_then(|value| value.as_object_mut())
        {
            for torrent in torrents.values_mut() {
                if let Some(object) = torrent.as_object_mut() {
                    object.insert("is_paused".into(), serde_json::Value::Bool(true));
                }
            }
        }
        let temporary = state.join("session.cleanup.json");
        fs::write(
            &temporary,
            serde_json::to_vec(&session).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        fs::rename(temporary, session_path).map_err(|error| error.to_string())?;
    }

    Ok(())
}

/// rqbit must write its session before it accepts a new torrent, so an add
/// fails whenever this folder's disk is full. Keep the state on the same drive
/// as the media it describes: a full startup disk then cannot block streams
/// that are stored on a selected external drive.
fn engine_state_dir(app_data: &std::path::Path, media: &std::path::Path) -> PathBuf {
    if media == app_data.join("Media") {
        app_data.join("Engine")
    } else {
        media.join(MEDIA_ENGINE_STATE)
    }
}

/// Copy the previous engine session the first time a media drive gets its own
/// state folder. The original folder is left untouched as a backup and is used
/// again if the user switches back to this Mac's storage.
fn prepare_engine_state(legacy: &std::path::Path, state: &std::path::Path) -> Result<(), String> {
    if state == legacy
        || state.join("session.json").is_file()
        || !legacy.join("session.json").is_file()
    {
        return fs::create_dir_all(state).map_err(|error| error.to_string());
    }
    let occupied = fs::read_dir(state)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if occupied {
        // Never mix two sessions in one folder.
        return Ok(());
    }
    let staging = state.with_extension("migrating");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let copied = (|| -> std::io::Result<()> {
        for entry in fs::read_dir(legacy)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                fs::copy(entry.path(), staging.join(entry.file_name()))?;
            }
        }
        Ok(())
    })();
    if let Err(error) = copied {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Could not move the playback engine state: {error}"));
    }
    // A plain rename publishes the complete copy at once; an interrupted copy
    // only ever leaves the staging folder behind.
    if state.exists() {
        fs::remove_dir(state).map_err(|error| error.to_string())?;
    }
    fs::rename(&staging, state).map_err(|error| error.to_string())
}

/// The engine state folder inside a media root is never served or deleted as media.
fn is_engine_state_path(relative: &std::path::Path) -> bool {
    relative
        .components()
        .next()
        .is_some_and(|part| part.as_os_str() == MEDIA_ENGINE_STATE)
}

fn rqbit_process_running() -> bool {
    let Ok(mut process) = rqbit_process().lock() else {
        return false;
    };
    let running = process
        .as_mut()
        .and_then(|child| child.try_wait().ok())
        .is_some_and(|status| status.is_none());
    if !running {
        process.take();
    }
    running
}

fn start_embedded_torrent_engine(app: &tauri::AppHandle) -> Result<(), String> {
    // Storage checks and source racing can ask for the engine at the same
    // time. Serialize startup so reconnecting a drive never launches two
    // rqbit processes that compete for the same API and peer ports.
    let _start_guard = RQBIT_START_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Torrent engine startup lock failed")?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let default_media = app_data.join("Media");
    let media = preferred_media_root(app)?;
    let legacy_state = app_data.join("Engine");
    let _ = APP_MEDIA_ROOT.set(media.clone());

    if media == default_media {
        fs::create_dir_all(&media).map_err(|error| error.to_string())?;
    } else if !media.is_dir() {
        let name = media_volume_name(&media).unwrap_or_else(|| "Selected storage".into());
        return Err(format!(
            "{name} is disconnected. Akflix left the media engine paused to protect your files."
        ));
    }
    if !path_is_writable(&media) {
        return Err("The selected Akflix media location is read-only".into());
    }
    if HLS_STARTUP_CLEANED.set(()).is_ok() {
        // A forced quit can leave completed rolling playlists behind. They are
        // never resumable across launches and can confuse a new player request.
        let _ = fs::remove_dir_all(media.join("Streaming Cache/.akflix-hls"));
    }
    let preferred_state = engine_state_dir(&app_data, &media);
    let state = match prepare_engine_state(&legacy_state, &preferred_state) {
        Ok(()) => preferred_state,
        Err(error) => {
            // Keep the previous behavior rather than starting without the
            // user's saved downloads.
            eprintln!("Akflix engine state warning: {error}");
            fs::create_dir_all(&legacy_state).map_err(|error| error.to_string())?;
            legacy_state
        }
    };
    if rqbit_ready() {
        return Ok(());
    }
    if !rqbit_process_running() {
        // Never let a stale temporary stream or season pack block the HTTP API
        // while rqbit verifies its files. The frontend removes temporary
        // sessions and resumes intentional offline downloads once the API is up.
        if let Err(error) = pause_persisted_torrents(&state) {
            eprintln!("Akflix session cleanup warning: {error}");
        }
        let executable = find_bundled_binary("rqbit")
            .ok_or("The bundled torrent engine is missing from this Akflix build")?;
        let child = Command::new(executable)
            .args([
                "--http-api-listen-addr",
                RQBIT_API,
                "--peer-limit",
                "55",
                "--peer-connect-timeout",
                "2s",
                "--peer-read-write-timeout",
                "4s",
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
    }

    let started = Instant::now();
    // Restoring several saved sessions from an external drive can take longer
    // than a cold, empty launch. Give rqbit time to finish recovery instead of
    // killing it just before its HTTP API becomes ready and retrying forever.
    while started.elapsed() < Duration::from_secs(25) {
        if rqbit_ready() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    if rqbit_process_running() {
        Err("The embedded torrent engine is still restoring saved downloads".into())
    } else {
        Err("The embedded torrent engine stopped before it became ready".into())
    }
}

fn stop_embedded_torrent_engine() {
    if let Ok(mut process) = rqbit_process().lock() {
        if let Some(mut child) = process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(desktop)]
fn monitor_embedded_torrent_engine(app: tauri::AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        if rqbit_ready() {
            continue;
        }

        // Do not cross a pending storage change or write to a disconnected
        // drive. Once the active location is ready again, recover rqbit
        // automatically, including after a relaunch overlaps the previous
        // engine's shutdown.
        let Ok(status) = build_media_storage_status(&app) else {
            continue;
        };
        if status.restart_required || !status.active_available || !status.writable {
            continue;
        }
        if let Err(error) = start_embedded_torrent_engine(&app) {
            eprintln!("Akflix embedded engine recovery warning: {error}");
        }
    });
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
        || is_engine_state_path(&relative)
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

fn caption_model_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|path| path.join("models/ggml-base.en-q5_1.bin"))
        .filter(|path| path.is_file())
        .or_else(|| {
            let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("models/ggml-base.en-q5_1.bin");
            development.is_file().then_some(development)
        })
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptionCue {
    start: f64,
    end: f64,
    text: String,
}

fn caption_input(value: &str) -> Result<String, String> {
    if let Some(relative) = value.strip_prefix("media://") {
        let relative = PathBuf::from(relative);
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("Invalid local caption source".into());
        }
        let path = downloads_root()
            .ok_or("Could not locate media storage")?
            .join(relative);
        if !path.is_file() {
            return Err("The video is not ready for caption generation yet".into());
        }
        return Ok(path.to_string_lossy().into_owned());
    }
    if value.starts_with("http://") || value.starts_with("https://") {
        return Ok(value.to_string());
    }
    Err("This playback source cannot be transcribed".into())
}

#[cfg(target_os = "macos")]
fn whisper_context(app: &tauri::AppHandle) -> Result<&'static whisper_rs::WhisperContext, String> {
    if let Some(context) = WHISPER_CONTEXT.get() {
        return Ok(context);
    }
    let model = caption_model_path(app)
        .ok_or("The bundled Akflix caption model is missing. Reinstall the latest version.")?;
    // Route whisper.cpp and GGML diagnostics through Rust's disabled-by-default
    // logging hook instead of flooding the app's stderr during first use.
    whisper_rs::install_logging_hooks();
    let mut parameters = whisper_rs::WhisperContextParameters::default();
    parameters.use_gpu = true;
    parameters.flash_attn = true;
    let context = whisper_rs::WhisperContext::new_with_params(model, parameters)
        .map_err(|error| format!("Could not load the caption model: {error}"))?;
    let _ = WHISPER_CONTEXT.set(context);
    WHISPER_CONTEXT
        .get()
        .ok_or_else(|| "Could not initialize the caption model".into())
}

#[cfg(target_os = "macos")]
fn transcribe_caption_chunk_sync(
    app: &tauri::AppHandle,
    input: String,
    start_seconds: f64,
    duration_seconds: f64,
    audio_language: Option<String>,
) -> Result<Vec<CaptionCue>, String> {
    use whisper_rs::{FullParams, SamplingStrategy};

    let _worker = WHISPER_WORKER_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Caption worker lock failed")?;
    let input = caption_input(&input)?;
    let start_seconds = if start_seconds.is_finite() {
        start_seconds.max(0.0)
    } else {
        0.0
    };
    let duration_seconds = if duration_seconds.is_finite() {
        duration_seconds.clamp(6.0, 30.0)
    } else {
        20.0
    };
    let ffmpeg =
        find_ffmpeg().ok_or("The bundled FFmpeg executable is missing from this Akflix build")?;
    let audio_map = preferred_audio_map(&ffmpeg, &input, audio_language.as_deref());
    let mut command = Command::new(ffmpeg);
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    if input.starts_with("http://") || input.starts_with("https://") {
        command.args(["-rw_timeout", "10000000"]);
    }
    if start_seconds > 0.05 {
        command.args(["-ss", &format!("{start_seconds:.3}")]);
    }
    let output = command
        .arg("-i")
        .arg(&input)
        .args(["-map", &audio_map, "-t", &format!("{duration_seconds:.3}")])
        .args([
            "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not read the video audio: {error}"))?;
    if !output.status.success() && output.stdout.is_empty() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "The audio could not be prepared for captions: {}",
            detail.lines().last().unwrap_or("unknown FFmpeg error")
        ));
    }
    let samples = output
        .stdout
        .chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32)
        .collect::<Vec<_>>();
    if samples.len() < 16_000 {
        return Err("Not enough dialogue audio is available yet".into());
    }

    let context = whisper_context(app)?;
    let mut state = context
        .create_state()
        .map_err(|error| format!("Could not start speech recognition: {error}"))?;
    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 4,
        patience: -1.0,
    });
    let threads = thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .clamp(2, 6) as i32;
    params.set_n_threads(threads);
    params.set_language(Some("en"));
    params.set_translate(false);
    params.set_no_context(true);
    params.set_split_on_word(true);
    params.set_max_len(72);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    state
        .full(params, &samples)
        .map_err(|error| format!("Caption generation failed: {error}"))?;

    let mut cues = Vec::new();
    for segment in state.as_iter() {
        let text = segment
            .to_str_lossy()
            .map_err(|error| error.to_string())?
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let start = start_seconds + segment.start_timestamp() as f64 / 100.0;
        let end = start_seconds + segment.end_timestamp() as f64 / 100.0;
        cues.push(CaptionCue {
            start,
            end: end.max(start + 0.4),
            text,
        });
    }
    Ok(cues)
}

#[tauri::command]
async fn transcribe_caption_chunk(
    app: tauri::AppHandle,
    input: String,
    start_seconds: f64,
    duration_seconds: f64,
    audio_language: Option<String>,
) -> Result<Vec<CaptionCue>, String> {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            transcribe_caption_chunk_sync(
                &app,
                input,
                start_seconds,
                duration_seconds,
                audio_language,
            )
        })
        .await
        .map_err(|error| format!("Caption worker stopped: {error}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, input, start_seconds, duration_seconds, audio_language);
        Err("Live caption generation is currently available in Akflix for Mac".into())
    }
}

/// One skip-detection read at a time: it runs beside playback and must never
/// compete with it through more than one FFmpeg process.
static SKIP_READER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
/// The read in progress: the playing file it is for, and its FFmpeg process.
static SKIP_READ: OnceLock<Mutex<Option<(String, u32)>>> = OnceLock::new();

fn skip_read() -> &'static Mutex<Option<(String, u32)>> {
    SKIP_READ.get_or_init(|| Mutex::new(None))
}

/// Stops the read in progress when `stale(owner)` says nobody wants it any
/// more (the episode changed or the player closed), so the next one never
/// waits behind it.
fn stop_skip_read(stale: impl Fn(&str) -> bool) {
    let Ok(current) = skip_read().lock() else {
        return;
    };
    if let Some((owner, pid)) = current.as_ref() {
        if stale(owner) {
            #[cfg(unix)]
            unsafe {
                libc::kill(*pid as i32, libc::SIGTERM);
            }
            #[cfg(not(unix))]
            let _ = pid;
        }
    }
}

fn skip_ffmpeg(input: &str) -> Result<(PathBuf, String), String> {
    let input = caption_input(input)?;
    let ffmpeg =
        find_ffmpeg().ok_or("The bundled FFmpeg executable is missing from this Akflix build")?;
    Ok((ffmpeg, input))
}

fn skip_audio_map(ffmpeg: &PathBuf, input: &str, audio_language: Option<&str>) -> String {
    #[cfg(target_os = "macos")]
    {
        preferred_audio_map(ffmpeg, input, audio_language)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (ffmpeg, input, audio_language);
        "0:a:0?".into()
    }
}

/// Mono 8 kHz signed 16-bit PCM of [start, start + duration) for the skip
/// intro fingerprints (src/lib/skip/fingerprint.ts). Less at the end of the
/// file or of what a stream can deliver.
fn skip_media_pcm_sync(
    owner: String,
    input: String,
    start_seconds: f64,
    duration_seconds: f64,
    audio_language: Option<String>,
) -> Result<Vec<u8>, String> {
    // A read for something else (the previous episode) is stopped first.
    stop_skip_read(|current| current != owner);
    let _reader = SKIP_READER_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Skip reader lock failed")?;
    let (ffmpeg, input) = skip_ffmpeg(&input)?;
    let start_seconds = if start_seconds.is_finite() {
        start_seconds.max(0.0)
    } else {
        0.0
    };
    let duration_seconds = if duration_seconds.is_finite() {
        duration_seconds.clamp(1.0, 120.0)
    } else {
        60.0
    };
    let audio_map = skip_audio_map(&ffmpeg, &input, audio_language.as_deref());
    let mut command = Command::new(ffmpeg);
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    if input.starts_with("http://") || input.starts_with("https://") {
        command.args(["-rw_timeout", "10000000"]);
    }
    if start_seconds > 0.0 {
        command.args(["-ss", &format!("{start_seconds:.3}")]);
    }
    let child = command
        .arg("-i")
        .arg(&input)
        .args(["-map", &audio_map, "-t", &format!("{duration_seconds:.3}")])
        .args([
            "-vn", "-sn", "-dn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not read the video audio: {error}"))?;
    let pid = child.id();
    if let Ok(mut current) = skip_read().lock() {
        *current = Some((owner, pid));
    }
    let output = child.wait_with_output();
    if let Ok(mut current) = skip_read().lock() {
        if current.as_ref().is_some_and(|(_, running)| *running == pid) {
            *current = None;
        }
    }
    let output = output.map_err(|error| format!("Could not read the video audio: {error}"))?;
    if !output.status.success() && output.stdout.is_empty() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "The audio could not be read: {}",
            detail.lines().last().unwrap_or("unknown FFmpeg error")
        ));
    }
    let mut bytes = output.stdout;
    bytes.truncate(bytes.len() & !1);
    Ok(bytes)
}

#[tauri::command]
async fn skip_media_pcm(
    owner: String,
    input: String,
    start_seconds: f64,
    duration_seconds: f64,
    audio_language: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        skip_media_pcm_sync(owner, input, start_seconds, duration_seconds, audio_language)
    })
    .await
    .map_err(|error| format!("Skip reader stopped: {error}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The player moved on: stop that file's read now instead of letting it finish.
#[tauri::command]
fn skip_media_cancel(owner: String) {
    stop_skip_read(|current| current == owner);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SkipMediaProbe {
    /// FFmpeg metadata text with the chapters (parsed in src/lib/skip/markers.ts).
    metadata: String,
    /// The file's own duration in seconds (0 when FFmpeg reports none).
    duration: f64,
}

/// "  Duration: 00:43:12.34, start: ..." from FFmpeg's input report.
fn ffmpeg_reported_duration(report: &str) -> f64 {
    report
        .lines()
        .find_map(|line| line.trim().strip_prefix("Duration: "))
        .and_then(|rest| rest.split(',').next())
        .and_then(|clock| {
            let parts = clock
                .trim()
                .split(':')
                .map(str::parse::<f64>)
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            (parts.len() == 3).then(|| parts[0] * 3600.0 + parts[1] * 60.0 + parts[2])
        })
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .unwrap_or(0.0)
}

/// Chapters and true duration of a file (the catalog runtime is only approximate).
fn skip_media_probe_sync(input: String) -> Result<SkipMediaProbe, String> {
    let (ffmpeg, input) = skip_ffmpeg(&input)?;
    let mut command = Command::new(ffmpeg);
    command.args(["-hide_banner", "-loglevel", "info", "-nostdin"]);
    if input.starts_with("http://") || input.starts_with("https://") {
        command.args(["-rw_timeout", "8000000"]);
    }
    let output = command
        .arg("-i")
        .arg(&input)
        .args(["-f", "ffmetadata", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not read the chapters: {error}"))?;
    Ok(SkipMediaProbe {
        metadata: String::from_utf8_lossy(&output.stdout).into_owned(),
        duration: ffmpeg_reported_duration(&String::from_utf8_lossy(&output.stderr)),
    })
}

#[tauri::command]
async fn skip_media_probe(input: String) -> Result<SkipMediaProbe, String> {
    tauri::async_runtime::spawn_blocking(move || skip_media_probe_sync(input))
        .await
        .map_err(|error| format!("Chapter reader stopped: {error}"))?
}

fn stop_hls_process(id: &str) {
    if let Ok(mut processes) = hls_processes().lock() {
        if let Some(mut child) = processes.remove(id) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn stop_all_hls_processes() {
    if let Ok(mut processes) = hls_processes().lock() {
        for (_, mut child) in processes.drain() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// FFmpeg is a child process, so a crash or force quit can leave an older
/// converter alive after Akflix relaunches. Kill only converters writing into
/// Akflix's private HLS directory; unrelated FFmpeg jobs are never touched.
#[cfg(unix)]
fn stop_orphaned_hls_processes() {
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
        return;
    };
    let report = String::from_utf8_lossy(&output.stdout);
    for line in report.lines() {
        let trimmed = line.trim();
        let Some((pid, command)) = trimmed.split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid.parse::<i32>() else {
            continue;
        };
        let executable_is_ffmpeg = command
            .split_whitespace()
            .next()
            .and_then(|value| PathBuf::from(value).file_name().map(|name| name.to_owned()))
            .and_then(|name| name.to_str().map(str::to_owned))
            .is_some_and(|name| name == "ffmpeg" || name.starts_with("ffmpeg-"));
        if executable_is_ffmpeg && command.contains(".akflix-hls") {
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
}

#[cfg(not(unix))]
fn stop_orphaned_hls_processes() {}

#[cfg(unix)]
fn set_hls_process_paused(id: &str, paused: bool) -> Result<(), String> {
    let mut processes = hls_processes()
        .lock()
        .map_err(|_| "HLS process lock failed")?;
    let child = processes
        .get_mut(id)
        .ok_or("Compatibility stream is not running")?;
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("Compatibility stream already ended".into());
    }
    let signal = if paused { libc::SIGSTOP } else { libc::SIGCONT };
    let result = unsafe { libc::kill(child.id() as i32, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(not(unix))]
fn set_hls_process_paused(_id: &str, _paused: bool) -> Result<(), String> {
    Ok(())
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

/// Convert containers/codecs WebKit cannot play into an HLS event playlist
/// that keeps every segment. The platform media encoder keeps this hardware
/// accelerated where the operating system exposes one.
fn start_hls_input(
    input: String,
    stream_id: String,
    audio_language: Option<String>,
    start_seconds: Option<f64>,
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
    let start_seconds = start_seconds
        .filter(|value| value.is_finite())
        .unwrap_or_default()
        .max(0.0);
    let seek_value = format!("{start_seconds:.3}");
    let mut command = Command::new(ffmpeg);
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "warning",
            "-nostdin",
            "-fflags",
            "+genpts",
        ]);
    // Stay ahead of the viewer without converting the whole title onto disk at
    // once. `-re` pinned output to real time, which left WebKit under a second
    // of buffer: any late torrent piece or busy CPU stalled playback, most of
    // all right after a skip. The burst gives every start and skip ~20 s of
    // cushion, 1.5x keeps it growing, and catch-up refills it after the
    // source stalls. The player loads the playlist at its first segment, so
    // running ahead never makes WebKit start at the live edge. Requires
    // FFmpeg 7.1+; every Akflix build bundles 8.1.
    command.args([
        "-readrate",
        "1.5",
        "-readrate_initial_burst",
        "20",
        "-readrate_catchup",
        "4",
    ]);
    if start_seconds > 0.05 {
        // Input-side seeking makes FFmpeg issue a byte-range request near the
        // requested timestamp instead of converting every preceding minute.
        command.args(["-ss", &seek_value]);
    }
    command
        .arg("-i")
        .arg(&input)
        .args(["-map", "0:v:0", "-map"])
        .arg(audio_map)
        // Normalize imperfect torrent timestamps into one monotonic timeline.
        // This also guarantees that a seek-restarted conversion begins at zero;
        // the frontend adds its requested timeline offset exactly once.
        .args(["-vf", "setpts=PTS-STARTPTS", "-af", "asetpts=PTS-STARTPTS"])
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
            "0",
            "-hls_playlist_type",
            "event",
            "-hls_flags",
            "independent_segments+temp_file",
            "-hls_segment_filename",
        ])
        .arg(&segment_pattern)
        .arg(&playlist)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start FFmpeg: {error}"))?;

    let pid = register_hls_process(&id, child)?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        if hls_playlist_has_media(&playlist) {
            return Ok(format!("Streaming%20Cache/.akflix-hls/{id}/index.m3u8"));
        }
        match hls_child_state(&id, pid) {
            HlsChildState::Running => {}
            HlsChildState::Exited => {
                stop_hls_process(&id);
                return Err("FFmpeg could not read this source yet".into());
            }
            // Stopped by the player or superseded by a newer seek.
            HlsChildState::Replaced => {
                return Err("The compatibility stream was replaced".into());
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    if hls_child_state(&id, pid) != HlsChildState::Replaced {
        stop_hls_process(&id);
    }
    Err("Timed out preparing the compatibility stream".into())
}

/// FFmpeg rewrites the playlist after every finished segment, so it can play
/// once it lists a segment with real duration. When the input fails or ends
/// right away (a seek into torrent data that never arrives, or past the end),
/// FFmpeg still leaves a playlist on exit: one zero-length segment and an end
/// marker, which WebKit rejects as an unplayable source.
fn hls_playlist_has_media(playlist: &Path) -> bool {
    fs::read_to_string(playlist).is_ok_and(|text| {
        text.lines().any(|line| {
            line.strip_prefix("#EXTINF:")
                .and_then(|rest| rest.split(',').next())
                .and_then(|seconds| seconds.trim().parse::<f64>().ok())
                .is_some_and(|seconds| seconds > 0.0)
        })
    })
}

/// Track the converter for a stream. Commands no longer queue on the main
/// thread, so a quick seek can start a conversion while an older one for the
/// same stream is still registered; never leave that one running unowned.
fn register_hls_process(id: &str, child: Child) -> Result<u32, String> {
    let pid = child.id();
    let previous = hls_processes()
        .lock()
        .map_err(|_| "HLS process lock failed")?
        .insert(id.to_string(), child);
    if let Some(mut previous) = previous {
        let _ = previous.kill();
        let _ = previous.wait();
    }
    Ok(pid)
}

#[derive(PartialEq)]
enum HlsChildState {
    Running,
    Exited,
    Replaced,
}

fn hls_child_state(id: &str, pid: u32) -> HlsChildState {
    let Ok(mut processes) = hls_processes().lock() else {
        return HlsChildState::Replaced;
    };
    match processes.get_mut(id) {
        Some(child) if child.id() == pid => match child.try_wait() {
            Ok(None) => HlsChildState::Running,
            _ => HlsChildState::Exited,
        },
        _ => HlsChildState::Replaced,
    }
}

#[tauri::command]
async fn start_hls_stream(
    relative_path: String,
    stream_id: String,
    audio_language: Option<String>,
    start_seconds: Option<f64>,
) -> Result<String, String> {
    off_main_thread(move || {
        start_hls_stream_sync(relative_path, stream_id, audio_language, start_seconds)
    })
    .await
}

fn start_hls_stream_sync(
    relative_path: String,
    stream_id: String,
    audio_language: Option<String>,
    start_seconds: Option<f64>,
) -> Result<String, String> {
    let root = downloads_root().ok_or("Could not locate downloads")?;
    let relative = PathBuf::from(&relative_path);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
        || is_engine_state_path(&relative)
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
        start_seconds,
    )
}

#[tauri::command]
async fn start_hls_url(
    input_url: String,
    stream_id: String,
    audio_language: Option<String>,
    start_seconds: Option<f64>,
) -> Result<String, String> {
    if !input_url.starts_with("http://127.0.0.1:3031/torrents/") {
        return Err("Only the embedded local stream can be transcoded".into());
    }
    off_main_thread(move || start_hls_input(input_url, stream_id, audio_language, start_seconds))
        .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedEngineStatus {
    torrent_engine: bool,
    ffmpeg: bool,
    caption_model: bool,
    media_path: Option<String>,
}

#[tauri::command]
async fn embedded_engine_status(app: tauri::AppHandle) -> Result<EmbeddedEngineStatus, String> {
    off_main_thread(move || {
        Ok(EmbeddedEngineStatus {
            torrent_engine: rqbit_ready(),
            ffmpeg: find_ffmpeg().is_some(),
            caption_model: caption_model_path(&app).is_some(),
            media_path: downloads_root().map(|path| path.to_string_lossy().into_owned()),
        })
    })
    .await
}

#[tauri::command]
async fn ensure_embedded_torrent_engine(
    app: tauri::AppHandle,
) -> Result<MediaStorageStatus, String> {
    off_main_thread(move || {
        start_embedded_torrent_engine(&app)?;
        build_media_storage_status(&app)
    })
    .await
}

#[tauri::command]
async fn stop_hls_stream(stream_id: String) -> Result<(), String> {
    let id = safe_stream_id(&stream_id).ok_or("Invalid stream id")?;
    off_main_thread(move || {
        stop_hls_process(&id);
        if let Some(root) = downloads_root() {
            let _ = fs::remove_dir_all(root.join("Streaming Cache/.akflix-hls").join(id));
        }
        Ok(())
    })
    .await
}

#[tauri::command]
fn set_hls_stream_paused(stream_id: String, paused: bool) -> Result<(), String> {
    let id = safe_stream_id(&stream_id).ok_or("Invalid stream id")?;
    set_hls_process_paused(&id, paused)
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

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = {
        // Must be registered first: a second app launch (e.g. the OS opening
        // a magnet link) focuses the running instance instead of starting a
        // new one; the deep-link plugin receives the URL.
        builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                show_main_window(app);
            }))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
    };

    let app = builder
        // CORS-free fetch for the frontend (Jellyfin / qBittorrent / Prowlarr).
        .plugin(tauri_plugin_http::init())
        // Open external links in the OS default handler.
        .plugin(tauri_plugin_opener::init())
        // Native folder picker for choosing a fast media/cache drive.
        .plugin(tauri_plugin_dialog::init())
        // magnet: scheme handling (config in tauri.conf.json > plugins.deep-link).
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            start_hls_stream,
            start_hls_url,
            stop_hls_stream,
            set_hls_stream_paused,
            transcribe_caption_chunk,
            skip_media_pcm,
            skip_media_probe,
            skip_media_cancel,
            embedded_engine_status,
            ensure_embedded_torrent_engine,
            available_media_storage,
            media_storage_status,
            configure_media_storage,
            reset_media_storage,
            remove_embedded_media_files,
            signin::signin_browser_start,
            signin::signin_browser_cancel
        ])
        .setup(|_app| {
            #[cfg(desktop)]
            {
                let app = _app;
                stop_orphaned_hls_processes();
                // Let the window appear immediately. The frontend readiness
                // screen follows this startup and explains any real action the
                // user needs to take instead of leaving a blank launch window.
                let startup_app = app.handle().clone();
                thread::spawn(move || {
                    if let Err(error) = start_embedded_torrent_engine(&startup_app) {
                        eprintln!("Akflix embedded engine warning: {error}");
                    }
                });
                monitor_embedded_torrent_engine(app.handle().clone());
                start_stream_gateway();
                let open = MenuItem::with_id(app, "open", "Open Akflix", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &quit])?;

                // One tray icon only (tauri.conf.json no longer declares a second,
                // menu-less "main" tray). macOS gets the monochrome glyph as a
                // template image so it follows the menu bar's light/dark tint;
                // Windows/Linux keep the app icon (white glyph on a black tile),
                // which stays visible on both light and dark taskbars.
                #[cfg(target_os = "macos")]
                let tray = TrayIconBuilder::with_id("akflix-tray")
                    .icon(tauri::include_image!("icons/tray-template.png"))
                    .icon_as_template(true);
                #[cfg(not(target_os = "macos"))]
                let tray = TrayIconBuilder::with_id("akflix-tray")
                    .icon(app.default_window_icon().unwrap().clone());
                tray
                    .tooltip("Akflix")
                    .menu(&menu)
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "open" => show_main_window(app),
                        "quit" => {
                            stop_all_hls_processes();
                            stop_embedded_torrent_engine();
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .build(app)?;
            }

            Ok(())
        })
        // Closing the window hides to tray (playback/downloads keep running).
        // Quit for real via the tray menu or Cmd+Q.
        .on_window_event(|_window, _event| {
            #[cfg(desktop)]
            {
                if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                    let _ = _window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Akflix");

    app.run(|_app, _event| {
        #[cfg(desktop)]
        {
            if matches!(_event, tauri::RunEvent::Exit) {
                stop_all_hls_processes();
                stop_embedded_torrent_engine();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_folder(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("akflix-{name}-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn reads_the_duration_ffmpeg_reports_for_skip_detection() {
        let report = "Input #0, matroska,webm, from 'e1.mkv':\n  Metadata:\n    ENCODER         : Lavf62\n  Duration: 00:43:12.34, start: 0.000000, bitrate: 98 kb/s\n";
        assert!((ffmpeg_reported_duration(report) - 2592.34).abs() < 1e-6);
        assert_eq!(ffmpeg_reported_duration("  Duration: N/A, start: 0.0"), 0.0);
        assert_eq!(ffmpeg_reported_duration(""), 0.0);
    }

    #[test]
    fn a_skip_read_nobody_wants_any_more_is_stopped() {
        if find_ffmpeg().is_none() {
            eprintln!("no ffmpeg: skipped");
            return;
        }
        // A source that accepts the connection and then never sends a byte.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}/stalled.mkv", listener.local_addr().expect("address"));
        thread::spawn(move || {
            let mut open = Vec::new();
            for stream in listener.incoming().flatten() {
                open.push(stream);
            }
        });
        let started = std::time::Instant::now();
        let reader = thread::spawn(move || skip_media_pcm_sync("old".into(), url, 0.0, 60.0, None));
        while !reader.is_finished() && started.elapsed() < Duration::from_secs(20) {
            thread::sleep(Duration::from_millis(200));
            skip_media_cancel("old".into());
        }
        let result = reader.join().expect("reader");
        assert!(
            started.elapsed() < Duration::from_secs(9),
            "a stopped read took {:?} (FFmpeg's own timeout is 10 s after a 4 s probe)",
            started.elapsed()
        );
        assert!(result.map(|pcm| pcm.is_empty()).unwrap_or(true));
    }

    /// An FFmpeg that can synthesise test media (`-f lavfi`). The bundled build has
    /// no libavdevice, so it can't make the fixture; the reader under test still
    /// runs through `find_ffmpeg()`, i.e. the bundled build.
    fn fixture_ffmpeg() -> Option<PathBuf> {
        std::env::var_os("AKFLIX_FIXTURE_FFMPEG")
            .map(PathBuf::from)
            .into_iter()
            .chain(
                ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]
                    .map(PathBuf::from),
            )
            .find(|path| path.is_file())
    }

    #[test]
    fn skip_reader_returns_8khz_mono_pcm_chapters_and_duration() {
        if find_ffmpeg().is_none() {
            eprintln!("no ffmpeg: skipped");
            return;
        }
        let Some(ffmpeg) = fixture_ffmpeg() else {
            eprintln!("no FFmpeg with lavfi to make the fixture: skipped");
            return;
        };
        // media:// paths resolve under the test media root (a temporary folder), the
        // same root every other test uses, so parallel tests agree on it.
        let name = format!(".akflix-skip-test-{}", std::process::id());
        let folder = test_media_root().join(&name);
        fs::create_dir_all(&folder).expect("create folder");
        let chapters = folder.join("chapters.txt");
        fs::write(
            &chapters,
            ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=4000\nEND=10000\ntitle=Episode\n",
        )
        .expect("write chapters");
        let status = Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg("sine=frequency=440:duration=10:sample_rate=44100")
            .arg("-i")
            .arg(&chapters)
            .args(["-map_chapters", "1", "-c:a", "aac"])
            .arg(folder.join("tone.mkv"))
            .status()
            .expect("run ffmpeg");
        assert!(status.success());
        let input = format!("media://{name}/tone.mkv");

        let pcm = skip_media_pcm_sync("test".into(), input.clone(), 2.0, 3.0, None).expect("pcm");
        assert!(
            (pcm.len() as i64 - 48_000).abs() <= 400,
            "3 s of 8 kHz 16-bit mono, got {} bytes",
            pcm.len()
        );
        let tail = skip_media_pcm_sync("test".into(), input.clone(), 8.0, 60.0, None)
            .expect("pcm at the end");
        assert!(
            (tail.len() as i64 - 32_000).abs() <= 2_000,
            "only what is left: {} bytes",
            tail.len()
        );

        let probe = skip_media_probe_sync(input).expect("probe");
        assert!(probe.metadata.contains("title=Intro"), "{}", probe.metadata);
        assert!(
            (probe.duration - 10.0).abs() < 0.2,
            "duration {}",
            probe.duration
        );
        assert!(skip_media_probe_sync("media://../escape.mkv".into()).is_err());
        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn pauses_persisted_torrents_on_every_launch() {
        let state = unique_test_folder("session-migration");
        fs::create_dir_all(&state).expect("create state folder");
        let session_path = state.join("session.json");
        fs::write(
            &session_path,
            br#"{"torrents":{"1":{"info_hash":"abc","is_paused":false}}}"#,
        )
        .expect("write session");

        pause_persisted_torrents(&state).expect("pause session");
        let migrated: serde_json::Value =
            serde_json::from_slice(&fs::read(&session_path).expect("read migrated session"))
                .expect("parse migrated session");
        assert_eq!(migrated["torrents"]["1"]["is_paused"], true);
        fs::write(
            &session_path,
            br#"{"torrents":{"1":{"info_hash":"abc","is_paused":false}}}"#,
        )
        .expect("restore session");
        pause_persisted_torrents(&state).expect("pause restored session");
        let paused_again: serde_json::Value =
            serde_json::from_slice(&fs::read(&session_path).expect("read restored session"))
                .expect("parse restored session");
        assert_eq!(paused_again["torrents"]["1"]["is_paused"], true);

        fs::remove_dir_all(state).expect("remove test folder");
    }

    #[cfg(unix)]
    #[test]
    fn pauses_and_resumes_registered_hls_process() {
        let id = format!("test-hls-{}", std::process::id());
        let child = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("start test process");
        hls_processes()
            .lock()
            .expect("HLS process lock")
            .insert(id.clone(), child);

        set_hls_process_paused(&id, true).expect("pause HLS process");
        set_hls_process_paused(&id, false).expect("resume HLS process");
        stop_hls_process(&id);
        assert!(!hls_processes()
            .lock()
            .expect("HLS process lock")
            .contains_key(&id));
    }

    #[cfg(unix)]
    #[test]
    fn registering_a_newer_conversion_stops_the_older_one() {
        let id = format!("test-replace-{}", std::process::id());
        let older = Command::new("/bin/sleep").arg("30").spawn().expect("older");
        let older_pid = older.id() as i32;
        register_hls_process(&id, older).expect("register older");
        let newer = Command::new("/bin/sleep").arg("30").spawn().expect("newer");
        let newer_pid = register_hls_process(&id, newer).expect("register newer");

        // kill(pid, 0) fails once the older converter has been stopped and reaped.
        assert_ne!(
            unsafe { libc::kill(older_pid, 0) },
            0,
            "older converter still running"
        );
        assert!(hls_child_state(&id, newer_pid) == HlsChildState::Running);
        stop_hls_process(&id);
        assert!(hls_child_state(&id, newer_pid) == HlsChildState::Replaced);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn restarting_a_conversion_with_bundled_ffmpeg_leaves_a_single_converter() {
        let root = test_media_root();
        let ffmpeg = find_ffmpeg().expect("bundled ffmpeg");
        let (width, height, frames) = (160usize, 120usize, 24 * 8);
        let frame = width * height * 3 / 2;
        let mut pattern = vec![128u8; frame * frames];
        for index in 0..frames {
            for pixel in 0..width * height {
                pattern[index * frame + pixel] = ((pixel + index * 3) & 0xff) as u8;
            }
        }
        let raw = root.join(format!("pattern-{}.yuv", std::process::id()));
        let input = root.join(format!("pattern-{}.mp4", std::process::id()));
        fs::write(&raw, &pattern).expect("write raw frames");
        let encoded = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo"])
            .args(["-pix_fmt", "yuv420p", "-s", "160x120", "-r", "24", "-i"])
            .arg(&raw)
            .args(["-c:v", "h264_videotoolbox", "-allow_sw", "1"])
            .arg(&input)
            .status()
            .expect("run ffmpeg");
        assert!(encoded.success());

        let id = format!("a1f{:08x}", std::process::id());
        let source = input.to_string_lossy().into_owned();
        let first = thread::spawn({
            let (source, id) = (source.clone(), id.clone());
            move || start_hls_input(source, id, None, None)
        });
        thread::sleep(Duration::from_millis(30));
        let second = start_hls_input(source, id.clone(), None, None);
        let _ = first.join().expect("first conversion thread");
        assert!(second.is_ok(), "{second:?}");

        let converters = || {
            let output = Command::new("pgrep")
                .args(["-f", &format!(".akflix-hls/{id}/")])
                .output()
                .expect("run pgrep");
            String::from_utf8_lossy(&output.stdout).lines().count()
        };
        assert_eq!(converters(), 1, "an older conversion was left running");
        stop_hls_process(&id);
        assert_eq!(converters(), 0);
        let _ = fs::remove_file(raw);
        let _ = fs::remove_file(input);
    }

    #[test]
    fn only_a_playlist_with_a_real_segment_is_ready() {
        let folder = unique_test_folder("playlist-ready");
        fs::create_dir_all(&folder).expect("create playlist folder");
        let playlist = folder.join("index.m3u8");
        let header = "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n";
        assert!(!hls_playlist_has_media(&playlist), "missing playlist");
        fs::write(&playlist, header).expect("write header");
        assert!(!hls_playlist_has_media(&playlist), "header only");
        // What FFmpeg leaves behind when its input fails before any frame.
        fs::write(
            &playlist,
            format!("{header}#EXTINF:0.000000,\nsegment-000000.ts\n#EXT-X-ENDLIST\n"),
        )
        .expect("write empty playlist");
        assert!(!hls_playlist_has_media(&playlist), "zero-length segment");
        fs::write(
            &playlist,
            format!("{header}#EXTINF:1.001000,\nsegment-000000.ts\n"),
        )
        .expect("write playlist");
        assert!(hls_playlist_has_media(&playlist));
        fs::remove_dir_all(folder).expect("remove playlist folder");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_restart_that_converts_nothing_is_an_error_not_a_stream() {
        let root = test_media_root();
        let ffmpeg = find_ffmpeg().expect("bundled ffmpeg");
        let raw = root.join(format!("short-{}.yuv", std::process::id()));
        let input = root.join(format!("short-{}.mp4", std::process::id()));
        let frame = 160 * 120 * 3 / 2;
        let pattern: Vec<u8> = (0..frame * 72).map(|index| (index % 251) as u8).collect();
        fs::write(&raw, &pattern).expect("write raw frames");
        let encoded = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo"])
            .args(["-pix_fmt", "yuv420p", "-s", "160x120", "-r", "24", "-i"])
            .arg(&raw)
            .args(["-c:v", "h264_videotoolbox", "-allow_sw", "1"])
            .arg(&input)
            .status()
            .expect("run ffmpeg");
        assert!(encoded.success());

        // A skip past everything the source can deliver: FFmpeg opens it,
        // converts nothing and exits with a zero-length playlist.
        let id = format!("b2f{:08x}", std::process::id());
        let result = start_hls_input(
            input.to_string_lossy().into_owned(),
            id.clone(),
            None,
            Some(60.0),
        );
        assert_eq!(
            result,
            Err("FFmpeg could not read this source yet".to_string())
        );
        stop_hls_process(&id);
        let _ = fs::remove_file(raw);
        let _ = fs::remove_file(input);
    }

    /// Media root for tests: the temporary folder, never the repository's disk.
    fn test_media_root() -> PathBuf {
        APP_MEDIA_ROOT
            .get_or_init(|| {
                let root = unique_test_folder("media-root");
                fs::create_dir_all(&root).expect("create test media root");
                root
            })
            .clone()
    }

    #[test]
    fn reports_storage_and_removes_only_scoped_media() {
        let root = test_media_root();
        let relative = PathBuf::from(".akflix-cleanup-test/nested/test.bin");
        let target = root.join(&relative);
        fs::create_dir_all(target.parent().expect("test parent")).expect("create test folder");
        fs::write(&target, b"temporary").expect("write test file");

        assert!(available_bytes(&root).expect("available bytes") > 0);
        remove_media_files(vec![relative.to_string_lossy().into_owned()])
            .expect("remove temporary media");
        assert!(!target.exists());
        assert!(root.exists());

        remove_media_files(vec!["../outside".into()]).expect("unsafe paths are ignored");
    }

    #[test]
    fn keeps_engine_state_with_the_selected_media_drive() {
        let app_data =
            std::path::Path::new("/Users/test/Library/Application Support/com.akshayan.akflix");
        assert_eq!(
            engine_state_dir(app_data, &app_data.join("Media")),
            app_data.join("Engine")
        );
        assert_eq!(
            engine_state_dir(
                app_data,
                std::path::Path::new("/Volumes/Akflix 5/Akflix Media")
            ),
            PathBuf::from("/Volumes/Akflix 5/Akflix Media/.akflix-engine")
        );
    }

    #[test]
    fn copies_the_previous_engine_session_once_and_keeps_the_original() {
        let root = unique_test_folder("state-migration");
        let legacy = root.join("Engine");
        let state = root.join("Media/.akflix-engine");
        fs::create_dir_all(&legacy).expect("create legacy state");
        fs::create_dir_all(state.parent().expect("media root")).expect("create media root");
        let session = br#"{"torrents":{"0":{"info_hash":"abc","is_paused":false}}}"#;
        fs::write(legacy.join("session.json"), session).expect("write legacy session");
        fs::write(legacy.join("abc.torrent"), b"torrent bytes").expect("write torrent");

        prepare_engine_state(&legacy, &state).expect("migrate state");
        assert_eq!(
            fs::read(state.join("session.json")).expect("migrated session"),
            session
        );
        assert_eq!(
            fs::read(state.join("abc.torrent")).expect("migrated torrent"),
            b"torrent bytes"
        );
        assert_eq!(
            fs::read(legacy.join("session.json")).expect("legacy kept"),
            session
        );
        assert!(!state.with_extension("migrating").exists());

        // The media drive's own session is authoritative from now on.
        fs::write(state.join("session.json"), br#"{"torrents":{}}"#).expect("update state");
        prepare_engine_state(&legacy, &state).expect("second launch");
        assert_eq!(
            fs::read(state.join("session.json")).expect("state kept"),
            br#"{"torrents":{}}"#
        );

        // Never mix the previous session into a folder something else owns.
        let occupied = root.join("Other/.akflix-engine");
        fs::create_dir_all(&occupied).expect("create occupied state");
        fs::write(occupied.join("unrelated.bitv"), b"x").expect("write unrelated");
        prepare_engine_state(&legacy, &occupied).expect("occupied folder");
        assert!(!occupied.join("session.json").exists());

        fs::remove_dir_all(root).expect("remove test folder");
    }

    #[test]
    fn never_serves_or_deletes_the_engine_state_folder() {
        let root = test_media_root();
        assert!(safe_media_path("/.akflix-engine/session.json").is_none());
        assert!(safe_media_path("/%2Eakflix-engine/session.json").is_none());
        assert!(safe_media_path("/Streaming%20Cache/movie.mp4").is_some());

        let state = root.join(".akflix-engine");
        let created = !state.exists();
        fs::create_dir_all(&state).expect("create state folder");
        let marker = state.join(format!("guard-{}", std::process::id()));
        fs::write(&marker, b"state").expect("write marker");
        remove_media_files(vec![".akflix-engine".into(), ".akflix-engine/x".into()])
            .expect("refuse state paths");
        assert!(marker.exists());
        fs::remove_file(&marker).expect("remove marker");
        if created {
            fs::remove_dir(&state).expect("remove state folder");
        }
    }

    #[test]
    fn creates_a_named_media_folder_for_selected_drives() {
        assert_eq!(
            storage_target_for_selection(std::path::Path::new("/Volumes/Akflix 5")),
            PathBuf::from("/Volumes/Akflix 5/Akflix Media")
        );
        assert_eq!(
            storage_target_for_selection(std::path::Path::new("/Volumes/Akflix 5/Akflix Media")),
            PathBuf::from("/Volumes/Akflix 5/Akflix Media")
        );
    }
}
