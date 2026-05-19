/**
 * Python skill runtime — spawn + stdin (M6a).
 *
 * Replaces the old `execSync(\`python3 -c "..."\`)` pattern. Same two
 * wins as run-js-skill: no shell injection (params arrive via stdin
 * JSON, not interpolation), and reliable termination on timeout.
 *
 * Python can't be sandboxed in-process the way JS workers can — it
 * runs as a subprocess and has full filesystem/network access. The
 * isolation here is "shell-safe + bounded-time + capturable", not
 * "untrusted code can't read your home directory". For that, run
 * webrain inside a container or chroot the python interpreter (M6.1).
 */

import { spawn } from "node:child_process";

import type { SkillRunResult } from "./run-js-skill.js";

export interface RunPythonSkillOptions {
  code: string;
  params: Record<string, unknown>;
  /** Hard deadline in ms. Default 30s. */
  timeoutMs?: number;
  /** Python interpreter to use. Default "python3"; tests can inject "python". */
  pythonBin?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;

/**
 * Prelude that runs before user code. Reads JSON params from stdin and
 * exposes them as the `params` global, mirroring the JS runtime's
 * contract.
 */
const PRELUDE = "import json, sys\nparams = json.load(sys.stdin)\n";

export async function runPythonSkill(opts: RunPythonSkillOptions): Promise<SkillRunResult> {
  const start = Date.now();
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pythonBin = opts.pythonBin ?? "python3";
  const wrapped = PRELUDE + opts.code;

  return new Promise<SkillRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(pythonBin, ["-c", wrapped], { stdio: ["pipe", "pipe", "pipe"] });

    const finish = (r: Omit<SkillRunResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited — fine
      }
      resolve({ ...r, timedOut: timedOut || r.timedOut, durationMs: Date.now() - start });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish({ ok: false, error: `python skill timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      finish({ ok: false, error: `python spawn error: ${err.message}` });
    });
    child.on("exit", (code) => {
      if (code === 0) {
        finish({ ok: true, result: stdout.trimEnd() });
      } else {
        // Prefer stderr if available — that's where Python writes
        // tracebacks. Fall back to stdout for "useful" output even
        // on failure paths.
        const errText = stderr.trim() || stdout.trim() || `python exited with code ${code}`;
        finish({ ok: false, error: errText });
      }
    });

    // Pass params via stdin JSON. Even if a param value contains shell
    // metacharacters or unicode tricks, it never touches the shell.
    try {
      child.stdin.write(JSON.stringify(opts.params));
      child.stdin.end();
    } catch (err: any) {
      finish({ ok: false, error: `stdin write failed: ${err?.message ?? err}` });
    }
  });
}
