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

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .setup(|app| {
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
                    "quit" => app.exit(0),
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
        .run(tauri::generate_context!())
        .expect("error while running Akflix");
}
