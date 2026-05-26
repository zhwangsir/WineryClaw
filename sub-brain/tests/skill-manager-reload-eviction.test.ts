import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SkillManager, type Skill } from "../src/skills/skill-manager.js";

/**
 * Regression test for the eviction-guard bug (code review, 2026-05-21):
 *
 *   reloadInstalledHubSkills() used `createdBy !== "user" && createdBy !==
 *   "builtin"` as a heuristic for "this skill came from the hub". That was
 *   wrong on two counts:
 *
 *   1. User-created skills default to `createdBy: "agent-default"` (see
 *      createSkill()), so they failed the !== "user" check and were silently
 *      evicted on every hub install/uninstall.
 *   2. Built-ins default to `createdBy: "webrain-built-in"`, mismatching the
 *      "builtin" sentinel — same eviction bug latent.
 *
 *   The correct discriminator is `source === "hub"` (set by
 *   SkillHubClient.install). These tests pin that behaviour down so the
 *   regression cannot return.
 */
const INSTALLED_DIR = join(homedir(), ".webrain", "skills", "installed");
const TEST_HUB_ID = "skill-reload-test-hub-gone-x9";
const TEST_HUB_LIVE_ID = "skill-reload-test-hub-live-y2";

function makeSkill(overrides: Partial<Skill>): Skill {
  return {
    id: "skill-reload-test-base",
    name: "test",
    description: "",
    triggerPatterns: [],
    code: "",
    language: "javascript",
    usageCount: 0,
    successRate: 0,
    createdBy: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    tags: [],
    ...overrides,
  };
}

function cleanInstalledDirOfTestArtifacts() {
  for (const id of [TEST_HUB_ID, TEST_HUB_LIVE_ID]) {
    const p = join(INSTALLED_DIR, id);
    if (existsSync(p)) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

describe("SkillManager.reloadInstalledHubSkills — eviction guard (R1 regression)", () => {
  let mgr: SkillManager;

  beforeEach(() => {
    cleanInstalledDirOfTestArtifacts();
    mgr = new SkillManager();
  });

  afterEach(() => {
    cleanInstalledDirOfTestArtifacts();
  });

  it("does NOT evict user-authored skills (createdBy='agent-default', source='user')", () => {
    const userSkill = makeSkill({
      id: "skill-reload-test-user-keep",
      createdBy: "agent-default", // ← the default createSkill() sets
      source: "user",
    });
    (mgr as any).skills.set(userSkill.id, userSkill);

    mgr.reloadInstalledHubSkills();

    expect(mgr.getSkill(userSkill.id)).toBeDefined();
  });

  it("does NOT evict built-in skills (createdBy='webrain-built-in', source='built-in')", () => {
    const builtinSkill = makeSkill({
      id: "skill-reload-test-builtin-keep",
      createdBy: "webrain-built-in",
      source: "built-in",
    });
    (mgr as any).skills.set(builtinSkill.id, builtinSkill);

    mgr.reloadInstalledHubSkills();

    expect(mgr.getSkill(builtinSkill.id)).toBeDefined();
  });

  it("does NOT evict agent-auto-generated skills (source='agent-auto')", () => {
    const agentSkill = makeSkill({
      id: "skill-reload-test-agent-keep",
      createdBy: "agent-auto",
      source: "agent-auto",
    });
    (mgr as any).skills.set(agentSkill.id, agentSkill);

    mgr.reloadInstalledHubSkills();

    expect(mgr.getSkill(agentSkill.id)).toBeDefined();
  });

  it("DOES evict hub skills whose disk file is gone (source='hub', file removed)", () => {
    const goneHubSkill = makeSkill({
      id: TEST_HUB_ID,
      source: "hub",
      createdBy: "external-author",
    });
    (mgr as any).skills.set(goneHubSkill.id, goneHubSkill);
    // No file on disk → eviction expected.
    mgr.reloadInstalledHubSkills();

    expect(mgr.getSkill(goneHubSkill.id)).toBeUndefined();
  });

  it("does NOT evict hub skills whose disk file still exists", () => {
    const liveHubSkill = makeSkill({
      id: TEST_HUB_LIVE_ID,
      source: "hub",
      createdBy: "external-author",
    });
    // Put the file on disk so reload sees it as live.
    const dir = join(INSTALLED_DIR, TEST_HUB_LIVE_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skill.json"), JSON.stringify(liveHubSkill));

    (mgr as any).skills.set(liveHubSkill.id, liveHubSkill);
    mgr.reloadInstalledHubSkills();

    expect(mgr.getSkill(liveHubSkill.id)).toBeDefined();
  });
});
