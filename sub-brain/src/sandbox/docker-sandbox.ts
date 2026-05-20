/**
 * Docker Sandbox — 隔离执行环境
 * Docker sandbox for secure code execution
 *
 * Two modes:
 *   1) One-shot (execute / executePython / executeNode): ephemeral
 *      `docker run --rm` container, fresh filesystem each call. Original
 *      behavior, unchanged.
 *
 *   2) Workspace (execInWorkspace / ensureWorkspace / removeWorkspace):
 *      a long-lived container per workspaceId backed by a persistent bind
 *      mount at ~/.webrain/workspaces/<id>/. State (installed packages,
 *      files, shell history) survives between calls. Optional network.
 *      Round J1 (2026-05-21) — enables stateful agent workflows.
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SandboxConfig {
  image: string;
  memory: string;
  cpus: number;
  timeout: number;
  network: boolean;
  volumes: string[];
}

const DEFAULT_CONFIG: SandboxConfig = {
  image: "node:20-alpine",
  memory: "512m",
  cpus: 1.0,
  timeout: 30000,
  network: false,
  volumes: [],
};

/**
 * Per-workspace config snapshot. Captured at first ensureWorkspace() call
 * and reused if we have to recreate the container (e.g. after Docker
 * restart). Network + image cannot be changed without removeWorkspace
 * first — runtime mutation would require docker stop + run, which is
 * out of scope for J1.
 */
export interface WorkspaceConfig {
  workspaceId: string;
  image: string;
  memory: string;
  cpus: number;
  network: boolean;
  /** ISO timestamp of last activity (exec) — used for idle GC */
  lastActiveAt: string;
  /** absolute path of the host bind mount */
  hostPath: string;
}

const WORKSPACE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Image preference for workspaces (Round J2). Probed lazily on first use.
 *  - First choice: webrain-workspace:latest (ubuntu + git/python/node/ffmpeg/curl...)
 *  - Fallback:    SandboxConfig.image (default node:20-alpine for back-compat)
 *
 * If a caller explicitly passes an image in ensureWorkspace(), it wins.
 */
const PREFERRED_WORKSPACE_IMAGE = "webrain-workspace:latest";

function workspaceContainerName(workspaceId: string): string {
  return `webrain-ws-${workspaceId}`;
}

export class DockerSandbox {
  private config: SandboxConfig;
  private containers = new Set<string>();

  /** Per-workspace metadata. Keyed by workspaceId, NOT container name. */
  private workspaces = new Map<string, WorkspaceConfig>();

  /** Cached result of "is webrain-workspace:latest pulled locally?" — probed once per process. */
  private _preferredImageAvailable: boolean | null = null;

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Resolve the workspace image to use when the caller didn't specify one.
   * Prefers webrain-workspace:latest if locally available, otherwise the
   * configured default (node:20-alpine).
   */
  resolveDefaultWorkspaceImage(): string {
    if (this._preferredImageAvailable === null) {
      this._preferredImageAvailable = this._imageExistsLocally(PREFERRED_WORKSPACE_IMAGE);
    }
    return this._preferredImageAvailable ? PREFERRED_WORKSPACE_IMAGE : this.config.image;
  }

  private _imageExistsLocally(image: string): boolean {
    if (!this.isAvailable()) return false;
    try {
      const out = execSync(`docker image inspect ${image} --format ok`, {
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
        timeout: 5000,
      });
      return out.trim() === "ok";
    } catch {
      return false;
    }
  }

  isAvailable(): boolean {
    // Cache the probe result — the previous implementation re-ran
    // `docker version` and re-logged the failure for every call site
    // (startup + every execute()). User-trial #9 saw the failure
    // emit a raw ChildProcess error object (`output: [null, <Buffer >, …]`)
    // on stderr at startup, which looked alarming for a benign "docker
    // not installed" state.
    if (DockerSandbox._cachedAvailability !== null) {
      return DockerSandbox._cachedAvailability;
    }
    try {
      execSync("docker version", { stdio: "pipe", timeout: 5000 });
      DockerSandbox._cachedAvailability = true;
    } catch {
      // Intentionally silent. The caller logs a friendly one-liner.
      // We do NOT dump the err object — it contains the entire stderr
      // Buffer + spawn args + status code which look terrifying for
      // an expected "docker not on PATH" state.
      DockerSandbox._cachedAvailability = false;
    }
    return DockerSandbox._cachedAvailability;
  }

