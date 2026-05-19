/**
 * Tests for the M6a Python skill runtime (spawn + stdin isolation).
 *
 * Skipped in environments without python3 on PATH — we don't fail CI
 * for missing system dependencies, but when python3 IS available we
 * fully exercise the security properties.
 */

import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runPythonSkill } from "../src/skills/runtime/run-python-skill.js";

function pythonAvailable(): boolean {
  try {
    execSync("python3 --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skipIfNoPy = pythonAvailable() ? describe : describe.skip;

skipIfNoPy("runPythonSkill", () => {
  it("captures normal stdout output as result", async () => {
    const r = await runPythonSkill({
      code: 'print(params["greeting"] + " world")',
      params: { greeting: "hello" },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("hello world");
  });

  it("captures multiline stdout with trailing newlines trimmed", async () => {
    const r = await runPythonSkill({
      code: 'print("line1"); print("line2")',
      params: {},
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("line1\nline2");
  });

  it("captures Python traceback in error on non-zero exit", async () => {
    const r = await runPythonSkill({
      code: "raise RuntimeError('boom from python')",
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/RuntimeError/);
    expect(r.error).toMatch(/boom from python/);
  });

  it("isolates params from shell — strings with shell metachars are inert", async () => {
    const exploit = '"; rm -rf $HOME/.never_should_run; echo "';
    const r = await runPythonSkill({
      code: "print(params['exploit'])",
      params: { exploit },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(exploit);
  });

  it("preserves unicode in stdin params", async () => {
    const r = await runPythonSkill({
      code: 'print(params["text"])',
      params: { text: "中文 + emoji 🎉" },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("中文 + emoji 🎉");
  });

  it("terminates runaway python at the timeout boundary", async () => {
    const start = Date.now();
    const r = await runPythonSkill({
      code: "import time\nwhile True: time.sleep(1)",
      params: {},
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/timed out/);
    expect(elapsed).toBeLessThan(3000);
  });

  it("returns ok=false with spawn error when pythonBin doesn't exist", async () => {
    const r = await runPythonSkill({
      code: 'print("x")',
      params: {},
      pythonBin: "/definitely/not/a/real/python_binary_xyz",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("can read nested params via dict access", async () => {
    const r = await runPythonSkill({
      code: 'print(params["nested"]["value"] * 2)',
      params: { nested: { value: 21 } },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("42");
  });

  it("trims trailing newline from stdout for cleaner consumer code", async () => {
    const r = await runPythonSkill({
      code: 'print("trailing")',
      params: {},
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("trailing");
    expect(String(r.result).endsWith("\n")).toBe(false);
  });
});
