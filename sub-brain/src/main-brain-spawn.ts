/**
 * Helpers for the sub-brain → main-brain subprocess spawn.
 *
 * Kept in its own module so the python-interpreter selection rule (the
 * regression target from user-trial bug #10) can be unit-tested without
 * having to spin up Fastify or fork the actual main-brain process.
 */

import { existsSync } from "fs";
import { resolve as pathResolve } from "path";

export type PickDiagnostic = "env" | "venv" | "system";

export interface PickedInterpreter {
  /** The absolute (or PATH-relative) command to invoke. */
  path: string;
  /** Which selection rule won — drives the log line in main.ts. */
  diagnostic: PickDiagnostic;
}

/**
 * Pick the Python interpreter that should run main_brain.py.
 *
 * Precedence:
 *   1. `WEBRAIN_PYTHON` env var (explicit admin override). Always trusted —
 *      we don't existsSync-check it because admins may legitimately
 *      configure a path that's only valid at runtime (a wrapper script,
 *      a Nix derivation, etc.).
 *   2. `<mainBrainDir>/venv/bin/python3` — the venv users follow the
 *      README to create with main-brain's `requirements.txt`. Has all
 *      transitive deps (watchdog, sentence-transformers, fastapi).
 *   3. System `python3` (last resort). Will almost certainly fail with
 *      `ModuleNotFoundError` because the user hasn't installed deps in
 *      the system interpreter — but better than a hard crash. main.ts
 *      logs a loud warning pointing at the venv-install instructions.
 *
 * This was the silent bug exposed by the 2026-05-20 user trial: the
 * README path `pnpm dev` worked for sub-brain itself but the spawned
 * main-brain child crashed with `No module named 'watchdog'` because
 * system python had nothing installed. Tests below pin the precedence.
 *
 * @param mainBrainDir Absolute path to the directory containing
 *                     main_brain.py (so we can look for venv/ alongside).
 * @param env          process.env or a stub for tests.
 */
export function pickPythonInterpreter(
  mainBrainDir: string,
  env: NodeJS.ProcessEnv = process.env,
): PickedInterpreter {
  const override = env.WEBRAIN_PYTHON;
  if (override && override.trim()) {
    return { path: override.trim(), diagnostic: "env" };
  }
  const venvPython = pathResolve(mainBrainDir, "venv/bin/python3");
  if (existsSync(venvPython)) {
    return { path: venvPython, diagnostic: "venv" };
  }
  return { path: "python3", diagnostic: "system" };
}
