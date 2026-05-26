/**
 * Tests for `pickPythonInterpreter` — the Python-interpreter selection
 * rule that's the regression target for user-trial bug #10.
 *
 * Bug recap: before this rule, sub-brain spawned `python3` from system
 * PATH which doesn't have the main-brain deps. Result: README's
 * `pnpm dev` onboarding silently produced a dead child with
 * `ModuleNotFoundError: No module named 'watchdog'`.
 *
 * If any of these tests fail, fresh-user onboarding via `pnpm dev` is
 * broken again.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pickPythonInterpreter } from "../src/main-brain-spawn.js";

describe("pickPythonInterpreter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = `/tmp/webrain-pyspawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("uses WEBRAIN_PYTHON env var when set (highest precedence)", () => {
    // Even with a real venv present, env override wins
    mkdirSync(join(tmpDir, "venv", "bin"), { recursive: true });
    writeFileSync(join(tmpDir, "venv", "bin", "python3"), "");

    const result = pickPythonInterpreter(tmpDir, { WEBRAIN_PYTHON: "/usr/local/bin/python3.12" });
    expect(result.path).toBe("/usr/local/bin/python3.12");
    expect(result.diagnostic).toBe("env");
  });

  it("trims whitespace from WEBRAIN_PYTHON", () => {
    const result = pickPythonInterpreter(tmpDir, { WEBRAIN_PYTHON: "  /opt/py  " });
    expect(result.path).toBe("/opt/py");
    expect(result.diagnostic).toBe("env");
  });

  it("ignores empty WEBRAIN_PYTHON and falls through to next rule", () => {
    // Empty string env var must not be treated as an explicit override
    mkdirSync(join(tmpDir, "venv", "bin"), { recursive: true });
    writeFileSync(join(tmpDir, "venv", "bin", "python3"), "");

    const result = pickPythonInterpreter(tmpDir, { WEBRAIN_PYTHON: "" });
    expect(result.diagnostic).toBe("venv");
    expect(result.path).toContain("venv/bin/python3");
  });

  it("ignores whitespace-only WEBRAIN_PYTHON", () => {
    mkdirSync(join(tmpDir, "venv", "bin"), { recursive: true });
    writeFileSync(join(tmpDir, "venv", "bin", "python3"), "");

    const result = pickPythonInterpreter(tmpDir, { WEBRAIN_PYTHON: "   " });
    expect(result.diagnostic).toBe("venv");
  });

  it("uses local venv/bin/python3 when no env override is set", () => {
    mkdirSync(join(tmpDir, "venv", "bin"), { recursive: true });
    writeFileSync(join(tmpDir, "venv", "bin", "python3"), "");

    const result = pickPythonInterpreter(tmpDir, {});
    expect(result.path).toBe(join(tmpDir, "venv/bin/python3"));
    expect(result.diagnostic).toBe("venv");
  });

  it("falls back to system python3 when no venv exists", () => {
    // tmpDir has no venv/ subdirectory
    const result = pickPythonInterpreter(tmpDir, {});
    expect(result.path).toBe("python3");
    expect(result.diagnostic).toBe("system");
  });

  it("falls back to system python3 when venv/bin exists but no python3 binary", () => {
    // Partial venv (bin dir without the interpreter — e.g. broken install)
    mkdirSync(join(tmpDir, "venv", "bin"), { recursive: true });
    // Deliberately do NOT create the python3 file

    const result = pickPythonInterpreter(tmpDir, {});
    expect(result.path).toBe("python3");
    expect(result.diagnostic).toBe("system");
  });

  it("does not require existsSync check on WEBRAIN_PYTHON path (admin trust)", () => {
    // Admin may configure a wrapper script that's not present in this
    // filesystem snapshot (e.g. a Nix derivation, a remote-mounted bin).
    // We trust the env var and let spawn() surface any failure later.
    const result = pickPythonInterpreter(tmpDir, {
      WEBRAIN_PYTHON: "/definitely/does/not/exist/python",
    });
    expect(result.path).toBe("/definitely/does/not/exist/python");
    expect(result.diagnostic).toBe("env");
  });

  it("uses process.env by default when env arg is omitted", () => {
    // Sanity: signature default. We can't write to process.env safely
    // in tests, but we can verify the function doesn't crash when called
    // without the env argument.
    expect(() => pickPythonInterpreter(tmpDir)).not.toThrow();
  });
});
