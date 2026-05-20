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
 * Marker the Python prelude emits to delimit a structured result from
 * incidental stdout (user print() debugging). Picked to be long and
 * distinctive so a user accidentally printing it is implausible.
 */
const RESULT_MARKER = "__WEBRAIN_SKILL_RESULT__:";

/**
 * Prelude that runs before user code. Sets up:
 *   - `params`            — JSON from stdin (mirrors JS runtime contract)
 *   - `set_result(value)` — explicit API to emit a structured result
 *
 * After user code finishes, a postlude checks for a top-level `result`
 * variable and emits it via `set_result` if no explicit emission
 * happened. This gives Python skills the same three options:
 *
 *     print(value)            # current behaviour — string stdout
 *     result = value          # NEW: same shape as JS `return value`
 *     set_result(value)       # NEW: explicit, lets users emit then keep printing
 *
 * Round C9 (2026-05-20) — harmonizes the Python API with the JS
 * runtime which has always supported `return value;`. Backwards-compat
 * is preserved: skills using bare `print(value)` still work and their
 * stdout becomes the result string, unchanged.
 */
const PRELUDE = `import json, sys
params = json.load(sys.stdin)
_webrain_result_emitted = False
def set_result(value):
    global _webrain_result_emitted
    sys.stdout.flush()
    sys.stdout.write('\\n${RESULT_MARKER}' + json.dumps(value, default=str) + '\\n')
    sys.stdout.flush()
    _webrain_result_emitted = True
`;

/**
 * Postlude that runs after user code. If no explicit set_result happened
 * but a `result` name exists at module level, emit it. Wrapped in
 * try/except so a user code crash or NameError can't break this block.
 */
const POSTLUDE = `
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

export async function runPythonSkill(opts: RunPythonSkillOptions): Promise<SkillRunResult> {
  const start = Date.now();
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pythonBin = opts.pythonBin ?? "python3";
  const wrapped = PRELUDE + opts.code + "\n" + POSTLUDE;

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
        // Round C9: look for the structured-result marker. If present,
        // parse JSON after the LAST occurrence (latest set_result call
        // wins, same semantics as last-write). Anything BEFORE the
        // marker is incidental stdout (debug prints) and gets dropped
        // from the result — that's the user contract.
        //
        // No marker = legacy behaviour: result is the raw stdout
        // string. Preserves all existing print(value)-style skills.
        const idx = stdout.lastIndexOf(RESULT_MARKER);
        if (idx >= 0) {
          const jsonPart = stdout.slice(idx + RESULT_MARKER.length).trim();
          try {
            const parsed = JSON.parse(jsonPart);
            finish({ ok: true, result: parsed });
            return;
          } catch {
            // Marker present but JSON unparseable — extremely unusual
            // (would mean json.dumps failed and emitted partial output).
            // Fall through to the legacy raw-stdout return so the user
            // still gets SOMETHING back instead of an opaque failure.
          }
        }
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
