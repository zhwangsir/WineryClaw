/**
 * Sandbox skill runtime (Round J3).
 *
 * Runs a Python or JavaScript skill inside a persistent workspace
 * container managed by `DockerSandbox`. Same `SkillRunResult` contract
 * as the in-process `runPythonSkill` / `runJsSkill` so callers can be
 * agnostic about where the skill lives.
 *
 * Why this exists
 *   - Skills that need apt-installable tools (ffmpeg, imagemagick,
 *     headless chrome, etc.) can't run inside the sub-brain process.
 *   - Skills that want persistent state (caches, downloaded models,
 *     pip-installed wheels) lose it when the worker thread / spawn
 *     subprocess exits.
 *   - The workspace bind mount + long-lived container fix both.
 *
 * Mechanism
 *   1. Write the wrapped script to ~/.webrain/workspaces/<id>/.webrain-skill-<nonce>.{py,mjs}
 *   2. Write params JSON to ~/.webrain/workspaces/<id>/.webrain-skill-<nonce>.json
 *   3. docker exec the script — same RESULT_MARKER protocol as the
 *      in-process runtimes.
 *   4. Delete both files.
 *
 * This avoids shell-injection completely: the script and the params
 * never appear on a host shell command line. They get written through
 * fs.writeFileSync on the bind-mount, which is bytes-in / bytes-out.
 */

import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

import type { DockerSandbox } from "../../sandbox/docker-sandbox.js";
import type { SkillRunResult } from "./run-js-skill.js";

/** Marker shared with run-python-skill.ts / run-js-skill.ts. */
const RESULT_MARKER = "__WEBRAIN_SKILL_RESULT__:";

export interface RunSandboxSkillOptions {
  language: "python" | "javascript";
  code: string;
  params: Record<string, unknown>;
  workspaceId: string;
  /** DockerSandbox instance — caller wires this in (avoids global state). */
  dockerSandbox: DockerSandbox;
  /** Hard deadline in ms. Default 30s. */
  timeoutMs?: number;
  /**
   * Optional override for the host-side workspaces directory. Production
   * leaves this unset and we resolve `~/.webrain/workspaces`. Tests pass
   * a tmp dir so they don't write into the real home directory.
   */
  workspacesRoot?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ── prelude/postlude (Python) — mirrors run-python-skill.ts contract ─
const PY_PRELUDE = `import json, sys
with open(sys.argv[1], "r") as _f:
    params = json.load(_f)
_webrain_result_emitted = False
def set_result(value):
    global _webrain_result_emitted
    sys.stdout.flush()
    sys.stdout.write('\\n${RESULT_MARKER}' + json.dumps(value, default=str) + '\\n')
    sys.stdout.flush()
    _webrain_result_emitted = True
`;

const PY_POSTLUDE = `
if not _webrain_result_emitted:
    try:
        _webrain_implicit = result  # noqa: F821 — user-defined
    except NameError:
        _webrain_implicit = None
    if _webrain_implicit is not None:
        try:
            set_result(_webrain_implicit)
        except (TypeError, ValueError) as _e:
            sys.stderr.write('webrain skill: result not JSON-serializable: ' + str(_e) + '\\n')
`;

// ── prelude/postlude (JS) — node ESM with top-level await ────────────
const JS_PRELUDE = `import { readFileSync } from "node:fs";
const params = JSON.parse(readFileSync(process.argv[2], "utf-8"));
let _webrain_result_emitted = false;
function set_result(value) {
  process.stdout.write('\\n${RESULT_MARKER}' + JSON.stringify(value) + '\\n');
  _webrain_result_emitted = true;
}
`;

const JS_POSTLUDE = `
if (!_webrain_result_emitted && typeof result !== "undefined" && result !== null) {
  try { set_result(result); }
  catch (e) { process.stderr.write("webrain skill: result not JSON-serializable: " + e.message + "\\n"); }
}
`;

/**
 * Run a skill inside a persistent sandbox workspace.
 *
 * The workspace must already exist (call `dockerSandbox.ensureWorkspace`
 * first, or pass `autoEnsure: true` — out of scope here, kept simple).
 * If the workspace doesn't exist, execInWorkspace auto-provisions with
 * defaults, so this works zero-config for first-time use.
 */
export async function runSandboxSkill(opts: RunSandboxSkillOptions): Promise<SkillRunResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const root = opts.workspacesRoot ?? join(homedir(), ".webrain", "workspaces");
  const hostWorkspaceDir = join(root, opts.workspaceId);
  try {
    mkdirSync(hostWorkspaceDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `sandbox skill: cannot prepare workspace dir: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }

  const nonce = randomBytes(8).toString("hex");
  const scriptExt = opts.language === "python" ? "py" : "mjs";
  const scriptFile = `.webrain-skill-${nonce}.${scriptExt}`;
  const paramsFile = `.webrain-skill-${nonce}.json`;
  const hostScriptPath = join(hostWorkspaceDir, scriptFile);
  const hostParamsPath = join(hostWorkspaceDir, paramsFile);

  // Path inside the container (bind mount is /workspace).
  const containerScriptPath = `/workspace/${scriptFile}`;
  const containerParamsPath = `/workspace/${paramsFile}`;

  // Build the wrapped script.
  const wrapped =
    opts.language === "python"
      ? PY_PRELUDE + opts.code + "\n" + PY_POSTLUDE
      : JS_PRELUDE + opts.code + "\n" + JS_POSTLUDE;

  try {
    writeFileSync(hostScriptPath, wrapped, { encoding: "utf-8" });
    writeFileSync(hostParamsPath, JSON.stringify(opts.params ?? {}), { encoding: "utf-8" });
  } catch (err) {
    return {
      ok: false,
      error: `sandbox skill: cannot write script files: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }

  // Compose the in-container command. Both args are container paths,
  // never interpolated into a host shell — they go to `sh` via stdin
  // inside DockerSandbox.execInWorkspace.
  const runner = opts.language === "python" ? "python3" : "node";
  const command = `${runner} ${containerScriptPath} ${containerParamsPath}`;

  let execResult;
  try {
    execResult = await opts.dockerSandbox.execInWorkspace(opts.workspaceId, command, {
      timeoutMs,
    });
  } finally {
    // Always clean up, even on error.
    for (const p of [hostScriptPath, hostParamsPath]) {
      try {
        unlinkSync(p);
      } catch {
        /* file may have been moved or never created — ignore */
      }
    }
  }

  if (!execResult.ok) {
    return {
      ok: false,
      error: execResult.error || `sandbox exec failed with code ${execResult.exitCode}`,
      timedOut: /timed out/i.test(execResult.error ?? ""),
      durationMs: Date.now() - start,
    };
  }

  // Parse the marker — same contract as the in-process runtimes.
  const stdout = execResult.output;
  const idx = stdout.lastIndexOf(RESULT_MARKER);
  if (idx >= 0) {
    const jsonPart = stdout.slice(idx + RESULT_MARKER.length).trim();
    try {
      const parsed = JSON.parse(jsonPart);
      return { ok: true, result: parsed, durationMs: Date.now() - start };
    } catch {
      // Marker present but unparseable — fall through to raw-stdout.
    }
  }
  return { ok: true, result: stdout.trimEnd(), durationMs: Date.now() - start };
}
