import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerSkillsRoutes } from "../src/server/skills-routes.js";
import type { Skill, SkillManager } from "../src/skills/skill-manager.js";

function makeFakeSkillManager() {
  const skills = new Map<string, Skill>();

  const make = (overrides: Partial<Skill>): Skill => ({
    id: `s-${skills.size + 1}`,
    name: "",
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
  });

  const mgr = {
    listSkills: vi.fn(() => Array.from(skills.values())),
    getSkill: vi.fn((id: string) => skills.get(id)),
    createSkill: vi.fn((name: string, description: string, code: string, language?: Skill["language"], triggerPatterns?: string[], _createdBy?: string, tags?: string[]) => {
      const s = make({ name, description, code, language: language ?? "javascript", triggerPatterns: triggerPatterns ?? [], tags: tags ?? [] });
      skills.set(s.id, s);
      return s;
    }),
    invokeSkill: vi.fn(async (id: string, _params: Record<string, unknown>, _sessionId: string) => {
      const s = skills.get(id);
      if (!s) throw new Error(`Skill not found: ${id}`);
      if (s.code === "throw") throw new Error("intentional");
      return { success: true, result: "ok" };
    }),
    improveSkill: vi.fn((id: string, code: string, _reason: string) => {
      const s = skills.get(id);
      if (!s) return undefined;
      s.code = code;
      s.version += 1;
      return s;
    }),
    deleteSkill: vi.fn((id: string) => skills.delete(id)),
    getStats: vi.fn(() => ({
      totalSkills: skills.size,
      totalInvocations: 0,
      averageSuccessRate: 0,
    })),
  };

  return { mgr, skills };
}

describe("skills routes", () => {
  let app: FastifyInstance;
  let mgr: ReturnType<typeof makeFakeSkillManager>["mgr"];

  beforeEach(async () => {
    const fake = makeFakeSkillManager();
    mgr = fake.mgr;
    app = Fastify();
    registerSkillsRoutes(app, { skillManager: mgr as unknown as SkillManager });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /skills returns empty list initially", async () => {
    const res = await app.inject({ method: "GET", url: "/skills" });
    expect(res.json()).toEqual({ skills: [] });
  });

  it("POST /skills creates with full payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/skills",
      payload: {
        name: "test",
        description: "desc",
        code: "console.log(1)",
        language: "javascript",
        triggerPatterns: ["foo"],
        tags: ["x"],
      },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().skill.name).toBe("test");
    expect(mgr.createSkill).toHaveBeenCalledWith(
      "test",
      "desc",
      "console.log(1)",
      "javascript",
      ["foo"],
      undefined,
      ["x"],
    );
  });

  it("POST /skills handles empty body without crashing", async () => {
    const res = await app.inject({ method: "POST", url: "/skills", payload: {} });
    expect(res.json().ok).toBe(true);
  });

  it("GET /skills/stats returns aggregate (and beats /:id route order)", async () => {
    const res = await app.inject({ method: "GET", url: "/skills/stats" });
    expect(res.statusCode).toBe(200);
    // Returned shape: stats fields, not {ok, skill} (which is /skills/:id)
    expect(res.json()).toHaveProperty("totalSkills");
    expect(res.json()).not.toHaveProperty("skill");
  });

  it("GET /skills/:id returns the skill if present", async () => {
    await app.inject({
      method: "POST",
      url: "/skills",
      payload: { name: "n", description: "d", code: "c" },
    });
    const res = await app.inject({ method: "GET", url: "/skills/s-1" });
    expect(res.json().ok).toBe(true);
    expect(res.json().skill.name).toBe("n");
  });

  it("GET /skills/:id returns ok=false for missing", async () => {
    const res = await app.inject({ method: "GET", url: "/skills/nonexistent" });
    expect(res.json().ok).toBe(false);
  });

  it("POST /skills/:id/invoke returns ok=true on success", async () => {
    await app.inject({
      method: "POST",
      url: "/skills",
      payload: { name: "n", description: "d", code: "c" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/skills/s-1/invoke",
      payload: { params: { x: 1 }, session_id: "sess" },
    });
    expect(res.json().ok).toBe(true);
    expect(mgr.invokeSkill).toHaveBeenCalledWith("s-1", { x: 1 }, "sess");
  });

  it("POST /skills/:id/invoke wraps thrown errors as ok=false", async () => {
    await app.inject({
      method: "POST",
      url: "/skills",
      payload: { name: "x", description: "d", code: "throw" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/skills/s-1/invoke",
      payload: { params: {} },
    });
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toContain("intentional");
  });

  it("POST /skills/:id/invoke defaults params={} and session=default", async () => {
    await app.inject({
      method: "POST",
      url: "/skills",
      payload: { name: "n", description: "d", code: "c" },
    });
    await app.inject({ method: "POST", url: "/skills/s-1/invoke", payload: {} });
    expect(mgr.invokeSkill).toHaveBeenCalledWith("s-1", {}, "default");
  });

  it("PUT /skills/:id updates fields and bumps version via improveSkill", async () => {
    await app.inject({
      method: "POST",
      url: "/skills",
      payload: { name: "old", description: "od", code: "oc" },
    });
    const res = await app.inject({
      method: "PUT",
      url: "/skills/s-1",
      payload: {
        name: "new",
        description: "nd",
        code: "nc",
        language: "python",
        triggerPatterns: ["t"],
        tags: ["a"],
      },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().skill.name).toBe("new");
    expect(res.json().skill.description).toBe("nd");
    expect(res.json().skill.code).toBe("nc");
    expect(res.json().skill.language).toBe("python");
    expect(res.json().skill.version).toBe(2);
  });

  it("PUT /skills/:id returns ok=false for unknown id", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/skills/unknown",
      payload: { code: "x" },
    });
    expect(res.json()).toEqual({ ok: false, error: "Skill not found" });
  });

  it("DELETE /skills/:id removes the skill", async () => {
    await app.inject({
      method: "POST",
      url: "/skills",
      payload: { name: "n", description: "d", code: "c" },
    });
    const res = await app.inject({ method: "DELETE", url: "/skills/s-1" });
    expect(res.json()).toEqual({ ok: true, deleted: true });
  });

  it("DELETE /skills/:id returns ok=false for unknown id", async () => {
    const res = await app.inject({ method: "DELETE", url: "/skills/nope" });
    expect(res.json()).toEqual({ ok: false, deleted: false });
  });
});
