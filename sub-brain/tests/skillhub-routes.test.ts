import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

import Fastify, { type FastifyInstance } from "fastify";

import { SkillHubClient } from "../src/skills/skill-hub-client.js";
import { SkillManager, type Skill } from "../src/skills/skill-manager.js";
import { registerSkillhubRoutes, adaptHubItem } from "../src/server/skillhub-routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_REGISTRY = resolve(__dirname, "fixtures/skill-registry");

const WEBRAIN_DIR = join(homedir(), ".webrain");
const REGISTRIES_PATH = join(WEBRAIN_DIR, "registries.json");
const INSTALLED_DIR = join(WEBRAIN_DIR, "skills", "installed");
const IMPROVED_DIR = join(WEBRAIN_DIR, "skills", "improved");
const DRAFTS_DIR = join(WEBRAIN_DIR, "skills", "drafts");

const TEST_REGISTRY_NAME = "test-hub-registry";
const ECHO_ID = "test-skill-echo";
const GREET_ID = "test-skill-greet";

function snapshotRegistries(): string | null {
  if (!existsSync(REGISTRIES_PATH)) return null;
  return readFileSync(REGISTRIES_PATH, "utf-8");
}

function restoreRegistries(snapshot: string | null) {
  if (snapshot === null) {
    if (existsSync(REGISTRIES_PATH)) {
      try { rmSync(REGISTRIES_PATH, { force: true }); } catch {}
    }
  } else {
    if (!existsSync(WEBRAIN_DIR)) mkdirSync(WEBRAIN_DIR, { recursive: true });
    writeFileSync(REGISTRIES_PATH, snapshot);
  }
}

