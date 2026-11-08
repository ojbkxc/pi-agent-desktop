use std::{
    env, fs,
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Manager, Theme, Url};

use crate::shell::WINDOW_LABEL;

#[cfg(not(target_os = "macos"))]
use tauri::webview::Color;

#[cfg(not(target_os = "macos"))]
const LIGHT_WINDOW_BG: Color = Color(247, 247, 245, 255);
#[cfg(not(target_os = "macos"))]
const DARK_WINDOW_BG: Color = Color(28, 28, 30, 255);

/// Persist the UI theme outside the webview origin so cold starts keep the
/// user's light/dark choice even when the local server port changes.
#[tauri::command]
pub fn set_ui_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    let theme =
        normalize_theme(&theme).ok_or_else(|| "theme must be \"light\" or \"dark\"".to_string())?;
    write_ui_prefs_theme(&app, theme)?;
    apply_window_theme(&app, theme);
    Ok(())
}

/// Total size in bytes of every regular file under `path` (0 when missing).
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => dir_size(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// Remove `path` and report how many bytes it held. Failures (a file the
/// webview still has open on Windows) are skipped rather than reported: the
/// next launch clears what is left, and a partial clear is still a clear.
fn remove_counting(path: &Path) -> u64 {
    let size = dir_size(path);
    if fs::remove_dir_all(path).is_ok() {
        size
    } else {
        size.saturating_sub(dir_size(path))
    }
}

/// Delete the webview's disk caches while the app runs and return the bytes
/// freed. Deliberately narrower than `clear_webview_caches`: on macOS that one
/// removes `~/Library/WebKit/<id>`, which also holds `localStorage` (sidebar
/// width, drafts, open tabs), so a user-triggered clear must not touch it.
/// Sessions, settings and credentials live in `~/.pi/agent` and are never
/// reached from here.
fn clear_runtime_caches(app: &AppHandle) -> u64 {
    let mut freed = 0;
    // macOS ~/Library/Caches/<id> (WebKit network cache), Linux ~/.cache/<id>,
    // Windows %LOCALAPPDATA%\<id>.
    if let Ok(cache_dir) = app.path().app_cache_dir() {
        for entry in fs::read_dir(&cache_dir).into_iter().flatten().flatten() {
            if keeps_in_cache_dir(&entry.file_name()) {
                continue;
            }
            freed += remove_counting(&entry.path());
        }
    }
    // Linux WebKitGTK keeps its HTTP cache beside the app data.
    #[cfg(target_os = "linux")]
    if let Ok(data_dir) = app.path().app_data_dir() {
        freed += remove_counting(&data_dir.join("WebKitCache"));
    }
    // Windows WebView2: cache folders inside each profile, never the profile
    // itself (it holds localStorage and cookies). Tauri puts the profile in
    // app_local_data_dir, not the roaming app_data_dir.
    #[cfg(target_os = "windows")]
    if let Ok(data_dir) = app.path().app_local_data_dir() {
        for profile in fs::read_dir(data_dir.join("EBWebView"))
            .into_iter()
            .flatten()
            .flatten()
        {
            for name in WEBVIEW2_CACHE_DIRS {
                freed += remove_counting(&profile.path().join(name));
            }
        }
    }
    freed
}

/// The WebView2 per-profile cache folders. Shared by the user-triggered clear
/// (`clear_runtime_caches`) and the post-upgrade clear
/// (`clear_webview_caches`): clearing only "Cache" on upgrade left the stale
/// "Code Cache" and "GPUCache" of the previous build behind.
#[cfg(target_os = "windows")]
const WEBVIEW2_CACHE_DIRS: [&str; 3] = ["Cache", "Code Cache", "GPUCache"];

/// Directory name under `app_cache_dir` where the packaged server keeps its
/// Node compile cache (`PI_DESKTOP_COMPILE_CACHE_DIR`, set in lib.rs). It is
/// the server's cache, not a webview cache, so no cache clear may remove it.
pub const NODE_COMPILE_CACHE_DIR: &str = "node-compile-cache";

/// On Windows app_cache_dir and app_local_data_dir are the same folder,
/// %LOCALAPPDATA%\<id>, which also holds the WebView2 profile (localStorage),
/// app_log_dir and the server's Node compile cache. Only the caches in it may
/// go.
#[cfg(target_os = "windows")]
fn keeps_in_cache_dir(name: &std::ffi::OsStr) -> bool {
    name == "EBWebView" || name == "logs" || name == NODE_COMPILE_CACHE_DIR
}

#[cfg(not(target_os = "windows"))]
fn keeps_in_cache_dir(name: &std::ffi::OsStr) -> bool {
    name == NODE_COMPILE_CACHE_DIR
}

/// Clear the webview's disk caches on demand (Settings › General).
#[tauri::command]
pub async fn clear_app_cache(app: AppHandle) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || clear_runtime_caches(&app))
        .await
        .map_err(|error| error.to_string())
}

fn ui_prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    Ok(dir.join("ui-prefs.json"))
}

