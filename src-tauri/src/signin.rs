//! Akflix account sign-in on the Mac with Apple or Google.
//!
//! The Mac app is signed locally (ad hoc), which can't carry Apple's native
//! Sign in with Apple entitlement, and Google refuses sign-ins inside embedded
//! web views. So both finish in the default browser on Firebase's own sign-in
//! page: a one-shot loopback server serves the app's bundled `signin.html` on
//! `http://localhost:<port>` (localhost is an authorized sign-in domain by
//! default) and takes the result back on `/result/<state>`, then the frontend
//! continues with the session it carries. The server lives for one attempt.

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tiny_http::{Header, Method, Response, Server};

const RESULT_EVENT: &str = "signin-browser-result";
const ATTEMPT_LIMIT: Duration = Duration::from_secs(15 * 60);
const MAX_RESULT_BYTES: u64 = 64 * 1024;

static CURRENT: Mutex<Option<Arc<Server>>> = Mutex::new(None);

#[derive(serde::Serialize)]
pub struct BrowserSignIn {
    port: u16,
    state: String,
}

fn random_state() -> Result<String, String> {
    // The operating system's generator: /dev/urandom does not exist on Windows.
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("No secure random source: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

/// Only the sign-in page and the built assets it loads.
fn page_asset(path: &str) -> Option<&str> {
    let path = path.trim_start_matches('/');
    let allowed = path == "signin.html"
        || (path.starts_with("assets/") && !path.contains("..") && !path.contains('\\'));
    allowed.then_some(path)
}

fn serve<R: Runtime>(app: AppHandle<R>, server: Arc<Server>, state: String) {
    let deadline = Instant::now() + ATTEMPT_LIMIT;
    let result_path = format!("/result/{state}");
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut request = match server.recv_timeout(remaining) {
            Ok(Some(request)) => request,
            _ => break,
        };
        let path = request.url().split(['?', '#']).next().unwrap_or("").to_string();
        let no_store = header("Cache-Control", "no-store");
        match (request.method().clone(), path.as_str()) {
            (Method::Post, p) if p == result_path => {
                let mut body = String::new();
                let read = request
                    .as_reader()
                    .take(MAX_RESULT_BYTES)
                    .read_to_string(&mut body);
                let _ = request.respond(Response::from_string("ok").with_header(no_store));
                if read.is_ok() && !body.is_empty() {
                    let _ = app.emit(RESULT_EVENT, body);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    break;
                }
            }
            (Method::Get, p) => match page_asset(p).and_then(|asset| app.asset_resolver().get(format!("/{asset}"))) {
                Some(asset) => {
                    let response = Response::from_data(asset.bytes)
                        .with_header(header("Content-Type", &asset.mime_type))
                        .with_header(no_store)
                        .with_header(header("Referrer-Policy", "no-referrer"))
                        .with_header(header("X-Content-Type-Options", "nosniff"));
                    let _ = request.respond(response);
                }
                None => {
                    let _ = request.respond(Response::from_string("Not found").with_status_code(404));
                }
            },
            _ => {
                let _ = request.respond(Response::from_string("Not found").with_status_code(404));
            }
        }
    }
    let mut current = CURRENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if current.as_ref().is_some_and(|active| Arc::ptr_eq(active, &server)) {
        *current = None;
    }
}

/// Starts a browser sign-in attempt; the frontend opens
/// `http://localhost:<port>/signin.html#...` and listens for `signin-browser-result`.
#[tauri::command]
pub fn signin_browser_start<R: Runtime>(app: AppHandle<R>) -> Result<BrowserSignIn, String> {
    signin_browser_cancel();
    let server = Server::http("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|address| address.port())
        .ok_or("The sign-in page couldn't start")?;
    let state = random_state()?;
    let server = Arc::new(server);
    *CURRENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(server.clone());
    let expected = state.clone();
    std::thread::spawn(move || serve(app, server, expected));
    Ok(BrowserSignIn { port, state })
}

/// Ends the current attempt (the person cancelled in the app, or started another).
#[tauri::command]
pub fn signin_browser_cancel() {
    if let Some(server) = CURRENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
        server.unblock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_the_sign_in_page_and_its_assets() {
        assert_eq!(page_asset("/signin.html"), Some("signin.html"));
        assert_eq!(page_asset("/assets/signin-a1b2.js"), Some("assets/signin-a1b2.js"));
        assert_eq!(page_asset("/index.html"), None);
        assert_eq!(page_asset("/assets/../index.html"), None);
        assert_eq!(page_asset("/"), None);
    }

    #[test]
    fn states_are_random_and_long() {
        let first = random_state().unwrap();
        assert_eq!(first.len(), 32);
        assert_ne!(first, random_state().unwrap());
    }
}
