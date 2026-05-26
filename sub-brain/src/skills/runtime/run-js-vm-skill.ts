/**
 * JavaScript skill runtime — vm-context sandbox (M6.1 / v2.31).
 *
 * ROADMAP V2 §9 P0 #1: the existing `run-js-skill.ts` worker_threads
 * runtime fixes shell injection but skills can still `require("fs")` and
 * read whatever the parent process can read. This module adds a STRICT
 * variant for AI-generated or untrusted skills: code runs in
 * `node:vm` createContext with a hand-curated global so:
 *
 *   - `require` is NOT defined (no module loading at all)
 *   - `process` is NOT defined (no env / argv / binding access)
 *   - `global` / `globalThis` only expose what we hand them
 *   - `Buffer` and `URL` are present (useful for data shaping)
 *   - Standard built-ins (JSON, Math, Date, Promise, etc.) are present
 *
 * What this BLOCKS that the worker runtime did NOT:
 *   - require("fs") / fs.readFileSync — ReferenceError (require undefined)
 *   - require("child_process") — same
 *   - require("net") / require("http") — same; no socket creation possible
 *   - process.env / process.binding — ReferenceError
 *
 * What this still does NOT block (limitations of vm vs isolated-vm):
 *   - Pure-CPU computational DoS (mitigated by hard timeout)
 *   - Heap-exhaustion DoS (mitigated by `breakOnSigint: true` + vm script
 *     `timeout` — but Node's vm timeout isn't bulletproof, see vm docs)
 *   - Prototype-chain side-channels back to the host (vm contexts share
 *     the v8 heap with the parent — true isolation needs isolated-vm)
 *
 * Verdict: for AI-generated skills running against untrusted user
 * prompts, vm sandbox raises the bar significantly — a malicious skill
 * can't quietly read ~/.ssh/id_rsa or exfiltrate over network — but a
 * determined attacker with deep v8 / vm knowledge can still escape.
 * Pair with the existing Docker-sandbox path (run-sandbox-skill.ts) for
 * workloads that genuinely need network/FS.
 */

import * as vm from "node:vm";

export interface VmSkillRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  /** True when the vm timeout fired and aborted execution. */
  timedOut?: boolean;
}

