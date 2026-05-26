/**
 * HTTP routes for the Skill Hub.
 *
 * Exposes SkillHubClient (marketplace install/search) and the SkillManager
 * self-improvement surface (candidates / improve / drafts / promote) over
 * `/api/skillhub/*`.
 *
 * Frontend's existing `api/skillhub.ts` expects a flat `{name, slug, description,
 * version, author, installed}` shape — see _adaptHubItem.
 */

import type { FastifyInstance } from "fastify";

import type { SkillHubClient } from "../skills/skill-hub-client.js";
import type { SkillManager } from "../skills/skill-manager.js";
import type { RegistrySkillEntry } from "../skills/skill-hub-types.js";

export interface SkillhubRouteDeps {
  skillHubClient: SkillHubClient;
  skillManager: SkillManager;
}

/**
 * Flatten the richer SearchResult into the shape the frontend table renders.
 * Frontend column: name / slug / description / version / author / installed.
 * - slug ← entry.id (canonical)
 * - author ← registry.name (registries don't currently track real authors)
 */
export function adaptHubItem(
  entry: RegistrySkillEntry,
  registryName: string,
  installedIds: Set<string>,
) {
  return {
    name: entry.name,
    slug: entry.id,
    description: entry.description ?? "",
    version: entry.version,
    author: registryName,
    installed: installedIds.has(entry.id),
  };
}

export function registerSkillhubRoutes(app: FastifyInstance, deps: SkillhubRouteDeps): void {
  const { skillHubClient, skillManager } = deps;

  // ---------- marketplace ----------

  app.get("/api/skillhub/list", async () => {
    await skillHubClient.refreshIndex().catch(() => undefined);
    const installedIds = new Set(skillHubClient.listInstalled().map((s) => s.id));
    const all = skillHubClient.search("");
    return {
      skills: all.map((r) => adaptHubItem(r.entry, r.registry.name, installedIds)),
    };
  });

  app.get("/api/skillhub/search", async (request) => {
    const { q } = request.query as { q?: string };
    await skillHubClient.refreshIndex().catch(() => undefined);
    const installedIds = new Set(skillHubClient.listInstalled().map((s) => s.id));
    const results = skillHubClient.search(String(q ?? ""));
    return {
      skills: results.map((r) => adaptHubItem(r.entry, r.registry.name, installedIds)),
    };
  });

  app.post("/api/skillhub/install", async (request) => {
    const body = (request.body as { slug?: string; skillId?: string; registry?: string }) ?? {};
    // Accept both `slug` (frontend convention) and `skillId` (canonical).
    const id = String(body.skillId ?? body.slug ?? "");
    if (!id) return { ok: false, error: "Missing skillId/slug" };
    const res = await skillHubClient.install(id, body.registry);
    // Tell the in-process SkillManager about the new skill so
    // /api/skills/<id>/invoke works immediately. Without this, the
    // hub-installed skill is on disk but the in-memory registry is
    // stale until the next sub-brain restart.
    if (res.ok) skillManager.reloadInstalledHubSkills();
    return res;
  });

  app.post("/api/skillhub/uninstall", async (request) => {
    const body = (request.body as { slug?: string; skillId?: string }) ?? {};
    const id = String(body.skillId ?? body.slug ?? "");
    if (!id) return { ok: false, error: "Missing skillId/slug" };
    const res = await skillHubClient.uninstall(id);
    // Mirror install: drop the in-memory copy so the user-visible state
    // matches disk immediately.
    if (res.ok) skillManager.reloadInstalledHubSkills();
    return res;
  });

  app.get("/api/skillhub/installed", async () => ({
    skills: skillHubClient.listInstalled(),
  }));

  // ---------- registries CRUD ----------

  app.get("/api/skillhub/registries", async () => ({
    registries: skillHubClient.listRegistries(),
  }));

  app.post("/api/skillhub/registries", async (request) => {
    const body = (request.body as {
      name?: string;
      url?: string;
      enabled?: boolean;
      priority?: number;
    }) ?? {};
    if (!body.name || !body.url) return { ok: false, error: "name and url required" };
    return skillHubClient.addRegistry({
      name: String(body.name),
      url: String(body.url),
      enabled: body.enabled !== false,
      priority: typeof body.priority === "number" ? body.priority : undefined,
    });
  });

  app.delete("/api/skillhub/registries/:name", async (request) => {
    const { name } = request.params as { name: string };
    return skillHubClient.removeRegistry(String(name));
  });

  app.post("/api/skillhub/refresh", async (request) => {
    const body = (request.body as { name?: string }) ?? {};
    return skillHubClient.refreshIndex(body.name);
  });

  // ---------- self-improvement ----------

  app.get("/api/skillhub/candidates", async () => ({
    candidates: skillManager.getCandidatesForImprovement(),
  }));

  app.post("/api/skillhub/improve", async (request) => {
    const body = (request.body as { skillId?: string; code?: string; reason?: string }) ?? {};
    if (!body.skillId || !body.code) return { ok: false, error: "skillId and code required" };
    const fork = skillManager.createImprovedFork(
      String(body.skillId),
      String(body.code),
      String(body.reason ?? "manual"),
    );
    return fork ? { ok: true, fork } : { ok: false, error: `Skill not found: ${body.skillId}` };
  });

  // ---------- drafts ----------

  app.post("/api/skillhub/drafts", async (request) => {
    const body = (request.body as {
      name?: string;
      description?: string;
      code?: string;
      language?: string;
      triggerPatterns?: string[];
      tags?: string[];
      reason?: string;
    }) ?? {};
    if (!body.name || !body.code) {
      return { ok: false, error: "name and code required" };
    }
    const draft = skillManager.createDraft({
      name: String(body.name),
      description: String(body.description ?? ""),
      code: String(body.code),
      language: (body.language as any) ?? "javascript",
      triggerPatterns: body.triggerPatterns ?? [],
      tags: body.tags ?? [],
      reason: String(body.reason ?? "manual"),
    });
    return { ok: true, skill: draft };
  });

  app.get("/api/skillhub/drafts", async () => ({
    drafts: skillManager.listDrafts(),
  }));

  app.post("/api/skillhub/drafts/:id/promote", async (request) => {
    const { id } = request.params as { id: string };
    const promoted = skillManager.promoteDraft(String(id));
    return promoted
      ? { ok: true, skill: promoted }
      : { ok: false, error: `Draft not found: ${id}` };
  });
}
