/**
 * Skills System — Agent 自主技能创建与改进
 * Inspired by Hermes Agent (self-improving skills) + OpenClaw (skill hub).
 *
 * Telemetry → reflection → forked improvement is the core self-learning loop.
 * Improvements are written as IMMUTABLE forks under improved/<id>/v<N>/ rather
 * than mutating the original — so we can rollback, audit, or surface diffs.
 *
 * Auto-discovered drafts (skills the agent invented from successful novel tasks)
 * land in drafts/ and are NOT loaded into runtime until the user promotes them.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { runJsSkill } from "./runtime/run-js-skill.js";
import { runPythonSkill } from "./runtime/run-python-skill.js";

// --------------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------------

/**
 * A normalized signature for one cluster of failures.
 * Counts and example raws make it possible to feed reflection with both
 * statistical weight and concrete cases.
 */
export interface FailureMode {
  signature: string;
  count: number;
  lastSeen: string;
  examples: string[]; // up to 3 raw error samples for reflection context
}

export interface AutoImproveConfig {
  enabled: boolean;
  thresholdUses: number;        // min usageCount before considering
  thresholdFailureRate: number; // (1 - successRate) ≥ this triggers
}

/** Where a skill came from — used for ranking, UI badges, and registry sync. */
export type SkillSource = "built-in" | "user" | "agent-auto" | "hub";

export interface Skill {
  id: string;
  name: string;
  description: string;
  triggerPatterns: string[];
  code: string;
  language: "python" | "javascript" | "typescript";
  usageCount: number;
  successRate: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  tags: string[];

  // --- Hermes-style self-learning telemetry (optional, backward-compatible) ---
  failureModes?: FailureMode[];
  lastRefinedAt?: string;
  forkOf?: string;              // original skill id this is improved from
  autoImprove?: AutoImproveConfig;

  // --- OpenClaw-style source provenance ---
  source?: SkillSource;
  hubRegistry?: string;         // e.g. "agentskills.io"
}

export interface SkillInvocation {
  skillId: string;
  sessionId: string;
  params: Record<string, unknown>;
  success: boolean;
  result?: unknown;
  error?: string;
  timestamp: string;
}

export interface ImprovementCandidate {
  skill: Skill;
  primaryFailureMode: FailureMode;
  reason: string;
}

// --------------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------------

const SKILLS_DIR = join(homedir(), ".webrain", "skills");
const SKILLS_PATH = join(SKILLS_DIR, "skills.json");
const INVOCATIONS_PATH = join(SKILLS_DIR, "invocations.json");
const IMPROVED_DIR = join(SKILLS_DIR, "improved");
const DRAFTS_DIR = join(SKILLS_DIR, "drafts");
const INSTALLED_DIR = join(SKILLS_DIR, "installed");

const DEFAULT_AUTO_IMPROVE: AutoImproveConfig = {
  enabled: true,
  thresholdUses: 10,
  thresholdFailureRate: 0.15,
};

const REFINEMENT_COOLDOWN_MS = 60 * 60 * 1000; // 1h between refinement attempts

// --------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------

/**
 * Normalize an error string into a stable "signature" for clustering.
 * Strips paths, timestamps, hex ids, and big numbers so transient noise
 * doesn't fragment the same underlying failure across many "modes".
 */
