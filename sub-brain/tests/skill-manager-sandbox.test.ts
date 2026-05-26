/**
 * v2.37 — End-to-end sandbox dispatch test.
 *
 * v2.31 shipped `run-js-vm-skill.ts` (vm-context sandbox) but
 * SkillManager.invokeSkill never routed to it — the new runtime was
 * effectively dead code. v2.37 wires `skill.sandbox === true` to
 * dispatch through the vm runtime instead of the worker runtime.
 *
 * These tests assert the actual end-to-end behavior:
 *   1. A sandboxed JS skill that tries to require('fs') FAILS.
 *   2. A non-sandboxed JS skill with the SAME code SUCCEEDS at require
 *      (proving the dispatch flag is the only difference).
 *   3. The vm sandbox still runs harmless code correctly (no
 *      false positives — accidental over-restriction).
 *   4. process.env is also unreachable (additional safety claim).
 *
 * v2.37.1: rewritten to bypass `createSkill()` / SKILLS_FILE entirely.
 * The original implementation wrote to `~/.webrain/skills/skills.json`,
 * which races with sibling skill-* tests under vitest's `pool: "forks"`
 * (every fork shares the user home dir). Pure in-memory injection via
 * the manager's private `skills` Map gives us total isolation while
 * still exercising the real dispatch logic inside `invokeSkill`.
 */
import { describe, it, expect } from "vitest";
import { SkillManager, type Skill } from "../src/skills/skill-manager.js";

/**
 * Build a fully-populated Skill row directly (no disk write).
 * The manager's invokeSkill reads from its in-memory `skills` Map,
 * so this is sufficient to exercise the dispatch branch.
 */
function makeSkillRow(overrides: Partial<Skill>): Skill {
  const now = new Date().toISOString();
  return {
    id: `skill-sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "test-skill",
    description: "synthetic test skill",
    triggerPatterns: [],
    code: "return params;",
    language: "javascript",
    usageCount: 0,
    successRate: 1,
    createdBy: "test",
    createdAt: now,
    updatedAt: now,
    version: 1,
    tags: ["test"],
    source: "user",
    ...overrides,
  };
}

/** Inject a skill straight into the manager's private cache. */
function injectSkill(mgr: SkillManager, skill: Skill): void {
  (mgr as unknown as { skills: Map<string, Skill> }).skills.set(skill.id, skill);
}

describe("SkillManager — v2.37 vm sandbox dispatch", () => {
  it("sandbox=true: require('fs') is BLOCKED inside the vm context", async () => {
    const mgr = new SkillManager();
    const skill = makeSkillRow({
      name: "fs-attack",
      code: `const fs = require('fs'); return fs.readFileSync('/etc/hosts', 'utf-8').slice(0, 32);`,
      sandbox: true,
    });
    injectSkill(mgr, skill);

    const out = (await mgr.invokeSkill(skill.id, {}, "sess-sandbox-1")) as {
      success: boolean;
      result: unknown;
      error?: string;
    };
    expect(out.success).toBe(false);
    expect(out.error ?? "").toMatch(/require is not defined|ReferenceError/);
  });

  it("sandbox=false (default): same require('fs') skill executes (no block)", async () => {
    const mgr = new SkillManager();
    const skill = makeSkillRow({
      name: "fs-legit",
      code: `const fs = require('fs'); return typeof fs.readFileSync;`,
      // sandbox omitted = falsy = worker_threads runtime
    });
    injectSkill(mgr, skill);

    const out = (await mgr.invokeSkill(skill.id, {}, "sess-sandbox-2")) as {
      success: boolean;
      result: unknown;
    };
    expect(out.success).toBe(true);
    // worker_threads runtime has require() available — typeof === "function"
    expect(out.result).toBe("function");
  });

  it("sandbox=true: harmless code (return params) still executes correctly", async () => {
    const mgr = new SkillManager();
    const skill = makeSkillRow({
      name: "math",
      code: `return params.a + params.b;`,
      sandbox: true,
    });
    injectSkill(mgr, skill);

    const out = (await mgr.invokeSkill(skill.id, { a: 19, b: 23 }, "sess-sandbox-3")) as {
      success: boolean;
      result: unknown;
    };
    expect(out.success).toBe(true);
    expect(out.result).toBe(42);
  });

  it("sandbox=true: process.env is also blocked (additional safety claim)", async () => {
    const mgr = new SkillManager();
    const skill = makeSkillRow({
      name: "env-attack",
      code: `return process.env.HOME;`,
      sandbox: true,
    });
    injectSkill(mgr, skill);

    const out = (await mgr.invokeSkill(skill.id, {}, "sess-sandbox-4")) as {
      success: boolean;
      error?: string;
    };
    expect(out.success).toBe(false);
    expect(out.error ?? "").toMatch(/process is not defined|ReferenceError/);
  });
});
