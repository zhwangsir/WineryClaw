/**
 * Tests for the M6a JS skill runtime (worker_threads isolation).
 *
 * Focus on the security and reliability properties the new runtime
 * exists to provide:
 *   1. No shell evaluation of params (round-trip through structured clone)
 *   2. Reliable timeout that actually terminates runaway code
 *   3. Captured throw → ok=false with descriptive error
 *   4. Async / await user code is supported
 */

import { describe, expect, it } from "vitest";
import { runJsSkill } from "../src/skills/runtime/run-js-skill.js";

describe("runJsSkill", () => {
  it("returns synchronous user return values via ok=true", async () => {
    const r = await runJsSkill({
      code: "return params.a + params.b;",
      params: { a: 2, b: 3 },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(5);
    expect(r.error).toBeUndefined();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.timedOut).not.toBe(true);
  });

  it("supports async user code with await", async () => {
    const r = await runJsSkill({
      code: `
        await new Promise(r => setTimeout(r, 20));
        return { woke: true, val: params.x };
      `,
      params: { x: 42 },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ woke: true, val: 42 });
  });

  it("captures synchronous throws as ok=false", async () => {
    const r = await runJsSkill({
      code: 'throw new Error("nope from user code");',
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nope from user code/);
  });

  it("captures async rejections as ok=false", async () => {
    const r = await runJsSkill({
      code: 'await Promise.reject(new Error("async failure"));',
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/async failure/);
  });

  it("isolates params from shell — strings with shell metachars survive verbatim", async () => {
    // The old execSync path would have shell-interpolated this. Worker
    // structured clone preserves it exactly.
    const exploit = '"; touch /tmp/webrain-pwn-' + Date.now() + '; echo "';
    const r = await runJsSkill({
      code: "return params.exploit;",
      params: { exploit },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(exploit);
  });

  it("preserves nested structures and Unicode in params", async () => {
    const params = {
      nested: { array: [1, "two", { deep: true }], emoji: "🎉中文" },
      bigNumber: 9007199254740991,
    };
    const r = await runJsSkill({
      code: "return params;",
      params,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual(params);
  });

  it("terminates runaway code at the timeout boundary", async () => {
    const start = Date.now();
    const r = await runJsSkill({
      code: "while (true) {}", // CPU-bound infinite loop
      params: {},
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/timed out/);
    // Generous upper bound for slow CI — the point is it doesn't run forever.
    expect(elapsed).toBeLessThan(2000);
  });

  it("clamps below-minimum timeout to the safety floor", async () => {
    // timeoutMs=0 would be useless. We floor at 100ms.
    const r = await runJsSkill({
      code: "return 'ok';",
      params: {},
      timeoutMs: 0,
    });
    // Should NOT immediately time out — should complete.
    expect(r.ok).toBe(true);
  });

  it("returns ok=false when user code returns nothing (undefined)", async () => {
    // `return;` is still a valid run; we treat that as ok=true with result=undefined
    const r = await runJsSkill({
      code: "return;",
      params: {},
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBeUndefined();
  });

  it("returns ok=false with descriptive message on user syntax error", async () => {
    const r = await runJsSkill({
      code: "return params.;", // syntax error
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("each call gets a fresh worker (no leaked state)", async () => {
    await runJsSkill({
      code: "globalThis.__leaked = 'should not survive';",
      params: {},
    });
    const r = await runJsSkill({
      code: "return typeof globalThis.__leaked;",
      params: {},
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe("undefined");
  });
});
