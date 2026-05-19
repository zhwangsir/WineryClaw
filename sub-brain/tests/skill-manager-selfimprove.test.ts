import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SkillManager, type Skill } from "../src/skills/skill-manager.js";

const SKILLS_DIR = join(homedir(), ".webrain", "skills");
const IMPROVED_DIR = join(SKILLS_DIR, "improved");
const DRAFTS_DIR = join(SKILLS_DIR, "drafts");

/**
 * Self-learning behavior tests.
 *
 * SkillManager persists to ~/.webrain/skills/... and cannot be redirected
 * cleanly per-test today. We therefore use unique synthetic ids and clean
 * them in beforeEach/afterEach so production data is untouched.
 */
function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: `skill-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: "Test Skill",
    description: "test fixture",
    triggerPatterns: ["__never-match__"],
    code: "throw new Error('not used')",
    language: "javascript",
    usageCount: 0,
    successRate: 0,
    createdBy: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    tags: [],
    source: "user",
    ...overrides,
  };
}

function wipeTestArtifacts() {
  if (existsSync(DRAFTS_DIR)) {
    try {
      for (const id of readdirSync(DRAFTS_DIR)) {
        if (id.startsWith("skill-draft-") || id.includes("test")) {
          try { rmSync(join(DRAFTS_DIR, id), { recursive: true, force: true }); } catch {}
        }
      }
    } catch {}
  }
  if (existsSync(IMPROVED_DIR)) {
    try {
      for (const id of readdirSync(IMPROVED_DIR)) {
        if (id.startsWith("skill-test-")) {
          try { rmSync(join(IMPROVED_DIR, id), { recursive: true, force: true }); } catch {}
        }
      }
    } catch {}
  }
}

describe("SkillManager self-improvement", () => {
  let mgr: SkillManager;

  beforeEach(() => {
    wipeTestArtifacts();
    mgr = new SkillManager();
  });

  afterEach(() => {
    wipeTestArtifacts();
  });

  describe("getCandidatesForImprovement", () => {
    it("returns nothing when usage is below threshold", () => {
      const skill = makeSkill({ usageCount: 3, successRate: 0.2 });
      (mgr as any).skills.set(skill.id, skill);

      expect(mgr.getCandidatesForImprovement()).toEqual([]);
    });

    it("returns nothing when failure rate is below threshold", () => {
      const skill = makeSkill({ usageCount: 20, successRate: 0.95 });
      (mgr as any).skills.set(skill.id, skill);

      expect(mgr.getCandidatesForImprovement()).toEqual([]);
    });

    it("returns nothing when no failureModes are recorded", () => {
      const skill = makeSkill({ usageCount: 20, successRate: 0.2 });
      (mgr as any).skills.set(skill.id, skill);

      expect(mgr.getCandidatesForImprovement()).toEqual([]);
    });

    it("flags candidate when usage + failure rate + failureModes all qualify", () => {
      const skill = makeSkill({
        usageCount: 20,
        successRate: 0.5,
        failureModes: [
          { signature: "TypeError: cannot read", count: 7, lastSeen: new Date().toISOString(), examples: ["TypeError: cannot read property"] },
          { signature: "ENOENT", count: 3, lastSeen: new Date().toISOString(), examples: ["ENOENT: no such file"] },
        ],
      });
      (mgr as any).skills.set(skill.id, skill);

      const candidates = mgr.getCandidatesForImprovement();
      // Some pre-existing real skills in ~/.webrain may also qualify; filter to our id.
      const ours = candidates.filter((c) => c.skill.id === skill.id);
      expect(ours).toHaveLength(1);
      expect(ours[0].primaryFailureMode.signature).toBe("TypeError: cannot read");
      expect(ours[0].reason).toContain("50% failure rate");
      expect(ours[0].reason).toContain("after 20 uses");
    });

    it("respects the 1h refinement cooldown", () => {
      const recent = new Date().toISOString();
      const skill = makeSkill({
        usageCount: 20,
        successRate: 0.2,
        lastRefinedAt: recent,
        failureModes: [
          { signature: "X", count: 10, lastSeen: recent, examples: [] },
        ],
      });
      (mgr as any).skills.set(skill.id, skill);

      const ours = mgr.getCandidatesForImprovement().filter((c) => c.skill.id === skill.id);
      expect(ours).toEqual([]);
    });

    it("respects autoImprove.enabled = false", () => {
      const skill = makeSkill({
        usageCount: 50,
        successRate: 0.1,
        autoImprove: { enabled: false, thresholdUses: 10, thresholdFailureRate: 0.15 },
        failureModes: [
          { signature: "X", count: 30, lastSeen: new Date().toISOString(), examples: [] },
        ],
      });
      (mgr as any).skills.set(skill.id, skill);

      const ours = mgr.getCandidatesForImprovement().filter((c) => c.skill.id === skill.id);
      expect(ours).toEqual([]);
    });
  });

  describe("createImprovedFork", () => {
    it("returns undefined for unknown skill id", () => {
      expect(mgr.createImprovedFork("does-not-exist", "code", "reason")).toBeUndefined();
    });

    it("creates a fork with bumped version and forkOf set", () => {
      const original = makeSkill({ id: "skill-test-foo", version: 2, usageCount: 99, code: "OLD CODE" });
      (mgr as any).skills.set(original.id, original);

      const fork = mgr.createImprovedFork(original.id, "new code", "fixed null deref");
      expect(fork).toBeDefined();
      expect(fork!.id).toBe("skill-test-foo-improved-v3");
      expect(fork!.version).toBe(3);
      expect(fork!.forkOf).toBe("skill-test-foo");
      expect(fork!.code).toBe("new code");
      expect(fork!.source).toBe("agent-auto");
      expect(fork!.usageCount).toBe(0);
      expect(fork!.successRate).toBe(0);
      expect(fork!.failureModes).toEqual([]);
      // Original preserved untouched
      expect(mgr.getSkill(original.id)?.code).toBe("OLD CODE");
      expect(mgr.getSkill(original.id)?.version).toBe(2);
    });

    it("writes skill.json and reason.txt to improved/<id>/v<N>/", () => {
      const original = makeSkill({ id: "skill-test-bar", version: 1 });
      (mgr as any).skills.set(original.id, original);

      mgr.createImprovedFork(original.id, "improved", "race condition fix");

      expect(existsSync(join(IMPROVED_DIR, "skill-test-bar", "v2", "skill.json"))).toBe(true);
      expect(existsSync(join(IMPROVED_DIR, "skill-test-bar", "v2", "reason.txt"))).toBe(true);
    });
  });

  describe("draft lifecycle", () => {
    it("createDraft writes to drafts/ but does not enter runtime skills map", () => {
      const draft = mgr.createDraft({
        name: "Auto-discovered skill",
        description: "captured from successful task",
        code: "console.log('hi')",
        language: "javascript",
        triggerPatterns: ["do thing"],
        reason: "first successful run of novel task",
      });

      expect(existsSync(join(DRAFTS_DIR, draft.id, "skill.json"))).toBe(true);
      expect(existsSync(join(DRAFTS_DIR, draft.id, "reason.txt"))).toBe(true);
      expect(mgr.getSkill(draft.id)).toBeUndefined();
    });

    it("listDrafts returns drafts on disk", () => {
      const draft = mgr.createDraft({
        name: "Draft A",
        description: "",
        code: "x",
        language: "javascript",
        triggerPatterns: [],
        reason: "r",
      });
      const drafts = mgr.listDrafts();
      expect(drafts.some((d) => d.id === draft.id)).toBe(true);
    });

    it("promoteDraft moves a draft into runtime skills", () => {
      const draft = mgr.createDraft({
        name: "Promote Me",
        description: "",
        code: "y",
        language: "javascript",
        triggerPatterns: [],
        reason: "r",
      });
      const promoted = mgr.promoteDraft(draft.id);
      expect(promoted).toBeDefined();
      expect(promoted!.id).not.toContain("-draft-");
      expect(mgr.getSkill(promoted!.id)).toBeDefined();
    });

    it("promoteDraft returns undefined for unknown draft id", () => {
      expect(mgr.promoteDraft("nonexistent")).toBeUndefined();
    });
  });

  describe("failure-mode clustering via invokeSkill", () => {
    it("aggregates similar errors under one signature", async () => {
      // Plant a deliberately-failing JS skill (broken syntax).
      const skill = makeSkill({
        id: "skill-test-broken",
        code: "throw new Error('boom')",
        language: "javascript",
      });
      (mgr as any).skills.set(skill.id, skill);

      await mgr.invokeSkill(skill.id, {}, "s1");
      await mgr.invokeSkill(skill.id, {}, "s2");

      const after = mgr.getSkill(skill.id)!;
      expect(after.usageCount).toBeGreaterThanOrEqual(2);
      expect(after.failureModes).toBeDefined();
      expect(after.failureModes!.length).toBeGreaterThanOrEqual(1);
      const total = after.failureModes!.reduce((s, m) => s + m.count, 0);
      expect(total).toBeGreaterThanOrEqual(2);
    });
  });
});