fn normalize_theme(theme: &str) -> Option<&'static str> {
    match theme {
        "light" => Some("light"),
        "dark" => Some("dark"),
        _ => None,
    }
}

fn read_ui_prefs(app: &AppHandle) -> serde_json::Value {
    let Ok(path) = ui_prefs_path(app) else {
        return serde_json::json!({});
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_ui_prefs(app: &AppHandle, prefs: &serde_json::Value) -> Result<(), String> {
    let path = ui_prefs_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(prefs).map_err(|error| error.to_string())?;
    // Write-then-rename: a crash mid-write must not leave a half-written JSON
    // file behind. `read_ui_prefs` silently falls back to `{}` on a parse
    // error, which would lose the theme, the saved server port and the
    // last-version marker in one go. (`fs::rename` replaces an existing
    // target on Windows too, via MOVEFILE_REPLACE_EXISTING.)
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &path).map_err(|error| error.to_string())
}

/// The build's version (from Cargo.toml), known at compile time.
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Path to a small JSON file recording the version that last ran successfully.
fn last_version_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    Ok(dir.join("last-version.json"))
}

fn read_last_version(app: &AppHandle) -> Option<String> {
    let path = last_version_path(app).ok()?;
    let raw = fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

pub fn write_last_version(app: &AppHandle) {
    if let Ok(path) = last_version_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let raw = serde_json::json!({ "version": APP_VERSION });
        if let Ok(body) = serde_json::to_string_pretty(&raw) {
            let _ = fs::write(path, body);
        }
    }
}

/// Clear webview disk caches whose entries are hashed by build (Next.js asset
/// chunks, WebKit HTTP cache, WebView2 partition cache). Stale entries from a
/// previous version still resolve to the old hashed filenames and 404 after an
/// upgrade, which on WebKitGTK surfaces as a hard "This page couldn't load"
/// error page on the next navigation.
///
/// Only the cache directories are touched — `localStorage`, sessions, and
/// user settings live elsewhere and are preserved.
fn clear_webview_caches(app: &AppHandle) {
    // Linux WebKitGTK: ~/.local/share/<identifier>/WebKitCache
    #[cfg(target_os = "linux")]
    if let Ok(data_dir) = app.path().app_data_dir() {
        let webkit_cache = data_dir.join("WebKitCache");
        if webkit_cache.is_dir() {
            let _ = fs::remove_dir_all(&webkit_cache);
        }
    }
    // Windows WebView2: cache partition under the app local data dir. The
    // same folders as `clear_runtime_caches` (WEBVIEW2_CACHE_DIRS): an
    // upgrade that cleared only "Cache" left the previous build's "Code
    // Cache" and "GPUCache" behind.
    #[cfg(target_os = "windows")]
    if let Ok(data_dir) = app.path().app_local_data_dir() {
        let webview2 = data_dir.join("EBWebView");
        if webview2.is_dir() {
            for entry in fs::read_dir(&webview2).into_iter().flatten().flatten() {
                for name in WEBVIEW2_CACHE_DIRS {
                    let cache_dir = entry.path().join(name);
                    if cache_dir.is_dir() {
                        let _ = fs::remove_dir_all(&cache_dir);
                    }
                }
            }
        }
    }
    // macOS WKWebView: the HTTP cache lives in ~/Library/Caches/<identifier>.
    // Never touch ~/Library/WebKit/<identifier>: its WebsiteData holds the
    // origin's localStorage (every Settings switch, sidebar state, drafts), so
    // removing it wiped the user's preferences on every upgrade. The server's
    // Node compile cache shares this directory and stays.
    #[cfg(target_os = "macos")]
    if let Ok(cache_dir) = app.path().app_cache_dir() {
        for entry in fs::read_dir(&cache_dir).into_iter().flatten().flatten() {
            if entry.file_name() == NODE_COMPILE_CACHE_DIR {
                continue;
            }
            remove_counting(&entry.path());
        }
    }
}

/// Detect a version change since the last successful launch and, when one is
/// found, clear stale webview caches before the window loads. The current
/// version is recorded *after* the window is built so a crash during startup
/// keeps flagging a cache clear on the next run.
pub fn reconcile_webview_cache_for_version(app: &AppHandle) {
    let last = read_last_version(app);
    if last.as_deref() != Some(APP_VERSION) {
        clear_webview_caches(app);
    }
}

pub fn read_stored_theme(app: &AppHandle) -> Option<&'static str> {
    read_ui_prefs(app)
        .get("theme")
        .and_then(|value| value.as_str())
        .and_then(normalize_theme)
}

fn write_ui_prefs_theme(app: &AppHandle, theme: &str) -> Result<(), String> {
    let mut prefs = read_ui_prefs(app);
    prefs["theme"] = serde_json::Value::String(theme.to_string());
    write_ui_prefs(app, &prefs)
}