function wipeTestArtifacts() {
  for (const id of [ECHO_ID, GREET_ID]) {
    const dir = join(INSTALLED_DIR, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  for (const baseDir of [IMPROVED_DIR, DRAFTS_DIR]) {
    if (!existsSync(baseDir)) continue;
    try {
      const { readdirSync } = require("fs");
      for (const entry of readdirSync(baseDir)) {
        if (entry.startsWith("skill-test-") || entry.includes("draft-test")) {
          try { rmSync(join(baseDir, entry), { recursive: true, force: true }); } catch {}
        }
      }
    } catch {}
  }
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-test-route",
    name: "Route Test Skill",
    description: "fixture",
    triggerPatterns: [],
    code: "throw new Error('placeholder')",
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

describe("skillhub routes", () => {
  let snapshot: string | null = null;
  let app: FastifyInstance;
  let skillHubClient: SkillHubClient;
  let skillManager: SkillManager;

  beforeEach(async () => {
    snapshot = snapshotRegistries();
    if (!existsSync(WEBRAIN_DIR)) mkdirSync(WEBRAIN_DIR, { recursive: true });
    writeFileSync(
      REGISTRIES_PATH,
      JSON.stringify({
        registries: [
          {
            name: TEST_REGISTRY_NAME,
            url: "file://" + FIXTURE_REGISTRY,
            enabled: true,
            priority: 100,
          },
        ],
      }),
    );
    wipeTestArtifacts();

    skillHubClient = new SkillHubClient();
    skillManager = new SkillManager();

    app = Fastify();
    registerSkillhubRoutes(app, { skillHubClient, skillManager });
    await app.ready();
  });

  afterEach(async () => {
    wipeTestArtifacts();
    restoreRegistries(snapshot);
    await app.close();
  });

  // ---------- adapter ----------

  it("adaptHubItem flattens a search result for the frontend table", () => {
    const installed = new Set(["foo"]);
    const item = adaptHubItem(
      { id: "foo", name: "Foo", description: "d", version: "1.0", path: "foo/skill.json" },
      "my-reg",
      installed,
    );
    expect(item).toEqual({
      name: "Foo",
      slug: "foo",
      description: "d",
      version: "1.0",
      author: "my-reg",
      installed: true,
    });
  });

  // ---------- marketplace ----------

  it("GET /api/skillhub/list returns adapted items including installed=false", async () => {
    const res = await app.inject({ method: "GET", url: "/api/skillhub/list" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const slugs = body.skills.map((s: { slug: string }) => s.slug);
    expect(slugs).toContain(ECHO_ID);
    expect(slugs).toContain(GREET_ID);
    expect(body.skills[0].installed).toBe(false);
  });

  it("GET /api/skillhub/search filters by query", async () => {
    const res = await app.inject({ method: "GET", url: "/api/skillhub/search?q=greet" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.skills.some((s: { slug: string }) => s.slug === GREET_ID)).toBe(true);
    expect(body.skills.some((s: { slug: string }) => s.slug === ECHO_ID)).toBe(false);
  });

  it("POST /api/skillhub/install accepts slug or skillId", async () => {
    const r1 = await app.inject({
      method: "POST",
      url: "/api/skillhub/install",
      payload: { slug: ECHO_ID },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().ok).toBe(true);

    // Now uninstall and re-install with skillId field
    await app.inject({ method: "POST", url: "/api/skillhub/uninstall", payload: { slug: ECHO_ID } });
    const r2 = await app.inject({
      method: "POST",
      url: "/api/skillhub/install",
      payload: { skillId: ECHO_ID },
    });
    expect(r2.json().ok).toBe(true);
  });

  it("POST /api/skillhub/install rejects empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skillhub/install",
      payload: {},
    });
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toContain("Missing");
  });

  it("after install, GET /list reports installed=true for that slug", async () => {
    await app.inject({ method: "POST", url: "/api/skillhub/install", payload: { slug: ECHO_ID } });
    const res = await app.inject({ method: "GET", url: "/api/skillhub/list" });
    const echo = res.json().skills.find((s: { slug: string }) => s.slug === ECHO_ID);
    expect(echo.installed).toBe(true);
  });

  it("POST /api/skillhub/uninstall removes the install", async () => {
    await app.inject({ method: "POST", url: "/api/skillhub/install", payload: { slug: ECHO_ID } });
    const res = await app.inject({
      method: "POST",
      url: "/api/skillhub/uninstall",
      payload: { slug: ECHO_ID },
    });
    expect(res.json().ok).toBe(true);
  });

  it("GET /api/skillhub/installed returns currently installed manifests", async () => {
    await app.inject({ method: "POST", url: "/api/skillhub/install", payload: { slug: ECHO_ID } });
    const res = await app.inject({ method: "GET", url: "/api/skillhub/installed" });
    const ids = res.json().skills.map((s: { id: string }) => s.id);
    expect(ids).toContain(ECHO_ID);
  });

  // ---------- registries ----------

  it("GET /api/skillhub/registries returns configured registries", async () => {
    const res = await app.inject({ method: "GET", url: "/api/skillhub/registries" });
    const names = res.json().registries.map((r: { name: string }) => r.name);
    expect(names).toContain(TEST_REGISTRY_NAME);
  });

  it("POST /api/skillhub/registries adds a new registry", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skillhub/registries",
      payload: { name: "added", url: "https://example.com", enabled: true },
    });
    expect(res.json().ok).toBe(true);
    const listRes = await app.inject({ method: "GET", url: "/api/skillhub/registries" });
    expect(
      listRes.json().registries.some((r: { name: string }) => r.name === "added"),
    ).toBe(true);
  });

  it("POST /api/skillhub/registries rejects without name/url", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skillhub/registries",
      payload: { enabled: true },
    });
    expect(res.json().ok).toBe(false);
  });

  it("DELETE /api/skillhub/registries/:name removes it", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/skillhub/registries/${TEST_REGISTRY_NAME}`,
    });
    expect(res.json().ok).toBe(true);
  });

  it("POST /api/skillhub/refresh returns refreshed list", async () => {
    const res = await app.inject({ method: "POST", url: "/api/skillhub/refresh", payload: {} });
    const body = res.json();
    expect(body.refreshed).toContain(TEST_REGISTRY_NAME);
  });

  // ---------- self-improvement ----------

  it("GET /api/skillhub/candidates returns improvement candidates", async () => {
    const skill = makeSkill({
      id: "skill-test-cand",
      usageCount: 25,
      successRate: 0.3,
      failureModes: [
        { signature: "X", count: 8, lastSeen: new Date().toISOString(), examples: ["X"] },
      ],
    });
    (skillManager as any).skills.set(skill.id, skill);

    const res = await app.inject({ method: "GET", url: "/api/skillhub/candidates" });
    const ours = res
      .json()
      .candidates.filter((c: { skill: { id: string } }) => c.skill.id === skill.id);
    expect(ours).toHaveLength(1);
  });

  it("POST /api/skillhub/improve creates a fork", async () => {
    const skill = makeSkill({ id: "skill-test-improve" });
    (skillManager as any).skills.set(skill.id, skill);

    const res = await app.inject({
      method: "POST",
      url: "/api/skillhub/improve",
      payload: { skillId: skill.id, code: "improved", reason: "fix" },
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.fork.id).toBe("skill-test-improve-improved-v2");
  });

  it("POST /api/skillhub/improve fails when fields missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skillhub/improve",
      payload: { skillId: "x" },
    });
    expect(res.json().ok).toBe(false);
  });

  // ---------- drafts ----------

  it("GET /api/skillhub/drafts + POST promote round-trip", async () => {
    const draft = skillManager.createDraft({
      name: "Draft Test",
      description: "",
      code: "x",
      language: "javascript",
      triggerPatterns: [],
      reason: "novel task",
    });

    const list = await app.inject({ method: "GET", url: "/api/skillhub/drafts" });
    const draftIds = list.json().drafts.map((d: { id: string }) => d.id);
    expect(draftIds).toContain(draft.id);

    const promote = await app.inject({
      method: "POST",
      url: `/api/skillhub/drafts/${draft.id}/promote`,
    });
    const body = promote.json();
    expect(body.ok).toBe(true);
    expect(body.skill.id).not.toContain("-draft-");
  });

  it("POST promote fails for unknown id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skillhub/drafts/nonexistent/promote",
    });
    expect(res.json().ok).toBe(false);
  });
});
