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
//!     * 💬 Quick Chat      — same as left click
//!     * 🏠 Home            — main window, route `/`
//!     * 📊 Dashboard       — `/dashboard`
//!     * 💬 Chat            — `/chat`
//!     * 🧠 Memory          — `/memory`
//!     * ⚡ Skills           — `/skills`
//!     * 🧩 Skillhub        — `/skillhub`
//!     * 🔌 MCP             — `/mcp`
//!     * ⚙️ Settings        — `/settings`
//!     * 🪟 Open Main Window
//!     * ✕ Quit
//!
//! Navigation menu items push the main window to the front and `eval()` a
//! `location.href` change — the SPA's hash/history router picks it up. No
//! frontend IPC plumbing required.
//!
//! v0.2 (2026-05-22) additions:
//!   - Single-instance lock (second launch focuses the running app instead
//!     of starting a duplicate that would EADDRINUSE on :3000).
//!   - Async wait-for-health: after spawning sub-brain, hold the main and
//!     popup windows hidden until `/health` returns 200, then show. Avoids
//!     the "connection refused white screen" UX on first launch.
//!   - Popup anchored to the tray icon's screen position on left-click,
//!     not floating in the middle of the screen.
//!   - Service status surfaced via `service_status` + a `webrain://ready`
//!     event the frontend can listen for.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, LogicalPosition, Manager, PhysicalPosition, RunEvent,
};

mod service_manager;

use service_manager::{ServiceManager, SpawnOutcome};

/// How long to wait for sub-brain `/health` to return 200 before giving up
/// and showing the windows anyway (so the user can see the error overlay).
/// 45s is the same budget the smoke fixtures use (sentence-transformers
/// cold-load + uvicorn bind takes ~30s on first launch).
const HEALTH_WAIT_TIMEOUT: Duration = Duration::from_secs(45);

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

/// Anchor the popup to a position near the given tray-icon coordinates. We
/// take the tray icon's screen position (top-right corner of the menu bar in
/// macOS) and drop the popup just below + slightly to the left so it lines
/// up naturally with the tray icon rather than floating at the screen center.
///
/// Position is in physical pixels (Tauri's PhysicalPosition); the popup is
/// 400×580 logical pixels in tauri.conf.json. On macOS the menu bar is at
/// the top of the screen, so we anchor below the click point.
fn position_popup_near_tray(app: &tauri::AppHandle, tray_pos: PhysicalPosition<f64>) {
    if let Some(popup) = app.get_webview_window("popup") {
        // Popup width is 400 logical px; nudge left by half so it centers
        // under the tray icon. Drop down 4 px so it doesn't overlap the
        // menu bar.
        // We accept that this is best-effort — multi-monitor setups with
        // mixed DPI may misalign. Users can drag the popup; subsequent
        // shows re-position to the new tray location.
        let x = tray_pos.x - 200.0;
        let y = tray_pos.y + 4.0;
        let _ = popup.set_position(LogicalPosition::new(x, y));
        let _ = popup.show();
        let _ = popup.set_focus();
        let _ = popup.set_always_on_top(true);
    }
}

