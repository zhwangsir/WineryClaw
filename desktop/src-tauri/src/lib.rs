//! WeBrain Desktop Shell — Tauri 2.x main library
//!
//! Boots the desktop app, spawns the dual-brain services (sub-brain on :3000,
//! main-brain on UDS /tmp/webrain-main.sock), and shows the existing frontend
//! webview pointed at the vite dev server / packaged dist.
//!
//! Architecture:
//!   Tauri main process (Rust)
//!     ├─ webview → frontend (vite dev :8587 in dev, file://dist in prod)
//!     └─ spawns:
//!          ├─ sub-brain  (Node.js)   `cd sub-brain && pnpm dev`
//!          └─ main-brain (Python)    `sub-brain/main-brain/venv/bin/python main_brain.py`
//!        Both are tracked in `ServiceManager` and SIGTERMed on app quit.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

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
            let mgr_state = app.state::<Mutex<ServiceManager>>();
            let mut mgr = mgr_state.lock().expect("service manager mutex poisoned");
            if let Err(e) = mgr.spawn_all() {
                log::error!("failed to spawn dual-brain services: {}", e);
                // We still show the window so the user can see the error in UI rather
                // than getting a silent fail. Frontend talks to /health to detect.
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
