//! WeBrain Desktop Shell — Tauri 2.x main library
//!
//! Boots the desktop app, spawns the dual-brain services (sub-brain on :3000,
//! main-brain on UDS /tmp/webrain-main.sock), shows the main webview window
//! pointed at sub-brain's served frontend, AND installs a macOS-style menu-bar
//! tray icon that toggles a compact "Quick Chat" popup window.
//!
//! Architecture:
//!   Tauri main process (Rust)
//!     ├─ main window     → http://127.0.0.1:3000/        (sub-brain serves SPA + APIs)
//!     ├─ popup window    → http://127.0.0.1:3000/popup-chat  (compact chat surface)
//!     ├─ tray icon       (menu bar) → clicks toggle popup, right-click → menu
//!     └─ spawns:
//!          └─ sub-brain  (Node.js)   `cd sub-brain && pnpm dev`
//!             (main-brain auto-spawned by sub-brain's main-brain-spawn.ts)
//!
//! Why webview loads :3000 instead of file:// — sub-brain's `static.ts` already
//! serves frontend/dist as the root and proxies /api/* to internal routes. Going
//! through it means relative URLs in axios calls "just work" with no protocol
//! mismatch. The previous v0.1.0 file:// load tripped over a startup fetch
//! returning undefined → `.length` crash.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent,
};

mod service_manager;

use service_manager::ServiceManager;

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

/// Show the popup window. Centers near the tray icon click position so the
/// popup feels attached to the menu-bar icon (within Tauri's positioning limits).
fn show_popup(app: &tauri::AppHandle) {
    if let Some(popup) = app.get_webview_window("popup") {
        let _ = popup.show();
        let _ = popup.set_focus();
        let _ = popup.set_always_on_top(true);
    } else {
        log::warn!("popup window not found");
    }
}

#[allow(dead_code)] // reserved for future "close popup via shortcut" wiring
fn hide_popup(app: &tauri::AppHandle) {
    if let Some(popup) = app.get_webview_window("popup") {
        let _ = popup.hide();
    }
}

#[allow(dead_code)] // reserved for future left-click toggle behavior
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

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
        let _ = main.unminimize();
    }
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
                    log::warn!("sub-brain spawn returned: {} (likely already running)", e);
                }
            }

            // Build the menu-bar tray icon. macOS conventions:
            //   left-click → toggle popup
            //   right-click → context menu (Quick Chat / Open Main / Quit)
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "open_chat", "💬 Quick Chat", true, None::<&str>)?,
                    &MenuItem::with_id(app, "open_main", "🪟 Open WeBrain", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "✕ Quit", true, None::<&str>)?,
                ],
            )?;

            // Reuse the bundled app icon for the tray. We keep it as a colored
            // icon (NOT template) so the brand purple-blue is visible against
            // the menu bar — template mode collapsed the gradient to alpha,
            // making the icon nearly invisible against the macOS Tahoe blue
            // wallpaper.
            let tray_icon_bytes = include_bytes!("../icons/32x32.png");
            let tray_icon = Image::from_bytes(tray_icon_bytes)?;

            let _tray = TrayIconBuilder::with_id("webrain-tray")
                .icon(tray_icon)
                .icon_as_template(false)
                .tooltip("WeBrain — click for Quick Chat")
                .menu(&menu)
                // Left-click pops the menu directly (deprecation: the newer
                // `show_menu_on_left_click` replaces `menu_on_left_click`;
                // we use the new API to avoid the warning).
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open_chat" => show_popup(app),
                    "open_main" => show_main_window(app),
                    "quit" => {
                        if let Some(mgr_state) = app.try_state::<Mutex<ServiceManager>>() {
                            if let Ok(mut mgr) = mgr_state.lock() {
                                mgr.shutdown_all();
                            }
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                // With show_menu_on_left_click(true), left-click pops the
                // menu directly. We keep a no-op on_tray_icon_event so future
                // gestures (double-click etc.) can be wired without restructuring.
                .on_tray_icon_event(|_tray, _event| {})
                .build(app)?;

            // The popup window is created hidden via tauri.conf.json; ensure it
            // doesn't pop up at boot.
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
