//! ServiceManager — supervises the dual-brain child processes from Tauri's main.
//!
//! v0.2 (2026-05-22) — hardened for the .app launch path:
//!   - Resolves `pnpm` via `which` + standard PATH fallbacks (Homebrew, Volta,
//!     NVM, asdf). GUI-launched macOS apps inherit a minimal PATH (no shell rc),
//!     so the previous `Command::new("pnpm")` silently failed in Finder launches.
//!   - Redirects child stdout/stderr to per-service log files under the OS
//!     conventional location (`~/Library/Logs/WeBrain/` on macOS). Previously
//!     used `Stdio::inherit()` which is invisible in .app bundles.
//!   - Detects an already-running sub-brain on :3000 via a quick TCP probe and
//!     skips re-spawn rather than producing a confusing EADDRINUSE error.
//!   - Polls `/health` after spawn and reports readiness so the UI layer can
//!     hold the webview navigation until the backend actually accepts requests.
//!   - Graceful shutdown: SIGTERM with a 5s grace period before SIGKILL, so
//!     SQLite WAL files flush and L1/L2 stores complete.
//!
//! Why it's safe to be optimistic about the venv / pnpm paths:
//! - WeBrain documents these as required (see umbrella CLAUDE.md and
//!   webrain-integration/CLAUDE.md "Setup (one-time)").
//! - If either fails to spawn the desktop still launches; the frontend's
//!   `/health` and `/brain/health` probes show the user what's broken.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
use nix::sys::signal::{kill, Signal};
#[cfg(unix)]
use nix::unistd::Pid;

/// Where to put per-service log files. Falls back to the system tmp dir if the
/// platform doesn't expose a conventional log directory (rare).
fn log_dir() -> PathBuf {
    // macOS: $HOME/Library/Logs, Linux: $XDG_STATE_HOME/log or ~/.local/state/log,
    // Windows: %LOCALAPPDATA% (no first-class "logs" subdir — we suffix below).
    // clippy::unnecessary_lazy_evaluations (Rust 1.95 strict, hit in CI v2.27):
    // the macOS-only fallback closure body is cheap (one env lookup), so
    // collapse to `.or(...)`. The cfg attributes still gate which arm compiles.
    #[cfg(target_os = "macos")]
    let macos_logs: Option<PathBuf> = dirs::home_dir().map(|h| h.join("Library").join("Logs"));
    #[cfg(not(target_os = "macos"))]
    let macos_logs: Option<PathBuf> = None;
    let base = dirs::state_dir()
        .or_else(dirs::data_local_dir)
        .or(macos_logs)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("WeBrain");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("could not create log dir {}: {e}", dir.display());
    }
    dir
}

/// Open a log file for one of our services, truncating on each launch so we
/// don't accumulate a multi-MB file across many restarts. Returns a file ready
/// to be plugged into Stdio::from(...).
fn open_log_for(name: &str) -> Result<File, String> {
    let path = log_dir().join(format!("{name}.log"));
    OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("open log {} failed: {e}", path.display()))
}

