//! WeBrain Desktop Shell — Tauri 2.x main library
//!
//! Boots the desktop app, spawns the dual-brain services (sub-brain on :3000,
//! main-brain on UDS /tmp/webrain-main.sock), shows the main webview window
//! pointed at sub-brain's served frontend, AND installs a macOS-style menu-bar
//! tray icon with this interaction model:
//!
//!   - **Left click**  → directly toggles the compact Quick Chat popup
//!     (most common path — chat lives one click away from anywhere)
//!   - **Right click** → context menu with full navigation:
//!       💬 Quick Chat      — same as left click
//!       ──────
//!       🏠 Home            — main window, route `/`
//!       📊 Dashboard       — `/dashboard`
//!       💬 Chat            — `/chat`
//!       🧠 Memory          — `/memory`
//!       ⚡ Skills           — `/skills`
//!       🧩 Skillhub        — `/skillhub`
//!       🔌 MCP             — `/mcp`
//!       ⚙️ Settings        — `/settings`
//!       ──────
//!       🪟 Open Main Window
//!       ✕ Quit
//!
//! Navigation menu items push the main window to the front and `eval()` a
//! `location.href` change — the SPA's hash/history router picks it up. No
//! frontend IPC plumbing required.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};

mod service_manager;

use service_manager::ServiceManager;

/// Sub-brain origin — main + popup webviews load from this base. Hard-coded
/// because the static.ts in sub-brain only serves on :3000 and the bind is
/// not configurable in current wiring.
const APP_BASE_URL: &str = "http://127.0.0.1:3000";

/// Resolve the repo root by walking up from the binary's CWD until we hit
/// a directory containing `sub-brain/` and `frontend/`. Falls back to CWD.
fn resolve_repo_root() -> PathBuf {
    let mut cur = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    loop {
        if cur.join("sub-brain").is_dir() && cur.join("frontend").is_dir() {
            return cur;
        }
        if !cur.pop() {
            break;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

#[tauri::command]
fn service_status(state: tauri::State<'_, Mutex<ServiceManager>>) -> serde_json::Value {
    let mgr = state.lock().expect("service manager mutex poisoned");
    mgr.status()
}

/// Show & focus the popup, raising it above other windows.
fn show_popup(app: &tauri::AppHandle) {
    if let Some(popup) = app.get_webview_window("popup") {
        let _ = popup.show();
        let _ = popup.set_focus();
        let _ = popup.set_always_on_top(true);
    } else {
        log::warn!("popup window not found");
    }
}

/// Left-click toggle: if popup visible, hide it; otherwise show it.
fn toggle_popup(app: &tauri::AppHandle) {
    if let Some(popup) = app.get_webview_window("popup") {
        match popup.is_visible() {
            Ok(true) => {
                let _ = popup.hide();
            }
            _ => {
                let _ = popup.show();
                let _ = popup.set_focus();
                let _ = popup.set_always_on_top(true);
            }
        }
    }
}

/// Bring the main window forward (creating focus + unminimizing if needed).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
        let _ = main.unminimize();
    }
}

/// Navigate the main window to the given SPA route (`/dashboard`, `/chat`, ...).
/// Brings the window forward first, then uses `history.pushState` +
/// dispatching a `popstate` event so react-router treats it as an internal
/// transition (no full reload, instant route switch).
///
/// Earlier this used `window.location.href = '...'` which triggered a full
/// reload — slow, lost in-flight state, and on the user's machine often
/// appeared as "no response" because the SPA reload took 1–2s.
fn navigate_main_to(app: &tauri::AppHandle, route: &str) {
    let main = match app.get_webview_window("main") {
        Some(w) => w,
        None => {
            log::warn!("main window not found for navigate({route})");
            return;
        }
    };
    let _ = main.show();
    let _ = main.unminimize();
    let _ = main.set_focus();

    // route comes from menu IDs we control — no untrusted input —
    // but defend single-quote injection just in case.
    let safe_route = route.replace('\'', "\\'");
    // pushState first, then synthesize a popstate so react-router's listener
    // picks up the new path. Wrap in try/catch + IIFE so any error is logged
    // server-side via console but doesn't crash the SPA.
    let js = format!(
        r#"(function(){{
          try {{
            window.history.pushState({{ tray: true }}, '', '{safe_route}');
            window.dispatchEvent(new PopStateEvent('popstate', {{ state: {{ tray: true }} }}));
          }} catch (e) {{ console.error('[tray-nav] failed:', e); }}
        }})()"#
    );
    if let Err(e) = main.eval(&js) {
        log::warn!("navigate eval failed for {route}: {e}");
    }
}

