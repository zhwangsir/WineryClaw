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
 *
 * Each test uses a synthetic skill id so production ~/.webrain/skills/
 * data is untouched. We rely on createSkill → manual sandbox flag write
 * because the createSkill signature doesn't accept it (kept for
 * backward compat).
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SkillManager, type Skill } from "../src/skills/skill-manager.js";

const SKILLS_DIR = join(homedir(), ".webrain", "skills");
const SKILLS_FILE = join(SKILLS_DIR, "skills.json");

const TEST_PREFIX = "skill-test-sandbox-";

/** Reload SKILLS_FILE, mutate the matching skill, write back, return manager. */
function setSandboxFlag(mgr: SkillManager, id: string, sandbox: boolean): void {
  // SkillManager keeps an in-memory cache and persists on createSkill;
  // we need to flip `sandbox` on disk + reload to ensure invokeSkill
  // sees the updated flag.
  const arr: Skill[] = JSON.parse(readFileSync(SKILLS_FILE, "utf-8"));
  const idx = arr.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error(`skill not found: ${id}`);
  arr[idx].sandbox = sandbox;
  writeFileSync(SKILLS_FILE, JSON.stringify(arr, null, 2));
  // Re-read so private `skills` Map picks up the change.
  // SkillManager doesn't expose a reload; force via constructor.
  // The shared mutable state on disk + a fresh instance is the cleanest
  // dance for an integration test.
  (mgr as unknown as { skills: Map<string, Skill> }).skills.get(id)!.sandbox =
    sandbox;
}

function wipeTestSkills(): void {
  if (!existsSync(SKILLS_FILE)) return;
  try {
    const arr: Skill[] = JSON.parse(readFileSync(SKILLS_FILE, "utf-8"));
    const kept = arr.filter((s) => !s.id.startsWith(TEST_PREFIX));
    writeFileSync(SKILLS_FILE, JSON.stringify(kept, null, 2));
  } catch {
    // ignore
  }
}

describe("SkillManager — v2.37 vm sandbox dispatch", () => {
  afterEach(() => {
    wipeTestSkills();
  });

  it("sandbox=true: require('fs') is BLOCKED inside the vm context", async () => {
    const mgr = new SkillManager();
    // Manually overwrite skill id to include our test prefix so wipe
    // catches it. createSkill produces `skill-<ts>`; we then mutate.
    const skill = mgr.createSkill(
      "fs-attack",
      "tries to read /etc/hosts",
      `const fs = require('fs'); return fs.readFileSync('/etc/hosts', 'utf-8').slice(0, 32);`,
      "javascript"
    );
    // Re-tag id for wipe + sandbox=true
    const arr: Skill[] = JSON.parse(readFileSync(SKILLS_FILE, "utf-8"));
    const idx = arr.findIndex((s) => s.id === skill.id);
    const newId = `${TEST_PREFIX}${Date.now()}`;
    arr[idx].id = newId;
    arr[idx].sandbox = true;
    writeFileSync(SKILLS_FILE, JSON.stringify(arr, null, 2));
    (mgr as unknown as { skills: Map<string, Skill> }).skills.delete(skill.id);
    (mgr as unknown as { skills: Map<string, Skill> }).skills.set(newId, arr[idx]);

    const out = (await mgr.invokeSkill(newId, {}, "sess-sandbox-1")) as {
      success: boolean;
      result: unknown;
      error?: string;
    };
    expect(out.success).toBe(false);
    expect(out.error ?? "").toMatch(/require is not defined|ReferenceError/);
  });

  it("sandbox=false (default): same require('fs') skill executes (no block)", async () => {
    const mgr = new SkillManager();
    const skill = mgr.createSkill(
      "fs-legit",
      "uses fs legitimately",
      `const fs = require('fs'); return typeof fs.readFileSync;`,
      "javascript"
    );
    // Re-tag id only (no sandbox flag = default worker_threads dispatch).
    const arr: Skill[] = JSON.parse(readFileSync(SKILLS_FILE, "utf-8"));
    const idx = arr.findIndex((s) => s.id === skill.id);
    const newId = `${TEST_PREFIX}${Date.now()}-legit`;
    arr[idx].id = newId;
    writeFileSync(SKILLS_FILE, JSON.stringify(arr, null, 2));
    (mgr as unknown as { skills: Map<string, Skill> }).skills.delete(skill.id);
    (mgr as unknown as { skills: Map<string, Skill> }).skills.set(newId, arr[idx]);

    const out = (await mgr.invokeSkill(newId, {}, "sess-sandbox-2")) as {
      success: boolean;
      result: unknown;
    };
    expect(out.success).toBe(true);
    // worker_threads runtime has require() available — typeof === "function"
    expect(out.result).toBe("function");
  });

  it("sandbox=true: harmless code (return params) still executes correctly", async () => {
    const mgr = new SkillManager();
    const skill = mgr.createSkill(
      "math",
      "adds two numbers",
      `return params.a + params.b;`,
      "javascript"
    );
    const arr: Skill[] = JSON.parse(readFileSync(SKILLS_FILE, "utf-8"));
    const idx = arr.findIndex((s) => s.id === skill.id);
    const newId = `${TEST_PREFIX}${Date.now()}-math`;
    arr[idx].id = newId;
    arr[idx].sandbox = true;
    writeFileSync(SKILLS_FILE, JSON.stringify(arr, null, 2));
    (mgr as unknown as { skills: Map<string, Skill> }).skills.delete(skill.id);
    (mgr as unknown as { skills: Map<string, Skill> }).skills.set(newId, arr[idx]);

    const out = (await mgr.invokeSkill(newId, { a: 19, b: 23 }, "sess-sandbox-3")) as {
      success: boolean;
      result: unknown;
    };
    expect(out.success).toBe(true);
    expect(out.result).toBe(42);
  });

  it("sandbox=true: process.env is also blocked (additional safety claim)", async () => {
    const mgr = new SkillManager();
    const skill = mgr.createSkill(
      "env-attack",
      "tries to read host env",
      `return process.env.HOME;`,
      "javascript"
    );
    const arr: Skill[] = JSON.parse(readFileSync(SKILLS_FILE, "utf-8"));
    const idx = arr.findIndex((s) => s.id === skill.id);
    const newId = `${TEST_PREFIX}${Date.now()}-env`;
    arr[idx].id = newId;
    arr[idx].sandbox = true;
    writeFileSync(SKILLS_FILE, JSON.stringify(arr, null, 2));
    (mgr as unknown as { skills: Map<string, Skill> }).skills.delete(skill.id);
    (mgr as unknown as { skills: Map<string, Skill> }).skills.set(newId, arr[idx]);

    const out = (await mgr.invokeSkill(newId, {}, "sess-sandbox-4")) as {
      success: boolean;
      error?: string;
    };
    expect(out.success).toBe(false);
    expect(out.error ?? "").toMatch(/process is not defined|ReferenceError/);
  });
});
