/**
 * v2.31 — vm-sandbox skill runtime tests (ROADMAP V2 P0 #1 / M6.1).
 *
 * Each test is structured as a security claim: "the sandbox prevents X".
 * The corresponding assertion verifies the claim by running malicious-
 * looking code inside the sandbox and proving it failed.
 */

import { describe, it, expect } from "vitest";
import { runJsVmSkill } from "../src/skills/runtime/run-js-vm-skill.js";

describe("runJsVmSkill — happy paths", () => {
  it("returns the value of the last `return`", async () => {
    const r = await runJsVmSkill({
      code: "return params.x + params.y;",
      params: { x: 2, y: 40 },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(42);
  });

  it("supports `await` inside the skill", async () => {
    const r = await runJsVmSkill({
      code: "const a = await Promise.resolve(7); return a * params.factor;",
      params: { factor: 6 },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(42);
  });

  it("exposes JSON / Math / Date / URL / Buffer built-ins", async () => {
    const r = await runJsVmSkill({
      code: `
        const j = JSON.stringify({ ts: Date.now(), pi: Math.PI });
        const u = new URL("https://example.com/path?q=1");
        const b = Buffer.from("hi", "utf8").toString("hex");
        return { j_ok: j.length > 0, host: u.host, hex: b };
      `,
      params: {},
    });
    expect(r.ok).toBe(true);
    expect((r.result as any).host).toBe("example.com");
    expect((r.result as any).hex).toBe("6869");
  });

  it("records durationMs on success", async () => {
    const r = await runJsVmSkill({ code: "return 1;", params: {} });
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("runJsVmSkill — security: blocks dangerous access", () => {
  it("BLOCKS require() — ReferenceError", async () => {
    const r = await runJsVmSkill({
      code: `const fs = require("fs"); return "should-not-reach";`,
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/require is not defined|ReferenceError/);
  });

  it("BLOCKS process access — ReferenceError", async () => {
    const r = await runJsVmSkill({
      code: `return process.env.HOME;`,
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/process is not defined|ReferenceError/);
  });

  it("BLOCKS eval — codeGeneration.strings disabled", async () => {
    const r = await runJsVmSkill({
      code: `return eval("1 + 1");`,
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Code generation|disallowed|EvalError/i);
  });

  it("BLOCKS new Function — codeGeneration.strings disabled", async () => {
    const r = await runJsVmSkill({
      code: `const f = new Function("return 1"); return f();`,
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Code generation|disallowed|EvalError/i);
  });

  it("BLOCKS globalThis from leaking parent globals", async () => {
    // The vm context's globalThis is OUR sandbox object. require/process
    // are not properties of it. Inspecting globalThis must not yield them.
    const r = await runJsVmSkill({
      code: `
        const keys = Object.keys(globalThis);
        return { has_require: keys.includes("require"), has_process: keys.includes("process"), keys };
      `,
      params: {},
    });
    expect(r.ok).toBe(true);
    expect((r.result as any).has_require).toBe(false);
    expect((r.result as any).has_process).toBe(false);
  });

  it("BLOCKS access to setImmediate (timer escape vector)", async () => {
    const r = await runJsVmSkill({
      code: `return typeof setImmediate;`,
      params: {},
    });
    expect(r.ok).toBe(true);
    // setImmediate is NOT in the curated globals.
    expect(r.result).toBe("undefined");
  });
});

describe("runJsVmSkill — robustness", () => {
  it("times out on infinite synchronous loop", async () => {
    const r = await runJsVmSkill({
      code: `while (true) {}`,
      params: {},
      timeoutMs: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/timed out/);
  });

  it("times out on infinite async wait", async () => {
    const r = await runJsVmSkill({
      code: `await new Promise(() => {});`,
      params: {},
      timeoutMs: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/timed out/);
  });

  it("surfaces sync error from user code", async () => {
    const r = await runJsVmSkill({
      code: `throw new Error("boom");`,
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom/);
  });

  it("surfaces rejected promise from user code", async () => {
    const r = await runJsVmSkill({
      code: `await Promise.reject(new Error("async-boom"));`,
      params: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/async-boom/);
  });

  it("silent console by default — user code can't spam stderr", async () => {
    // No logs[] array is wired, so anything the skill console.log's
    // goes into a silent stub. We assert success without any stderr
    // capture mechanism (the test only fails if the runtime throws).
    const r = await runJsVmSkill({
      code: `console.log("would-spam"); console.error("would-spam"); return 1;`,
      params: {},
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(1);
  });

  it("custom console captures log + error", async () => {
    const logs: unknown[][] = [];
    const errs: unknown[][] = [];
    const r = await runJsVmSkill({
      code: `console.log("hi", 42); console.error("bad"); return 1;`,
      params: {},
      console: {
        log: (...args) => logs.push(args),
        error: (...args) => errs.push(args),
      },
    });
    expect(r.ok).toBe(true);
    expect(logs).toEqual([["hi", 42]]);
    expect(errs).toEqual([["bad"]]);
  });

  it("params is reachable inside the sandbox", async () => {
    const r = await runJsVmSkill({
      code: `return Object.keys(params).sort();`,
      params: { a: 1, c: 3, b: 2 },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual(["a", "b", "c"]);
  });

  it("clamps timeoutMs to MIN_TIMEOUT_MS floor", async () => {
    // Passing timeoutMs: 1 should still leave 50ms (the floor) to run.
    // A trivial skill must finish.
    const r = await runJsVmSkill({
      code: `return 7;`,
      params: {},
      timeoutMs: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(7);
  });
});
