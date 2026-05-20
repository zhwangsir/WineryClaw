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

  // ─────────────────────────────────────────────────────────────────
  // Round C9: structured-result API. JS skills already supported
  // `return value`; Python now mirrors that via `result = value` or
  // explicit `set_result(value)`. Both emit a marker the runner
  // parses, giving back the original Python value type (not a string).
  // ─────────────────────────────────────────────────────────────────

  it("Round C9: result = <int> returns the int, not the string '42'", async () => {
    const r = await runPythonSkill({
      code: "result = params['a'] * 6",
      params: { a: 7 },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(42); // number, not "42"
  });

  it("Round C9: result = <dict> round-trips as an object", async () => {
    const r = await runPythonSkill({
      code: "result = {'sum': params['a'] + params['b'], 'product': params['a'] * params['b']}",
      params: { a: 3, b: 4 },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ sum: 7, product: 12 });
  });

  it("Round C9: result = <list> round-trips as an array", async () => {
    const r = await runPythonSkill({
      code: "result = [x ** 2 for x in params['nums']]",
      params: { nums: [1, 2, 3, 4] },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual([1, 4, 9, 16]);
  });

  it("Round C9: set_result(value) takes precedence over the result variable", async () => {
    const r = await runPythonSkill({
      code: `result = 'wrong'
set_result('right')`,
      params: {},
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("right");
  });

  it("Round C9: print() before set_result() is dropped — only structured result kept", async () => {
    const r = await runPythonSkill({
      code: `print('debug message')
set_result({'final': True})`,
      params: {},
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ final: true });
  });

  it("Round C9: legacy print(value)-only skill still works (no marker → raw stdout)", async () => {
    // Backwards-compat: skills that only print and never assign `result`
    // or call set_result must still see the raw-string behaviour.
    const r = await runPythonSkill({
      code: "print('legacy contract')",
      params: {},
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("legacy contract");
  });

  it("Round C9: result = None doesn't emit a structured result", async () => {
    // None is the sentinel for "user didn't actually set a result" —
    // they could've meant to but the implicit emitter shouldn't fire.
    const r = await runPythonSkill({
      code: "result = None\nprint('shown instead')",
      params: {},
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("shown instead");
  });

  it("Round C9: set() coerces via default=str — emits string representation, doesn't crash", async () => {
    // json.dumps in set_result uses default=str, so unusual Python
    // values that aren't strict JSON types (set, datetime, etc.)
    // get coerced to their str() form rather than crashing the skill.
    // Tradeoff: lose type fidelity, gain robustness. The string is
    // still useful for debugging / display purposes.
    const r = await runPythonSkill({
      code: "result = {1, 2, 3}",
      params: {},
    });
    expect(r.ok).toBe(true);
    // Python's str({1,2,3}) on CPython 3.x — order is implementation-
    // defined but the chars are {, 1, ,, ' ', 2, ,, ' ', 3, }. Just
    // assert it's a string that contains the elements.
    expect(typeof r.result).toBe("string");
    expect(String(r.result)).toContain("1");
    expect(String(r.result)).toContain("2");
    expect(String(r.result)).toContain("3");
  });
});