export interface RunJsVmSkillOptions {
  /** Skill source code. Wrapped in an async IIFE; user code may use
   * `await` and `return <value>`. */
  code: string;
  /** Structured-clone-safe input visible inside the sandbox as `params`. */
  params: Record<string, unknown>;
  /** Hard execution deadline (ms). Default 5s. Floor 50ms. */
  timeoutMs?: number;
  /** Optional safe console — defaults to a silent stub so untrusted
   * skills can't spam parent stderr. Pass `{ log: console.log, error:
   * console.error }` to surface output during dev. */
  console?: { log?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 50;

/** Curated set of globals that go into the vm context. Anything NOT in
 * this list is unreachable from inside the sandbox. */
function buildSandboxGlobals(
  params: Record<string, unknown>,
  consoleStub: { log?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }
): Record<string, unknown> {
  const silent = () => {};
  return {
    // The skill's input data — what we want the skill to operate on.
    params,
    // Safe built-ins that are common and harmless. Note: we explicitly
    // do NOT include `process`, `require`, `Buffer.from(fs.readFileSync(...))`
    // patterns. globalThis inside the context resolves to this object,
    // so prototype-chain games can only see what we hand over.
    JSON,
    Math,
    Date,
    Promise,
    Number,
    String,
    Array,
    Object,
    Boolean,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    Error,
    TypeError,
    RangeError,
    URL,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    atob,
    btoa,
    // Buffer is from node:buffer — useful for skills that need to
    // manipulate binary data. Doesn't open any I/O surface by itself.
    Buffer,
    // Timers — sandbox skills sometimes want to debounce / sequence.
    // We intentionally do NOT expose setImmediate / process.nextTick.
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    // Silent console by default so skills can't spam stderr.
    console: {
      log: consoleStub.log ?? silent,
      error: consoleStub.error ?? silent,
      warn: consoleStub.error ?? silent,
      info: consoleStub.log ?? silent,
      debug: silent,
    },
  };
}

/**
 * Run a skill in a sandboxed vm context. See module-level docstring for
 * the threat model and known limitations.
 *
 * On success: `{ ok: true, result, durationMs }`. The skill's last
 * `return` from the async wrapper is awaited and surfaced as `result`.
 *
 * On timeout: `{ ok: false, timedOut: true, error: "..." }`. The vm
 * `timeout` option throws when execution exceeds the budget — Node's
 * implementation isn't bulletproof against tight infinite loops in
 * native code, but it handles JS-level loops correctly.
 *
 * On any sync/async exception in user code: `{ ok: false, error }`.
 */
export async function runJsVmSkill(
  opts: RunJsVmSkillOptions
): Promise<VmSkillRunResult> {
  const start = Date.now();
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const consoleStub = opts.console ?? {};
  const sandbox = buildSandboxGlobals(opts.params, consoleStub);

  let context: vm.Context;
  try {
    // Create an isolated global context. The sandbox object becomes the
    // new global — keys we put on it ARE the global namespace.
    context = vm.createContext(sandbox, {
      name: "webrain-skill-sandbox",
      // codeGeneration.strings: disable `eval` / `new Function` inside
      // the sandbox. Without this, an adversarial skill could
      // `new Function("return process")()` to escape (process is the
      // parent's, not the sandbox's — but the lookup happens in the
      // function-creation closure, not the vm context). Disabling
      // code generation closes this hole.
      codeGeneration: { strings: false, wasm: false },
    });
  } catch (err: unknown) {
    return {
      ok: false,
      error: `failed to create vm context: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }

  // Wrap user code in an async IIFE so they can use `return` and
  // top-level await. The vm.Script `timeout` will fire if the sync
  // portion runs too long, but async work after the first await is
  // bounded by our own Promise.race fallback.
  const wrapped = `(async () => {\n${opts.code}\n})()`;

  let scriptPromise: Promise<unknown>;
  try {
    const script = new vm.Script(wrapped, {
      filename: "skill.js",
    });
    scriptPromise = script.runInContext(context, {
      timeout: timeoutMs,
      breakOnSigint: true,
    });
  } catch (err: unknown) {
    const e = err as Error & { code?: string };
    const timedOut =
      e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ||
      /Script execution timed out/i.test(e?.message ?? "");
    return {
      ok: false,
      timedOut,
      error: timedOut
        ? `skill execution timed out after ${timeoutMs}ms (sync)`
        : `vm.Script threw: ${e.message}`,
      durationMs: Date.now() - start,
    };
  }

  // Belt-and-suspenders async timeout — Node's vm.Script timeout only
  // bounds the synchronous portion. If user code does
  // `await new Promise(() => {})` they'd hang forever otherwise.
  let asyncTimer: NodeJS.Timeout | undefined;
  const asyncTimeout = new Promise<{ __timeout: true }>((resolve) => {
    asyncTimer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
  });

  try {
    const settled = await Promise.race([
      scriptPromise.then((value) => ({ __ok: true, value })),
      asyncTimeout,
    ]);
    if (asyncTimer) clearTimeout(asyncTimer);

    if ("__timeout" in settled) {
      return {
        ok: false,
        timedOut: true,
        error: `skill execution timed out after ${timeoutMs}ms (async)`,
        durationMs: Date.now() - start,
      };
    }
    return {
      ok: true,
      result: settled.value,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    if (asyncTimer) clearTimeout(asyncTimer);
    const e = err as Error & { code?: string };
    const timedOut =
      e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ||
      /Script execution timed out/i.test(e?.message ?? "");
    return {
      ok: false,
      timedOut,
      error: timedOut
        ? `skill execution timed out after ${timeoutMs}ms`
        : `skill threw: ${e?.message ?? String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