/// Left-click toggle: if popup visible, hide it; otherwise show it AND
/// anchor to the tray position. We re-anchor on every show because the user
/// might have a different display configuration than at launch.
fn toggle_popup_at(app: &tauri::AppHandle, tray_pos: Option<PhysicalPosition<f64>>) {
    if let Some(popup) = app.get_webview_window("popup") {
        match popup.is_visible() {
            Ok(true) => {
                let _ = popup.hide();
            }
            _ => match tray_pos {
                Some(pos) => position_popup_near_tray(app, pos),
                None => {
                    let _ = popup.show();
                    let _ = popup.set_focus();
                    let _ = popup.set_always_on_top(true);
                }
            },
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

/// After spawning services, run a background task that polls /health and,
/// once the backend is up, shows the main window and emits `webrain://ready`
/// to the frontend.
///
/// Why the main window starts hidden (tauri.conf.json `visible: false`):
/// the webview's initial URL is sub-brain's :3000. If sub-brain isn't up
/// yet, the webview hits ERR_CONNECTION_REFUSED and shows a Chromium error
/// page — terrible first-launch UX. Holding the window hidden until /health
/// passes means the user sees a brief dock-icon-only state, then a fully
/// loaded SPA. On the failure path (timeout), we still show the window so
/// the user can see what's wrong rather than face a permanently invisible app.
fn schedule_health_signal(app: tauri::AppHandle, outcome: SpawnOutcome) {
    std::thread::spawn(move || {
        // If we attached to an existing service, /health is probably already
        // up. Probe once with a short timeout and emit immediately on success.
        let timeout = if outcome == SpawnOutcome::AlreadyRunning {
            Duration::from_secs(3)
        } else {
            HEALTH_WAIT_TIMEOUT
        };
        let ready = {
            let mgr_state = app.state::<Mutex<ServiceManager>>();
            let mgr = mgr_state.lock().expect("service manager mutex poisoned");
            mgr.wait_for_health(timeout)
        };

        // Show the main window regardless of /health outcome. If ready, the
        // SPA loads instantly. If not, the user sees the error overlay (or
        // can use right-click → Quit) instead of being stuck on dock icon.
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.set_focus();
        }

        let payload = serde_json::json!({
            "ready": ready,
            "outcome": match outcome {
                SpawnOutcome::Spawned => "spawned",
                SpawnOutcome::AlreadyRunning => "attached_to_existing",
                SpawnOutcome::Failed => "failed",
            },
            "timeout_s": timeout.as_secs(),
        });
        if let Err(e) = app.emit("webrain://ready", &payload) {
            log::warn!("emit webrain://ready failed: {e}");
        }
        if !ready {
            log::warn!(
                "sub-brain did not become healthy within {}s — UI may show errors",
                timeout.as_secs()
            );
        } else {
            log::info!("sub-brain healthy — UI is good to go");
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    let repo_root = resolve_repo_root();
    log::info!(
        "WeBrain desktop launching, repo root: {}",
        repo_root.display()
    );

    let service_mgr = ServiceManager::new(repo_root.clone());

    tauri::Builder::default()
        // Single-instance plugin: if the user launches WeBrain a second time
        // (double-clicking the dock icon, opening from Finder again, etc.),
        // run this callback in the EXISTING process and exit the duplicate.
        // We use it to bring the main window forward — far less confusing
        // than the previous behavior where the second launch failed silently
        // because :3000 was already bound.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::info!("second instance detected — focusing existing main window");
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
        }))
        .manage(Mutex::new(service_mgr))
        .invoke_handler(tauri::generate_handler![service_status])
        .setup(move |app| {
            // Spawn sub-brain (which in turn spawns main-brain). The new
            // ServiceManager returns SpawnOutcome so we know whether we
            // started a fresh service, attached to an existing one, or
            // failed entirely.
            let outcome = {
                let mgr_state = app.state::<Mutex<ServiceManager>>();
                let mut mgr = mgr_state.lock().expect("service manager mutex poisoned");
                match mgr.spawn_all() {
                    Ok(outcome) => {
                        log::info!("spawn_all → {:?}", outcome);
                        outcome
                    }
                    Err(e) => {
                        // Spawn failed (probably PATH issue or missing pnpm).
                        // We still build the rest of the UI so the user gets
                        // a window with an actionable error, not just a
                        // bouncing dock icon that disappears.
                        log::error!("sub-brain spawn failed: {e} — UI will show an error overlay");
                        SpawnOutcome::Failed
                    }
                }
            };

            // Kick off the health-poll background task. Emits `webrain://ready`
            // when /health responds 200 — or after the timeout if it doesn't.
            schedule_health_signal(app.handle().clone(), outcome);

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
                    &MenuItem::with_id(
                        app,
                        "open_main",
                        "🪟 Open Main Window",
                        true,
                        None::<&str>,
                    )?,
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
                        position,
                        ..
                    } = event
                    {
                        toggle_popup_at(tray.app_handle(), Some(position));
                    }
                })
                .build(app)?;

            // Popup is configured visible:false in tauri.conf.json — belt &
            // suspenders ensure it stays hidden on boot.
            if let Some(popup) = app.get_webview_window("popup") {
                let _ = popup.hide();
            }

            // Brief log to confirm where on disk our log files live — useful
            // for users diagnosing spawn issues.
            if let Some(mgr_state) = app.try_state::<Mutex<ServiceManager>>() {
                if let Ok(mgr) = mgr_state.lock() {
                    log::info!("service status at boot: {}", mgr.status());
                }
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