#[cfg(feature = "custom-protocol")]
pub fn read_last_server_port(app: &AppHandle) -> Option<u16> {
    read_ui_prefs(app)
        .get("serverPort")
        .and_then(|value| value.as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
}

#[cfg(feature = "custom-protocol")]
pub fn write_last_server_port(app: &AppHandle, port: u16) {
    let mut prefs = read_ui_prefs(app);
    prefs["serverPort"] = serde_json::Value::from(port);
    let _ = write_ui_prefs(app, &prefs);
}

/// Where Pi Web's own settings live, resolved the way lib/remote-access.ts does:
/// `PI_CODING_AGENT_DIR`, else `PI_AGENT_HOME/.pi/agent`, else the OS home directory.
fn pi_web_settings_path() -> Option<PathBuf> {
    let agent_dir = match env::var("PI_CODING_AGENT_DIR") {
        Ok(value) if !value.trim().is_empty() => expand_home_prefix(value.trim()),
        _ => {
            let home = env::var("PI_AGENT_HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .or_else(|| env::var("USERPROFILE").ok().map(PathBuf::from))
                .or_else(|| env::var("HOME").ok().map(PathBuf::from))?;
            home.join(".pi").join("agent")
        }
    };
    Some(agent_dir.join("pi-web").join("settings.json"))
}

fn expand_home_prefix(value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix('~') {
        if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') {
            let home = env::var("PI_AGENT_HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| env::var("USERPROFILE").ok())
                .or_else(|| env::var("HOME").ok());
            if let Some(home) = home {
                return PathBuf::from(home).join(rest.trim_start_matches(['/', '\\']));
            }
        }
    }
    PathBuf::from(value)
}

/// The listener port saved from the Settings UI (`pi-web/settings.json: serverPort`).
/// The packaged launcher reads the same file; a missing or unreadable one is simply `None`.
#[cfg(feature = "custom-protocol")]
pub fn read_configured_server_port() -> Option<u16> {
    let contents = fs::read_to_string(pi_web_settings_path()?).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let port = parsed.get("serverPort")?.as_u64()?;
    u16::try_from(port).ok().filter(|port| *port >= 1024)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn theme_background_color(theme: &str) -> Color {
    if theme == "dark" {
        DARK_WINDOW_BG
    } else {
        LIGHT_WINDOW_BG
    }
}

pub(crate) fn theme_bootstrap_script(theme: &str) -> String {
    // Runs before page scripts so localStorage/class match the persisted
    // preference even on a fresh webview origin (new localhost port). The
    // native pref is only seeded into localStorage when the origin has no
    // choice recorded yet: the renderer writes "pi-theme" before it invokes
    // `set_ui_theme`, so localStorage is always the freshest user intent and
    // must never be clobbered by a (possibly stale) native pref — e.g. after
    // a crash interrupted the toggle before the IPC round-trip landed.
    format!(
        r#"(function(){{try{{var t=localStorage.getItem("pi-theme");if(!t){{t="{theme}";localStorage.setItem("pi-theme",t);}}var d=t==="dark";document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";}}catch(e){{}}}})();"#
    )
}

/// True when running under a Wayland compositor. `set_background_color` and a
/// few other native chrome APIs dereference a null GdkSurface there and crash,
/// so callers consult this to avoid them.
#[cfg(not(target_os = "macos"))]
pub(crate) fn is_wayland() -> bool {
    env::var("WAYLAND_DISPLAY").is_ok()
        || env::var("GDK_BACKEND")
            .map(|value| value.contains("wayland"))
            .unwrap_or(false)
}

pub fn apply_window_theme(app: &AppHandle, theme: &str) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let tauri_theme = if theme == "dark" {
        Theme::Dark
    } else {
        Theme::Light
    };
    let _ = window.set_theme(Some(tauri_theme));
    // `set_background_color` dereferences a possibly-null GdkSurface under
    // Wayland and segfaults the whole process (frameless WebKitGTK window).
    // The page paints its own opaque background via CSS, so the native chrome
    // color is cosmetic only and is safe to skip on Wayland.
    // On macOS the window is transparent over an NSVisualEffectView, so an
    // opaque native background would hide the vibrancy.
    #[cfg(not(target_os = "macos"))]
    if !is_wayland() {
        let _ = window.set_background_color(Some(theme_background_color(theme)));
    }
}

/// Documents an iframe renders from inline content (`<iframe srcdoc>`, a blank
/// frame). WebKit asks the navigation delegate about sub-frame loads too, so
/// without this the HTML/artifact previews and FileViewer's "Run scripts" mode
/// were cancelled on macOS. They load nothing from the network and cannot move
/// the window, so they stay in the app.
pub fn is_inline_frame_document(url: &Url) -> bool {
    url.scheme() == "about" && matches!(url.path(), "srcdoc" | "blank")
}

pub fn same_origin(candidate: &Url, app_url: &Url) -> bool {
    candidate.scheme() == app_url.scheme()
        && candidate.host_str() == app_url.host_str()
        && candidate.port_or_known_default() == app_url.port_or_known_default()
}
