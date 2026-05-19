/**
 * Skills CRUD + invocation routes (the "local user skills" surface).
 *
 *   GET    /skills                  — list all skills
 *   POST   /skills                  — create a new skill
 *   GET    /skills/:id              — fetch one skill
 *   POST   /skills/:id/invoke       — run a skill with params
 *   PUT    /skills/:id              — update metadata + bump version
 *   DELETE /skills/:id              — remove
 *   GET    /skills/stats            — aggregate stats
 *
 * NOTE: /skills/stats must register AFTER /skills/:id to avoid path-param
 * collision; we register them in that order below.
 */

import type { FastifyInstance } from "fastify";
import type { Skill, SkillManager } from "../skills/skill-manager.js";

export interface SkillsRouteDeps {
  skillManager: SkillManager;
}

interface CreateSkillBody {
  name?: string;
  description?: string;
  code?: string;
  language?: Skill["language"];
  triggerPatterns?: string[];
  tags?: string[];
}

interface InvokeBody {
  params?: Record<string, unknown>;
  session_id?: string;
}

interface UpdateSkillBody {
  name?: string;
  description?: string;
  code?: string;
  language?: Skill["language"];
  triggerPatterns?: string[];
  tags?: string[];
}

export function registerSkillsRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  app.get("/skills", async () => ({ skills: deps.skillManager.listSkills() }));

  app.post("/skills", async (request) => {
    const body = (request.body as CreateSkillBody) ?? {};
    const skill = deps.skillManager.createSkill(
      String(body.name ?? ""),
      String(body.description ?? ""),
      String(body.code ?? ""),
      body.language,
      body.triggerPatterns,
      undefined,
      body.tags,
    );
    return { ok: true, skill };
  });

  // /skills/stats must come BEFORE /skills/:id so the literal beats the param.
  app.get("/skills/stats", async () => deps.skillManager.getStats());

  app.get("/skills/:id", async (request) => {
    const { id } = request.params as { id: string };
    const skill = deps.skillManager.getSkill(id);
    return { ok: !!skill, skill };
  });

  app.post("/skills/:id/invoke", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as InvokeBody) ?? {};
    try {
      const result = await deps.skillManager.invokeSkill(
        id,
        body.params ?? {},
        body.session_id ?? "default",
      );
      return { ok: true, result };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  app.put("/skills/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as UpdateSkillBody) ?? {};
    const skill = deps.skillManager.improveSkill(
      id,
      String(body.code ?? ""),
      "manual-update",
    );
    if (!skill) return { ok: false, error: "Skill not found" };
    if (body.name) skill.name = body.name;
    if (body.description) skill.description = body.description;
    if (body.language) skill.language = body.language;
    if (body.triggerPatterns) skill.triggerPatterns = body.triggerPatterns;
    if (body.tags) skill.tags = body.tags;
    skill.updatedAt = new Date().toISOString();
    return { ok: true, skill };
  });

  app.delete("/skills/:id", async (request) => {
    const { id } = request.params as { id: string };
    const ok = deps.skillManager.deleteSkill(id);
    return { ok, deleted: ok };
  });
}