  // Per-process cache — initial null means "not yet probed".
  private static _cachedAvailability: boolean | null = null;

  async execute(command: string, inputFiles?: Record<string, string>): Promise<{ ok: boolean; output: string; exitCode: number; error?: string }> {
    if (!this.isAvailable()) {
      return { ok: false, output: "", exitCode: -1, error: "Docker not available" };
    }

    const containerName = `webrain-sandbox-${Date.now()}`;
    this.containers.add(containerName);

    const tmpDir = join(homedir(), ".webrain", "sandbox", containerName);
    mkdirSync(tmpDir, { recursive: true });

    if (inputFiles) {
      for (const [name, content] of Object.entries(inputFiles)) {
        writeFileSync(join(tmpDir, name), content);
      }
    }

    const volumeMounts = ["-v", `${tmpDir}:/workspace`];
    for (const vol of this.config.volumes) {
      volumeMounts.push("-v", vol);
    }

    const networkFlag = this.config.network ? "" : "--network none";
    const memoryFlag = `--memory=${this.config.memory}`;
    const cpusFlag = `--cpus=${this.config.cpus}`;

    const dockerCmd = [
      "docker", "run", "--rm",
      "--name", containerName,
      memoryFlag, cpusFlag,
      networkFlag,
      ...volumeMounts,
      "-w", "/workspace",
      this.config.image,
      "sh", "-c", command,
    ].filter(Boolean);

    try {
      const output = execSync(dockerCmd.join(" "), {
        encoding: "utf-8",
        timeout: this.config.timeout,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.containers.delete(containerName);
      return { ok: true, output, exitCode: 0 };
    } catch (err: any) {
      this.containers.delete(containerName);
      return {
        ok: false,
        output: err.stdout || "",
        exitCode: err.status || 1,
        error: err.message,
      };
    }
  }

  async executePython(code: string): Promise<{ ok: boolean; output: string; exitCode: number; error?: string }> {
    return this.execute(`python3 -c "${code.replace(/"/g, '\\"')}"`);
  }

  async executeNode(script: string): Promise<{ ok: boolean; output: string; exitCode: number; error?: string }> {
    return this.execute(`node -e "${script.replace(/"/g, '\\"')}"`);
  }

  async cleanup(): Promise<void> {
    for (const name of this.containers) {
      try {
        execSync(`docker rm -f ${name}`, { stdio: "pipe", timeout: 10000 });
      } catch (err) { console.error("[docker-sandbox] Error:", err); console.error("[docker] Error:", err); }
    }
    this.containers.clear();
  }

  // ───────────────────────────────────────────────────────────────────
  // Workspace mode (Round J1)
  // ───────────────────────────────────────────────────────────────────

  /**
   * Create or reuse a long-lived workspace container.
   * Idempotent — calling twice with the same id is safe.
   * Returns the workspace config (or null if Docker unavailable).
   */
  async ensureWorkspace(
    workspaceId: string,
    opts?: { image?: string; memory?: string; cpus?: number; network?: boolean },
  ): Promise<{ ok: boolean; workspace?: WorkspaceConfig; error?: string }> {
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      return {
        ok: false,
        error: `Invalid workspaceId: must match ${WORKSPACE_ID_RE.source}`,
      };
    }
    if (!this.isAvailable()) {
      return { ok: false, error: "Docker not available" };
    }

    const container = workspaceContainerName(workspaceId);
    const hostPath = join(homedir(), ".webrain", "workspaces", workspaceId);
    mkdirSync(hostPath, { recursive: true });

    // If we already track it AND the container is still running, reuse.
    const existing = this.workspaces.get(workspaceId);
    if (existing && this._isContainerRunning(container)) {
      existing.lastActiveAt = new Date().toISOString();
      return { ok: true, workspace: existing };
    }

    // If a stopped container lingers, remove it so we can re-create cleanly.
    try {
      execSync(`docker rm -f ${container}`, { stdio: "pipe", timeout: 10000 });
    } catch {
      // not present — fine
    }

    const cfg: WorkspaceConfig = {
      workspaceId,
      // Round J2: prefer webrain-workspace:latest (ubuntu) if locally
      // pulled, fall back to config.image (node:20-alpine).
      image: opts?.image ?? this.resolveDefaultWorkspaceImage(),
      memory: opts?.memory ?? this.config.memory,
      cpus: opts?.cpus ?? this.config.cpus,
      // Network defaults to false (--network none). Caller opts in.
      network: opts?.network ?? false,
      lastActiveAt: new Date().toISOString(),
      hostPath,
    };

    const networkFlag = cfg.network ? "" : "--network none";
    const dockerCmd = [
      "docker", "run", "-d",
      "--name", container,
      `--memory=${cfg.memory}`,
      `--cpus=${cfg.cpus}`,
      networkFlag,
      "-v", `${hostPath}:/workspace`,
      "-w", "/workspace",
      cfg.image,
      // Keep-alive: BusyBox `sh` + `sleep infinity` works on both alpine
      // and debian/ubuntu images. We do NOT use `tail -f /dev/null` because
      // some minimal images (distroless) lack tail.
      "sh", "-c", "sleep infinity",
    ].filter(Boolean);

    try {
      execSync(dockerCmd.join(" "), { stdio: "pipe", timeout: 30000 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to start workspace container: ${msg}` };
    }

    this.workspaces.set(workspaceId, cfg);
    this.containers.add(container);
    return { ok: true, workspace: cfg };
  }

  /**
   * Run a command inside a workspace container. If the workspace doesn't
   * exist yet, it is created with default settings.
   */
  async execInWorkspace(
    workspaceId: string,
    command: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; output: string; exitCode: number; error?: string }> {
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      return { ok: false, output: "", exitCode: -1, error: "Invalid workspaceId" };
    }
    if (!this.isAvailable()) {
      return { ok: false, output: "", exitCode: -1, error: "Docker not available" };
    }

    // Auto-provision with defaults if missing.
    if (!this.workspaces.has(workspaceId)) {
      const r = await this.ensureWorkspace(workspaceId);
      if (!r.ok) return { ok: false, output: "", exitCode: -1, error: r.error };
    } else if (!this._isContainerRunning(workspaceContainerName(workspaceId))) {
      // Container died (e.g. host reboot). Recreate with the same config.
      const cfg = this.workspaces.get(workspaceId)!;
      const r = await this.ensureWorkspace(workspaceId, {
        image: cfg.image,
        memory: cfg.memory,
        cpus: cfg.cpus,
        network: cfg.network,
      });
      if (!r.ok) return { ok: false, output: "", exitCode: -1, error: r.error };
    }

    const container = workspaceContainerName(workspaceId);
    const cfg = this.workspaces.get(workspaceId)!;
    cfg.lastActiveAt = new Date().toISOString();

    // Pass the command via stdin to avoid shell-injection issues in the
    // host shell composition. `docker exec -i ... sh` reads script from
    // stdin, so the host shell never has to interpolate `command`.
    try {
      const output = execSync(`docker exec -i ${container} sh`, {
        encoding: "utf-8",
        input: command,
        timeout: opts?.timeoutMs ?? this.config.timeout,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { ok: true, output, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
      return {
        ok: false,
        output: (e.stdout ?? "") + (e.stderr ?? ""),
        exitCode: e.status ?? 1,
        error: e.message,
      };
    }
  }

  /**
   * Stop and remove a workspace container. The host bind mount
   * (`~/.webrain/workspaces/<id>/`) is NOT deleted — caller can wipe it
   * separately if they want a clean slate.
   */
  async removeWorkspace(workspaceId: string): Promise<{ ok: boolean; error?: string }> {
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      return { ok: false, error: "Invalid workspaceId" };
    }
    const container = workspaceContainerName(workspaceId);
    try {
      execSync(`docker rm -f ${container}`, { stdio: "pipe", timeout: 10000 });
    } catch {
      // already gone — treat as success
    }
    this.workspaces.delete(workspaceId);
    this.containers.delete(container);
    return { ok: true };
  }

  /** List all known workspaces (active or stopped). */
  listWorkspaces(): WorkspaceConfig[] {
    return [...this.workspaces.values()];
  }

  /** Internal — best-effort check if a named container is currently running. */
  private _isContainerRunning(containerName: string): boolean {
    try {
      const out = execSync(`docker ps -q -f name=^${containerName}$`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }
}