/// Resolve `pnpm` (or any other tool) on the host. Tries:
///   1. `which::which(name)` — uses the PATH the process actually inherited.
///   2. Common install locations Homebrew / Volta / NVM / asdf / npm-global.
///
/// Why we don't just rely on PATH: launching from Finder on macOS produces a
/// PATH like `/usr/bin:/bin:/usr/sbin:/sbin` which does NOT contain `/opt/homebrew/bin`
/// or any per-user prefix. Spawn fails with ENOENT and the user sees a white
/// screen with no clue what happened.
fn resolve_tool(name: &str) -> Option<PathBuf> {
    if let Ok(p) = which::which(name) {
        return Some(p);
    }
    let home = dirs::home_dir();
    let candidates: Vec<PathBuf> = [
        // Homebrew (Apple silicon)
        Some(PathBuf::from("/opt/homebrew/bin")),
        // Homebrew (Intel)
        Some(PathBuf::from("/usr/local/bin")),
        // Volta
        home.as_ref().map(|h| h.join(".volta/bin")),
        // pnpm direct install
        home.as_ref().map(|h| h.join(".local/share/pnpm")),
        home.as_ref().map(|h| h.join(".pnpm/bin")),
        // asdf shims
        home.as_ref().map(|h| h.join(".asdf/shims")),
        // npm global (NVM default)
        home.as_ref().map(|h| h.join(".npm-global/bin")),
        // Common Linux package manager locations
        Some(PathBuf::from("/usr/local/sbin")),
    ]
    .into_iter()
    .flatten()
    .collect();

    for prefix in candidates {
        let candidate = prefix.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Quick non-blocking TCP probe — is something listening on this host:port?
fn port_in_use(host: &str, port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("{host}:{port}").parse().unwrap_or_else(|_| {
            // Fallback that obviously won't connect — preserves false-by-default
            // semantics if parsing fails.
            "127.0.0.1:0".parse().expect("loopback parse")
        }),
        Duration::from_millis(250),
    )
    .is_ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnOutcome {
    Spawned,
    AlreadyRunning,
    Failed,
}

#[derive(Debug)]
pub struct ServiceManager {
    repo_root: PathBuf,
    sub_brain: Option<Child>,
    sub_brain_outcome: SpawnOutcome,
    /// Best-effort path to the resolved tooling, recorded for status reporting
    /// so the user can verify in /service/status if their toolchain was found.
    sub_brain_tool: Option<PathBuf>,
}

impl ServiceManager {
    pub fn new(repo_root: PathBuf) -> Self {
        Self {
            repo_root,
            sub_brain: None,
            sub_brain_outcome: SpawnOutcome::Failed,
            sub_brain_tool: None,
        }
    }

    /// Spawn sub-brain (which auto-spawns main-brain). Idempotent.
    ///
    /// Behavior matrix:
    ///   - already-running on :3000  → SpawnOutcome::AlreadyRunning (no-op)
    ///   - spawn ok                  → SpawnOutcome::Spawned
    ///   - spawn fail                → SpawnOutcome::Failed (returns Err)
    pub fn spawn_all(&mut self) -> Result<SpawnOutcome, String> {
        if self.sub_brain.is_some() {
            return Ok(self.sub_brain_outcome);
        }
        if port_in_use("127.0.0.1", 3000) {
            log::info!(
                "sub-brain port :3000 already in use — skipping spawn, will attach to existing service"
            );
            self.sub_brain_outcome = SpawnOutcome::AlreadyRunning;
            return Ok(SpawnOutcome::AlreadyRunning);
        }
        match self.spawn_sub_brain() {
            Ok((child, tool)) => {
                self.sub_brain = Some(child);
                self.sub_brain_tool = Some(tool);
                self.sub_brain_outcome = SpawnOutcome::Spawned;
                Ok(SpawnOutcome::Spawned)
            }
            Err(e) => {
                self.sub_brain_outcome = SpawnOutcome::Failed;
                Err(e)
            }
        }
    }

    fn spawn_sub_brain(&self) -> Result<(Child, PathBuf), String> {
        let sub_brain_dir = self.repo_root.join("sub-brain");
        if !sub_brain_dir.is_dir() {
            return Err(format!(
                "sub-brain dir missing: {}",
                sub_brain_dir.display()
            ));
        }
        let pnpm = resolve_tool("pnpm").ok_or_else(|| {
            "pnpm not found. Install via `npm i -g pnpm` or Homebrew \
             (brew install pnpm) and relaunch."
                .to_string()
        })?;

        let mut log_file = open_log_for("sub-brain")?;
        let _ = writeln!(
            log_file,
            "=== WeBrain desktop spawn @ {} ===",
            chrono_timestamp()
        );
        let stderr_target = log_file
            .try_clone()
            .map_err(|e| format!("log clone failed: {e}"))?;

        log::info!(
            "spawning sub-brain via {} dev in {}",
            pnpm.display(),
            sub_brain_dir.display()
        );

        let child = Command::new(&pnpm)
            .arg("dev")
            .current_dir(&sub_brain_dir)
            // PATH inheritance hack — when launched from Finder, the parent
            // PATH is too narrow for nested tool lookups (pnpm may shell out
            // to node / npx / python during its own startup). Re-export an
            // augmented PATH that includes the directories we already know
            // tools live in. This is additive — we don't clobber whatever
            // the user has.
            .env("PATH", augmented_path())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(stderr_target))
            .spawn()
            .map_err(|e| format!("spawn sub-brain failed: {e}"))?;

        Ok((child, pnpm))
    }

    /// Poll `http://127.0.0.1:3000/health` until it returns 200 or `timeout`
    /// elapses. Returns true if the service became ready.
    pub fn wait_for_health(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Ok(stream) = TcpStream::connect_timeout(
                &"127.0.0.1:3000".parse().expect("ip"),
                Duration::from_millis(300),
            ) {
                // Send a minimal HTTP/1.1 GET so we get a real status code,
                // not just a TCP-accept (which Vite's vite serve & a freshly
                // bound Fastify both produce before /health is wired).
                drop(stream);
                if probe_health() {
                    return true;
                }
            }
            std::thread::sleep(Duration::from_millis(400));
        }
        false
    }

    /// Best-effort SIGTERM → wait 5s → SIGKILL. Called on app quit. Gives
    /// sub-brain a chance to flush SQLite WAL, finalize logs, and fire its
    /// own shutdown hooks (v2.15 plugin SDK on_shutdown).
    pub fn shutdown_all(&mut self) {
        if let Some(child) = self.sub_brain.take() {
            graceful_shutdown("sub-brain", child);
        }
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "sub_brain": self.sub_brain.as_ref().map(|c| c.id()),
            "sub_brain_outcome": match self.sub_brain_outcome {
                SpawnOutcome::Spawned => "spawned",
                SpawnOutcome::AlreadyRunning => "attached_to_existing",
                SpawnOutcome::Failed => "failed",
            },
            "sub_brain_tool": self.sub_brain_tool.as_ref().map(|p| p.display().to_string()),
            "log_dir": log_dir().display().to_string(),
            "repo_root": self.repo_root.display().to_string(),
        })
    }
}

