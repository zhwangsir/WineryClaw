/**
 * JavaScript skill runtime — worker_threads isolation (M6a).
 *
 * Replaces the old `execSync(\`node -e "..."\`)` pattern, which had two
 * critical issues:
 *
 *   1. **Shell injection**: params got embedded as a JSON string into a
 *      shell command. Any unescaped `$`, backtick, double quote, etc.
 *      in caller-controlled params broke out of the wrapping. This
 *      runtime passes params via structured clone — no shell at all.
 *
 *   2. **No real timeout**: execSync's timeout kills the immediate
 *      child but not its grandchildren, and the parent process blocks
 *      for the full timeout. This runtime returns a promise that
 *      resolves immediately when the worker exits or hits the
 *      hard-deadline, and the worker is `terminate()`d on timeout.
 *
 * What this runtime does NOT do:
 *   - Filesystem / network sandboxing. Skills can still `require("fs")`
 *     and read anything the parent process can read. True isolation
 *     needs containers or vm2/isolated-vm, which have their own
 *     security and ecosystem tradeoffs (see PROJECT_STATE for M6.1).
 *   - Module import allowlist. Built-in skills depend on
 *     `child_process` for git/docker/ffmpeg/etc.; restricting it would
 *     break them. AI-generated skills should be vetted upstream.
 *
 * What this runtime DOES guarantee:
 *   - No shell evaluation of caller-controlled data.
 *   - Hard memory cap via V8 resource limits.
 *   - Reliable termination on timeout.
 *   - Async user code is supported (top-level await via async IIFE).
 */

import { Worker } from "node:worker_threads";

export interface SkillRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  /** True when the worker was force-terminated by the timeout. */
  timedOut?: boolean;
}

export interface RunJsSkillOptions {
  code: string;
  params: Record<string, unknown>;
  /** Hard deadline in milliseconds. Default 30s. Floor at 100ms — anything
   * shorter is almost certainly a misconfiguration. */
  timeoutMs?: number;
  /** V8 old-generation cap in MB. Default 256. Worker exits with OOM if
   * exceeded, which surfaces as `ok: false, error: "worker exited..."`. */
  maxOldGenerationSizeMb?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const DEFAULT_MAX_OLD_GEN_MB = 256;

/**
 * Inline worker script — kept tiny on purpose so it can be evaluated in
 * one go. We use CJS-style globals (`workerData`, `parentPort`) which
 * Node provides regardless of the worker's module type because we're
 * running in `eval: true` mode (no ESM/CJS file).
 *
 * The user's `code` is wrapped in an async IIFE so they can use
 * top-level `await`. `params` is exposed as a let-binding for the user
 * function, NOT as a global, to keep mutations contained.
 */
const WORKER_SCRIPT = `
const { parentPort, workerData } = require("worker_threads");
const { code, params } = workerData;
(async () => {
  try {
    // new Function isolates the user code's lexical scope from the
    // worker's. The async IIFE inside lets the user "return" a value
    // and use await naturally.
    const userFn = new Function("params", "return (async () => { " + code + " })();");
    const result = await userFn(params);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    const msg = (err && err.stack) ? err.stack : String(err && err.message || err);
    parentPort.postMessage({ ok: false, error: msg });
  }
})();
`;

export async function runJsSkill(opts: RunJsSkillOptions): Promise<SkillRunResult> {
  const start = Date.now();
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxOldGenerationSizeMb = opts.maxOldGenerationSizeMb ?? DEFAULT_MAX_OLD_GEN_MB;

  return new Promise<SkillRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SCRIPT, {
        eval: true,
        // params is passed via structured clone, NOT shell-quoted into a
        // command string. This is the security win of the migration.
        workerData: { code: opts.code, params: opts.params },
        resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 16 },
      });
    } catch (err: any) {
      resolve({
        ok: false,
        error: `failed to spawn worker: ${err?.message ?? err}`,
        durationMs: Date.now() - start,
      });
      return;
    }

    const finish = (r: Omit<SkillRunResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {}); // already terminated is fine
      resolve({ ...r, timedOut: timedOut || r.timedOut, durationMs: Date.now() - start });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish({ ok: false, error: `skill execution timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);

    worker.on("message", (msg: any) => {
      finish(msg);
    });
    worker.on("error", (err) => {
      finish({ ok: false, error: `worker error: ${err?.message ?? err}` });
    });
    worker.on("exit", (code) => {
      // If the worker exits cleanly (code 0) but never sent a message,
      // it terminated abnormally — usually OOM via resourceLimits.
      finish({ ok: false, error: `worker exited unexpectedly with code ${code}` });
    });
  });
}
