use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.get_webview_window("main").map(|w| {
                let _ = w.set_focus();
                let _ = w.show();
            });
        }))
        .setup(|app| {
            // Start sub-brain child process
            let handle = app.handle().clone();
            let child_proc = start_sub_brain(&handle);
            let child_arc = Arc::new(Mutex::new(child_proc));

            // Store child process in app state for cleanup
            app.manage(ChildProcessState {
                child: child_arc.clone(),
            });

            // Spawn health check thread
            let _health_handle = handle.clone();
            thread::spawn(move || {
                let start = Instant::now();
                let timeout = Duration::from_secs(30);
                let mut healthy = false;
                while start.elapsed() < timeout {
                    if check_health() {
                        healthy = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(500));
                }
                if healthy {
                    log::info!("[webrain] Sub-brain health check passed");
                } else {
                    log::warn!("[webrain] Sub-brain health check timed out after 30s");
                }
            });

            // Setup tray
            setup_tray(app)?;

            Ok(())
        })
        .on_window_event(|app, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Hide window instead of closing (tray mode)
                let window = app.get_webview_window("main");
                if let Some(w) = window {
                    let _ = w.hide();
                }
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Default)]
struct ChildProcessState {
    child: Arc<Mutex<Option<Child>>>,
}

fn start_sub_brain(_handle: &tauri::AppHandle) -> Option<Child> {
    let project_root = std::env::current_dir().ok()?;
    let sub_brain_dist = project_root.join("sub-brain").join("dist").join("main.js");

    if !sub_brain_dist.exists() {
        log::warn!(
            "[webrain] sub-brain dist not found at {:?}, trying dev mode",
            sub_brain_dist
        );
    }

    let data_dir = dirs::home_dir()
        .map(|h| h.join(".webrain"))
        .unwrap_or_else(|| project_root.join(".webrain"));

    let mut cmd = Command::new("node");
    cmd.arg(sub_brain_dist)
        .current_dir(&project_root)
        .env("WEBRAIN_DATA_DIR", data_dir)
        .env("WEBRAIN_SUB_BRAIN_PORT", "3456")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    match cmd.spawn() {
        Ok(child) => {
            log::info!("[webrain] Sub-brain spawned (pid={})", child.id());
            Some(child)
        }
        Err(e) => {
            log::error!("[webrain] Failed to spawn sub-brain: {}", e);
            None
        }
    }
}

fn check_health() -> bool {
    match reqwest::blocking::get("http://127.0.0.1:3456/health") {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let show_i = MenuItem::with_id(app, "show", "打开 WeBrain", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&show_i, &sep, &quit_i])?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => {
                cleanup_processes(app);
                app.exit(0);
            }
            "show" => {
                let _ = app.get_webview_window("main").map(|w| {
                    let _ = w.show();
                    let _ = w.set_focus();
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn cleanup_processes(app: &tauri::AppHandle) {
    // 1. Kill sub-brain child process
    if let Some(state) = app.try_state::<ChildProcessState>() {
        let mut lock = state.child.lock().unwrap();
        if let Some(mut child) = lock.take() {
            log::info!("[webrain] Terminating sub-brain (pid={})", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    // 2. Clean up any residual main-brain Python processes
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    let s = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new()),
    );
    for (pid, process) in s.processes() {
        let cmd = process.cmd().join(" ");
        if cmd.contains("main_brain.py") {
            log::info!("[webrain] Killing residual main-brain process (pid={})", pid);
            process.kill();
        }
    }
}