function normalizeErrorSignature(err: string): string {
  const firstLine = err.split("\n")[0].trim();
  return firstLine
    .replace(/[A-Za-z]?:?\/[\/\w.+-]+/g, "<path>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, "<ts>")
    .replace(/\b0x[0-9a-fA-F]+/g, "<hex>")
    .replace(/\b\d{5,}\b/g, "<num>")
    .slice(0, 200);
}

// --------------------------------------------------------------------------------
// SkillManager
// --------------------------------------------------------------------------------

export class SkillManager {
  private skills = new Map<string, Skill>();
  private invocations: SkillInvocation[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(SKILLS_PATH)) {
        const list: Skill[] = JSON.parse(readFileSync(SKILLS_PATH, "utf-8"));
        for (const s of list) this.skills.set(s.id, s);
      }
      if (existsSync(INVOCATIONS_PATH)) {
        this.invocations = JSON.parse(readFileSync(INVOCATIONS_PATH, "utf-8"));
      }
      this._loadBuiltins();
      this._loadInstalledHubSkills();
      this._loadImprovedForks();
    } catch (err) {
      console.error("[skills] Load failed:", err);
    }
  }

  /**
   * Public re-entry to the hub-installed loader. Call this after the
   * Skillhub install/uninstall handlers touch ~/.webrain/skills/installed
   * so the in-memory `skills` map matches what's on disk. Without this
   * the install API succeeded but `invokeSkill(id)` would fail with
   * "Skill not found" until the next sub-brain restart.
   * Removes in-memory hub skills whose files no longer exist on disk
   * so uninstall is also reflected.
   */
  reloadInstalledHubSkills(): void {
    // Drop any previously-loaded HUB skills whose disk file is gone.
    // Original implementation used a fragile `createdBy` heuristic that
    // didn't match the real sentinels ("agent-default", "webrain-built-in",
    // "agent-auto") and silently evicted user-authored skills on every
    // install/uninstall (code-review finding 2026-05-21).
    // The right discriminator is `source === "hub"` — SkillHubClient sets
    // it at install time (skill-hub-client.ts: `skill.source = "hub"`).
    const live = new Set<string>();
    if (existsSync(INSTALLED_DIR)) {
      for (const id of readdirSync(INSTALLED_DIR)) {
        if (existsSync(join(INSTALLED_DIR, id, "skill.json"))) live.add(id);
      }
    }
    for (const [id, sk] of this.skills) {
      if (sk.source === "hub" && !live.has(id)) {
        this.skills.delete(id);
      }
    }
    this._loadInstalledHubSkills();
  }

  /**
   * Load skills installed via SkillHubClient. Mirrors _loadImprovedForks
   * but reads from ~/.webrain/skills/installed/<id>/skill.json.
   */
  private _loadInstalledHubSkills(): void {
    if (!existsSync(INSTALLED_DIR)) return;
    try {
      let count = 0;
      for (const id of readdirSync(INSTALLED_DIR)) {
        const p = join(INSTALLED_DIR, id, "skill.json");
        if (!existsSync(p)) continue;
        try {
          const skill: Skill = JSON.parse(readFileSync(p, "utf-8"));
          // Hub skills override built-ins/user with the same id but lose to
          // improved forks (forks are loaded after this method).
          this.skills.set(skill.id, skill);
          count++;
        } catch {
          /* skip corrupt */
        }
      }
      if (count > 0) console.log(`[skills] Loaded ${count} hub-installed skills`);
    } catch (err) {
      console.warn("[skills] Hub-installed load failed:", err);
    }
  }

  private _loadBuiltins(): void {
    try {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const builtinsDir = join(__dirname, "builtins");
      if (!existsSync(builtinsDir)) return;
      const files = readdirSync(builtinsDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const raw = JSON.parse(readFileSync(join(builtinsDir, file), "utf-8"));
        const skill: Skill = {
          ...raw,
          usageCount: raw.usageCount ?? 0,
          successRate: raw.successRate ?? 1.0,
          createdBy: raw.createdBy ?? "webrain-built-in",
          createdAt: raw.createdAt ?? new Date().toISOString(),
          updatedAt: raw.updatedAt ?? new Date().toISOString(),
          source: raw.source ?? "built-in",
        };
        // Don't overwrite user-modified entries with builtin defaults.
        if (!this.skills.has(skill.id)) {
          this.skills.set(skill.id, skill);
        }
      }
      console.log(`[skills] Loaded ${files.length} built-in skills`);
    } catch (err) {
      console.warn("[skills] Built-in load failed:", err);
    }
  }

  /**
   * Forks override originals at runtime. If multiple versions exist for one
   * forkOf, pick the highest version.
   */
  private _loadImprovedForks(): void {
    if (!existsSync(IMPROVED_DIR)) return;
    try {
      for (const originalId of readdirSync(IMPROVED_DIR)) {
        const baseDir = join(IMPROVED_DIR, originalId);
        const versions = readdirSync(baseDir)
          .filter((d) => d.startsWith("v"))
          .map((d) => ({ dir: d, num: parseInt(d.slice(1), 10) }))
          .filter((v) => !isNaN(v.num))
          .sort((a, b) => b.num - a.num);
        if (!versions.length) continue;
        const skillPath = join(baseDir, versions[0].dir, "skill.json");
        if (!existsSync(skillPath)) continue;
        const fork: Skill = JSON.parse(readFileSync(skillPath, "utf-8"));
        this.skills.set(fork.id, fork);
      }
    } catch (err) {
      console.warn("[skills] Fork load failed:", err);
    }
  }

  private save(): void {
    if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });
    writeFileSync(SKILLS_PATH, JSON.stringify(Array.from(this.skills.values()), null, 2));
    writeFileSync(INVOCATIONS_PATH, JSON.stringify(this.invocations.slice(-1000), null, 2));
  }

  // --------------------------------------------------------------------------
  // Existing API (signatures preserved for backward compat)
  // --------------------------------------------------------------------------

  createSkill(
    name: string,
    description: string,
    code: string,
    language: Skill["language"] = "python",
    triggerPatterns: string[] = [],
    createdBy = "agent-default",
    tags: string[] = []
  ): Skill {
    const skill: Skill = {
      id: `skill-${Date.now()}`,
      name,
      description,
      triggerPatterns,
      code,
      language,
      usageCount: 0,
      successRate: 0,
      createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      tags,
      source: "user",
    };
    this.skills.set(skill.id, skill);
    this.save();
    return skill;
  }

  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  searchSkills(query: string): Skill[] {
    const q = query.toLowerCase();
    return Array.from(this.skills.values()).filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
    );
  }

  matchSkill(userInput: string): Skill | undefined {
    const input = userInput.toLowerCase();
    for (const skill of this.skills.values()) {
      for (const pattern of skill.triggerPatterns) {
        if (input.includes(pattern.toLowerCase())) {
          return skill;
        }
      }
    }
    return undefined;
  }

  async invokeSkill(
    skillId: string,
    params: Record<string, unknown>,
    sessionId: string
  ): Promise<unknown> {
    const skill = this.skills.get(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);

    let success = false;
    let result: unknown;
    let error: string | undefined;

    // M6a: isolated runtimes — see ./runtime/run-{js,python}-skill.ts.
    // Params arrive via structured clone (JS) or stdin JSON (Python),
    // never shell-interpolated. Timeouts terminate cleanly. The runners
    // never throw; ok=false carries the error message back.
    if (skill.language === "python") {
      const r = await runPythonSkill({ code: skill.code, params });
      if (r.ok) {
        result = r.result;
        success = true;
      } else {
        error = r.error;
        result = error;
      }
    } else if (skill.language === "javascript" || skill.language === "typescript") {
      const r = await runJsSkill({ code: skill.code, params });
      if (r.ok) {
        result = r.result;
        success = true;
      } else {
        error = r.error;
        result = error;
      }
    } else {
      error = `unsupported skill language: ${skill.language}`;
      result = error;
    }

    skill.usageCount++;
    const inv: SkillInvocation = {
      skillId,
      sessionId,
      params,
      success,
      result,
      error,
      timestamp: new Date().toISOString(),
    };
    this.invocations.push(inv);

    const skillInvs = this.invocations.filter((i) => i.skillId === skillId);
    const successCount = skillInvs.filter((i) => i.success).length;
    skill.successRate = skillInvs.length > 0 ? successCount / skillInvs.length : 0;
    skill.updatedAt = new Date().toISOString();

    // Hermes-style failure-mode clustering: only update on failure.
    if (!success && error) {
      this._recordFailureMode(skill, error);
    }

    this.save();
    return { success, result, error };
  }

  /**
   * In-place improvement (legacy API). Prefer createImprovedFork() — it
   * preserves the original and keeps version history on disk.
   */
  improveSkill(skillId: string, improvedCode: string, reason: string): Skill | undefined {
    const skill = this.skills.get(skillId);
    if (!skill) return undefined;
    skill.code = improvedCode;
    skill.version++;
    skill.updatedAt = new Date().toISOString();
    skill.lastRefinedAt = new Date().toISOString();
    skill.tags = [...new Set([...skill.tags, "improved", reason])];
    this.save();
    return skill;
  }

  deleteSkill(skillId: string): boolean {
    const ok = this.skills.delete(skillId);
    if (ok) this.save();
    return ok;
  }

  getStats(): { totalSkills: number; totalInvocations: number; averageSuccessRate: number } {
    const skills = Array.from(this.skills.values());
    const totalSkills = skills.length;
    const totalInvocations = this.invocations.length;
    const averageSuccessRate =
      totalSkills > 0 ? skills.reduce((sum, s) => sum + s.successRate, 0) / totalSkills : 0;
    return { totalSkills, totalInvocations, averageSuccessRate };
  }

  // --------------------------------------------------------------------------
  // New: Hermes-style self-improvement
  // --------------------------------------------------------------------------

  /**
   * Identify skills that have hit their auto-improve threshold and haven't
   * been refined recently.
   */
  getCandidatesForImprovement(): ImprovementCandidate[] {
    const out: ImprovementCandidate[] = [];
    const now = Date.now();

    for (const skill of this.skills.values()) {
      const cfg = skill.autoImprove ?? DEFAULT_AUTO_IMPROVE;
      if (!cfg.enabled) continue;
      if (skill.usageCount < cfg.thresholdUses) continue;
      const failureRate = 1 - (skill.successRate ?? 0);
      if (failureRate < cfg.thresholdFailureRate) continue;
      if (!skill.failureModes?.length) continue;
      if (skill.lastRefinedAt) {
        const lastMs = new Date(skill.lastRefinedAt).getTime();
        if (now - lastMs < REFINEMENT_COOLDOWN_MS) continue;
      }
      const primary = [...skill.failureModes].sort((a, b) => b.count - a.count)[0];
      out.push({
        skill,
        primaryFailureMode: primary,
        reason: `${(failureRate * 100).toFixed(0)}% failure rate after ${skill.usageCount} uses; primary mode "${primary.signature}" (${primary.count}x)`,
      });
    }
    return out;
  }

  /**
   * Create an immutable fork under improved/<originalId>/v<N>/. The new
   * fork supersedes the original in runtime (highest version wins on next load).
   */
  createImprovedFork(skillId: string, improvedCode: string, reason: string): Skill | undefined {
    const original = this.skills.get(skillId);
    if (!original) return undefined;

    const forkVersion = (original.version ?? 1) + 1;
    const forkId = `${original.id}-improved-v${forkVersion}`;
    const fork: Skill = {
      ...original,
      id: forkId,
      code: improvedCode,
      version: forkVersion,
      forkOf: original.id,
      lastRefinedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Fresh telemetry for the fork so we can tell if it actually helps.
      usageCount: 0,
      successRate: 0,
      failureModes: [],
      tags: [...new Set([...original.tags, "improved"])],
      source: "agent-auto",
    };

    const forkDir = join(IMPROVED_DIR, original.id, `v${forkVersion}`);
    if (!existsSync(forkDir)) mkdirSync(forkDir, { recursive: true });
    writeFileSync(join(forkDir, "skill.json"), JSON.stringify(fork, null, 2));
    writeFileSync(join(forkDir, "reason.txt"), reason);

    this.skills.set(forkId, fork);
    this.save();
    return fork;
  }

  /**
   * Capture a successful novel task as a draft skill. Drafts are NOT loaded
   * into runtime — the user must promote them first.
   */
  createDraft(opts: {
    name: string;
    description: string;
    code: string;
    language: Skill["language"];
    triggerPatterns: string[];
    tags?: string[];
    reason: string;
  }): Skill {
    const id = `skill-draft-${Date.now()}`;
    const draft: Skill = {
      id,
      name: opts.name,
      description: opts.description,
      triggerPatterns: opts.triggerPatterns,
      code: opts.code,
      language: opts.language,
      usageCount: 0,
      successRate: 0,
      createdBy: "agent-auto",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      tags: opts.tags ?? [],
      source: "agent-auto",
    };
    const draftDir = join(DRAFTS_DIR, id);
    if (!existsSync(draftDir)) mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, "skill.json"), JSON.stringify(draft, null, 2));
    writeFileSync(join(draftDir, "reason.txt"), opts.reason);
    return draft;
  }

  listDrafts(): Skill[] {
    if (!existsSync(DRAFTS_DIR)) return [];
    const out: Skill[] = [];
    for (const id of readdirSync(DRAFTS_DIR)) {
      const p = join(DRAFTS_DIR, id, "skill.json");
      if (!existsSync(p)) continue;
      try {
        out.push(JSON.parse(readFileSync(p, "utf-8")));
      } catch {
        /* skip corrupt draft */
      }
    }
    return out;
  }

  /**
   * Move a draft into the active skill set. Returns the promoted skill
   * with its draft-id replaced by a stable id (drops the "-draft-" infix).
   */
  promoteDraft(draftId: string): Skill | undefined {
    const p = join(DRAFTS_DIR, draftId, "skill.json");
    if (!existsSync(p)) return undefined;
    const draft: Skill = JSON.parse(readFileSync(p, "utf-8"));
    const newId = draft.id.replace("-draft-", "-");
    const promoted: Skill = { ...draft, id: newId, updatedAt: new Date().toISOString() };
    this.skills.set(newId, promoted);
    this.save();
    return promoted;
  }

  // --------------------------------------------------------------------------
  // Private — failure-mode clustering
  // --------------------------------------------------------------------------

  private _recordFailureMode(skill: Skill, error: string): void {
    const sig = normalizeErrorSignature(error);
    skill.failureModes = skill.failureModes ?? [];
    let mode = skill.failureModes.find((m) => m.signature === sig);
    if (!mode) {
      mode = { signature: sig, count: 0, lastSeen: "", examples: [] };
      skill.failureModes.push(mode);
    }
    mode.count++;
    mode.lastSeen = new Date().toISOString();
    if (mode.examples.length < 3) mode.examples.push(error);
  }
}
