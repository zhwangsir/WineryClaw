//! ServiceManager — supervises the dual-brain child processes from Tauri's main.
//!
//! Responsibilities:
//! - spawn sub-brain (Node) and main-brain (Python venv) as child processes
//! - track PIDs and exit status
//! - SIGTERM (Unix) / kill (Windows) on shutdown
//!
//! Why it's safe to be optimistic about the venv / pnpm paths:
//! - WeBrain documents these as required (see umbrella CLAUDE.md and
//!   webrain-integration/CLAUDE.md "Setup (one-time)").
//! - If either fails to spawn the desktop still launches; the frontend's
//!   `/health` and `/brain/health` probes show the user what's broken.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

#[derive(Debug)]
pub struct ServiceManager {
    repo_root: PathBuf,
    sub_brain: Option<Child>,
    main_brain: Option<Child>,
}

impl ServiceManager {
    pub fn new(repo_root: PathBuf) -> Self {
        Self {
            repo_root,
            sub_brain: None,
            main_brain: None,
        }
    }

    /// Spawn both services. Idempotent — second call is a no-op.
    pub fn spawn_all(&mut self) -> Result<(), String> {
        if self.sub_brain.is_none() {
            let sub = self.spawn_sub_brain()?;
            self.sub_brain = Some(sub);
        }
        if self.main_brain.is_none() {
            // Sub-brain auto-spawns main-brain via its main-brain-spawn.ts logic
            // when `WEBRAIN_NO_MAIN_BRAIN` is not set. So spawning main-brain
            // explicitly is OPTIONAL and currently kept off to avoid double-spawn.
            // If a future user wants explicit Tauri-supervised main-brain,
            // flip the env var and uncomment:
            //
            // let mb = self.spawn_main_brain()?;
            // self.main_brain = Some(mb);
        }
        Ok(())
    }

    fn spawn_sub_brain(&self) -> Result<Child, String> {
        let sub_brain_dir = self.repo_root.join("sub-brain");
        if !sub_brain_dir.is_dir() {
            return Err(format!("sub-brain dir missing: {}", sub_brain_dir.display()));
        }
        log::info!("spawning sub-brain via pnpm dev in {}", sub_brain_dir.display());
        Command::new("pnpm")
            .arg("dev")
            .current_dir(&sub_brain_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("spawn sub-brain failed: {}", e))
    }

    #[allow(dead_code)]
    fn spawn_main_brain(&self) -> Result<Child, String> {
        let mb_dir = self.repo_root.join("sub-brain").join("main-brain");
        let venv_py = mb_dir.join("venv").join("bin").join("python3");
        if !venv_py.is_file() {
            return Err(format!("main-brain venv python missing: {}", venv_py.display()));
        }
        log::info!("spawning main-brain via {}", venv_py.display());
        Command::new(&venv_py)
            .arg("main_brain.py")
            .current_dir(&mb_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("spawn main-brain failed: {}", e))
    }

    /// Best-effort SIGTERM both children. Called on app quit.
    pub fn shutdown_all(&mut self) {
        for (name, child) in [
            ("sub-brain", self.sub_brain.take()),
            ("main-brain", self.main_brain.take()),
        ] {
            if let Some(mut c) = child {
                log::info!("shutting down {} (pid={})", name, c.id());
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "sub_brain": self.sub_brain.as_ref().map(|c| c.id()),
            "main_brain": self.main_brain.as_ref().map(|c| c.id()),
            "repo_root": self.repo_root.display().to_string(),
        })
    }
}

impl Drop for ServiceManager {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}
