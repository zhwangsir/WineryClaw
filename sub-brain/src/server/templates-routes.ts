/**
 * Agent template routes.
 *
 *   GET    /templates                       — list (optional ?category, ?tag)
 *   GET    /templates/categories            — distinct categories
 *   GET    /templates/tags                  — distinct tags
 *   GET    /templates/:id                   — fetch one
 *   POST   /templates                       — create
 *   DELETE /templates/:id                   — delete
 *   POST   /templates/:id/instantiate       — render template → create agent
 *
 * NOTE: /templates/categories and /templates/tags must register BEFORE
 * /templates/:id so the literal paths win.
 */

import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agent/agent-manager.js";

export interface TemplatesRouteDeps {
  agentManager: AgentManager;
}

interface InstantiateBody {
  name?: string;
  workspaceId?: string;
  owner?: string;
  variables?: Record<string, unknown>;
}

export function registerTemplatesRoutes(
  app: FastifyInstance,
  deps: TemplatesRouteDeps,
): void {
  app.get("/templates", async (request) => {
    const { category, tag } = request.query as { category?: string; tag?: string };
    return { templates: deps.agentManager.listTemplates(category, tag) };
  });

  // Literal paths before /templates/:id so they don't collapse into the param route.
  app.get("/templates/categories", async () => ({
    categories: deps.agentManager.getTemplateCategories(),
  }));
  app.get("/templates/tags", async () => ({
    tags: deps.agentManager.getTemplateTags(),
  }));

  app.get("/templates/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { template: deps.agentManager.getTemplate(id) };
  });

  app.post("/templates", async (request) => {
    // Template shape is open-ended (agentManager validates).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tpl = (request.body as any) ?? {};
    const created = deps.agentManager.createTemplate(tpl);
    return { ok: true, template: created };
  });

  app.delete("/templates/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { ok: deps.agentManager.deleteTemplate(id) };
  });

  app.post("/templates/:id/instantiate", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as InstantiateBody) ?? {};
    const result = deps.agentManager.instantiateTemplate(id, {
      name: body.name,
      workspaceId: body.workspaceId,
      owner: body.owner,
      variables: body.variables,
    });
    if (result.ok && result.card) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = deps.agentManager.createAgent(result.card as any);
      return { ok: true, agent, fromTemplate: id };
    }
    return { ok: false, error: result.error };
  });
}