/// Quit cleanly: shut down spawned child services first, then `app.exit`.
fn quit_with_shutdown(app: &tauri::AppHandle) {
    if let Some(mgr_state) = app.try_state::<Mutex<ServiceManager>>() {
        if let Ok(mut mgr) = mgr_state.lock() {
            mgr.shutdown_all();
        }
    }
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    let repo_root = resolve_repo_root();
    log::info!("WeBrain desktop launching, repo root: {}", repo_root.display());

    let service_mgr = ServiceManager::new(repo_root.clone());

    tauri::Builder::default()
        .manage(Mutex::new(service_mgr))
        .invoke_handler(tauri::generate_handler![service_status])
        .setup(move |app| {
            // Spawn sub-brain (which in turn spawns main-brain). If something
            // is already listening on :3000 the spawn errors silently; the
            // webview still loads against the existing service.
            {
                let mgr_state = app.state::<Mutex<ServiceManager>>();
                let mut mgr = mgr_state.lock().expect("service manager mutex poisoned");
                if let Err(e) = mgr.spawn_all() {
                    log::warn!("sub-brain spawn returned: {e} (likely already running)");
                }
            }

            // Tray menu (right-click on macOS, left-click shows separately below).
            // Menu item IDs starting with "nav:" are routed through navigate_main_to.
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "open_chat", "💬 Quick Chat", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "nav:/", "🏠 Home", true, None::<&str>)?,
                    &MenuItem::with_id(app, "nav:/dashboard", "📊 Dashboard", true, None::<&str>)?,
                    &MenuItem::with_id(app, "nav:/chat", "💬 Chat", true, None::<&str>)?,
                    &MenuItem::with_id(app, "nav:/memory", "🧠 Memory", true, None::<&str>)?,
                    &MenuItem::with_id(app, "nav:/skills", "⚡ Skills", true, None::<&str>)?,
                    &MenuItem::with_id(app, "nav:/skillhub", "🧩 Skillhub", true, None::<&str>)?,
                    &MenuItem::with_id(app, "nav:/mcp", "🔌 MCP", true, None::<&str>)?,
                    &MenuItem::with_id(app, "nav:/settings", "⚙️ Settings", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "open_main", "🪟 Open Main Window", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "✕ Quit", true, None::<&str>)?,
                ],
            )?;

            // Tray icon. Uses the project's official logo.svg rasterized to
            // 44×44 (macOS menu-bar 22pt @ 2× retina), placed at tray-22x22.png.
            // Colored (NOT template) so the brand mascot stays visible — template
            // mode would collapse the multi-color palette to alpha and render
            // nearly invisible against the macOS Tahoe blue wallpaper.
            let tray_icon_bytes = include_bytes!("../icons/tray-22x22.png");
            let tray_icon = Image::from_bytes(tray_icon_bytes)?;

            let _tray = TrayIconBuilder::with_id("webrain-tray")
                .icon(tray_icon)
                .icon_as_template(false)
                .tooltip("WeBrain — left-click for Quick Chat · right-click for menu")
                .menu(&menu)
                // CRITICAL: left click does NOT show the menu — it goes
                // straight to toggle_popup. Right click still opens the
                // context menu (Tauri default behavior on macOS).
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "open_chat" => show_popup(app),
                        "open_main" => show_main_window(app),
                        "quit" => quit_with_shutdown(app),
                        other => {
                            if let Some(route) = other.strip_prefix("nav:") {
                                navigate_main_to(app, route);
                            } else {
                                log::warn!("unknown menu id: {other}");
                            }
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Left mouse Up triggers the popup. We use Up (not Down)
                    // so a click-and-drag away from the icon doesn't fire.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_popup(tray.app_handle());
                    }
                })
                .build(app)?;

            // Popup is configured visible:false in tauri.conf.json — belt &
            // suspenders ensure it stays hidden on boot.
            if let Some(popup) = app.get_webview_window("popup") {
                let _ = popup.hide();
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri app")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(mgr_state) = app_handle.try_state::<Mutex<ServiceManager>>() {
                    if let Ok(mut mgr) = mgr_state.lock() {
                        mgr.shutdown_all();
                    }
                }
            }
        });
}