impl Drop for ServiceManager {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

/// Minimal blocking HTTP/1.1 GET to /health on :3000. Returns true on 2xx.
/// We don't pull in reqwest just for this — keeps the cold-start small.
fn probe_health() -> bool {
    use std::io::{Read, Write as IoWrite};
    let addr = match "127.0.0.1:3000".parse::<std::net::SocketAddr>() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 64];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let head = &buf[..n];
    head.starts_with(b"HTTP/1.1 200") || head.starts_with(b"HTTP/1.0 200")
}

/// Augmented PATH for child processes — preserves existing PATH and prepends
/// the locations we know tools live. Idempotent — duplicates are harmless.
fn augmented_path() -> String {
    let extras = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/sbin"];
    let home_paths: Vec<String> = if let Some(home) = dirs::home_dir() {
        vec![
            home.join(".volta/bin").display().to_string(),
            home.join(".local/share/pnpm").display().to_string(),
            home.join(".pnpm/bin").display().to_string(),
            home.join(".asdf/shims").display().to_string(),
            home.join(".npm-global/bin").display().to_string(),
        ]
    } else {
        Vec::new()
    };
    let existing = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<&str> = extras.to_vec();
    parts.extend(home_paths.iter().map(String::as_str));
    parts.push(&existing);
    parts.join(":")
}

fn chrono_timestamp() -> String {
    // We don't want to pull in the full `chrono` crate just for a header line.
    // Format the current UNIX time + a quick UTC display.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix={secs}")
}

/// Send SIGTERM, wait up to 5s, then SIGKILL if still alive.
#[cfg(unix)]
fn graceful_shutdown(name: &str, mut child: Child) {
    let pid = child.id();
    log::info!("graceful shutdown {name} (pid={pid}): SIGTERM");
    if let Err(e) = kill(Pid::from_raw(pid as i32), Signal::SIGTERM) {
        log::warn!("kill SIGTERM {name} failed: {e} — escalating to SIGKILL");
        let _ = child.kill();
        let _ = child.wait();
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => {
                log::info!("{name} exited cleanly");
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => {
                log::warn!("try_wait {name} failed: {e}");
                break;
            }
        }
    }
    log::warn!("{name} did not exit within 5s — SIGKILL");
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(unix))]
fn graceful_shutdown(name: &str, mut child: Child) {
    // Windows: GenerateConsoleCtrlEvent is process-group specific and our
    // children aren't in a console group, so we just kill.
    log::info!("shutdown {name} (pid={})", child.id());
    let _ = child.kill();
    let _ = child.wait();
}

// Helper used by tests + a defensive `Path` import for clarity above.
#[allow(dead_code)]
fn _path_check(_p: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn augmented_path_includes_homebrew() {
        let p = augmented_path();
        assert!(
            p.contains("/opt/homebrew/bin") || p.contains("/usr/local/bin"),
            "augmented PATH should include at least one Homebrew location: {p}"
        );
    }

    #[test]
    fn log_dir_creates_subdir() {
        let dir = log_dir();
        assert!(
            dir.ends_with("WeBrain"),
            "log dir should end with WeBrain: {}",
            dir.display()
        );
    }

    #[test]
    fn port_in_use_returns_false_for_random_high_port() {
        // 65530 is reserved for ephemeral; unlikely to be bound during tests.
        assert!(!port_in_use("127.0.0.1", 65530));
    }
}
