/**
 * Configuration routes — model endpoints + layered workspace/agent config.
 *
 *   GET    /config/model                     — fetch current model config
 *   POST   /config/model                     — save (single or multi-endpoint), notify main-brain to reload
 *   POST   /config/model/detect              — auto-detect available endpoints
 *   POST   /config/model/reset               — reset to defaults
 *
 *   GET    /config/global                    — global layered settings
 *   POST   /config/global                    — update global
 *   GET    /config/workspaces                — list workspaces
 *   GET    /config/workspace/:id             — fetch one
 *   POST   /config/workspace                 — create
 *   DELETE /config/workspace/:id             — delete
 *   GET    /config/workspace/:id/agents      — list agents in a workspace
 *   GET    /config/agent/:wid/:aid           — fetch one agent's layered config
 *   POST   /config/agent                     — add an agent to a workspace
 */

import type { FastifyInstance } from "fastify";
import type { ModelConfigManager } from "../config/model-config.js";
import type { LayeredConfigManager } from "../config/layered-config.js";

export interface ConfigRouteDeps {
  modelConfig: ModelConfigManager;
  layeredConfig: LayeredConfigManager;
  mainBrainUrl: string;
  /** Returns extra axios options (e.g. socketPath for UDS) for inter-brain calls. */
  mainBrainAxiosConfig: () => Record<string, unknown>;
}

interface ModelEndpointInput {
  name?: string;
  baseUrl?: string;
  base_url?: string;
  modelId?: string;
  model_id?: string;
  apiKey?: string;
  api_key?: string;
  priority?: number;
  timeout?: number;
}

interface SaveModelBody {
  endpoints?: ModelEndpointInput[];
  baseUrl?: string;
  modelId?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}

interface AddAgentBody {
  agent?: unknown;
  workspaceId?: string;
}

export function registerConfigRoutes(app: FastifyInstance, deps: ConfigRouteDeps): void {
  // ---- Model config ----

  app.get("/config/model", async () => deps.modelConfig.get());

  app.post("/config/model", async (request) => {
    const body = (request.body as SaveModelBody) ?? {};

    let saved;
    if (Array.isArray(body.endpoints)) {
      // Multi-endpoint config — normalize each endpoint's keys (camel/snake).
      saved = deps.modelConfig.save({
        endpoints: body.endpoints.map((ep) => ({
          name: ep.name || "unnamed",
          baseUrl: ep.baseUrl || ep.base_url || "",
          modelId: ep.modelId || ep.model_id || "default",
          apiKey: ep.apiKey || ep.api_key,
          priority: ep.priority ?? 0,
          timeout: ep.timeout ?? 120,
        })),
        temperature: body.temperature,
        maxTokens: body.maxTokens,
      });
    } else {
      // Single endpoint shorthand
      saved = deps.modelConfig.save({
        baseUrl: body.baseUrl,
        modelId: body.modelId || body.model,
        apiKey: body.apiKey,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
      });
    }

    // Notify main-brain to reload — best-effort; do not fail the save if main-brain is down.
    try {
      const axios = (await import("axios")).default;
      await axios.post(
        `${deps.mainBrainUrl}/config/reload`,
        {},
        { timeout: 5000, ...deps.mainBrainAxiosConfig() },
      );
    } catch (err: unknown) {
      // Main brain may not be available; this is non-fatal.
      app.log.warn({ err }, "[config] failed to notify main-brain reload");
    }

    return { ok: true, config: saved };
  });

  app.post("/config/model/detect", async () => deps.modelConfig.detect());
  app.post("/config/model/reset", async () => ({ ok: true, config: deps.modelConfig.reset() }));

  // ---- Layered config ----

  app.get("/config/global", async () => deps.layeredConfig.getGlobal());

  app.post("/config/global", async (request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (request.body as any) ?? {};
    return { ok: true, config: deps.layeredConfig.updateGlobal(body) };
  });

  app.get("/config/workspaces", async () => ({
    ok: true,
    workspaces: deps.layeredConfig.listWorkspaces(),
  }));

  app.get("/config/workspace/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { ok: true, workspace: deps.layeredConfig.getWorkspace(id) };
  });

  app.post("/config/workspace", async (request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (request.body as any) ?? {};
    return { ok: true, workspace: deps.layeredConfig.addWorkspace(body) };
  });

  app.delete("/config/workspace/:id", async (request) => {
    const { id } = request.params as { id: string };
    const ok = deps.layeredConfig.deleteWorkspace(id);
    return { ok };
  });

  app.get("/config/workspace/:id/agents", async (request) => {
    const { id } = request.params as { id: string };
    return { ok: true, agents: deps.layeredConfig.listAgents(id) };
  });

  app.get("/config/agent/:wid/:aid", async (request) => {
    const { wid, aid } = request.params as { wid: string; aid: string };
    return { ok: true, agent: deps.layeredConfig.getAgent(aid, wid) };
  });

  app.post("/config/agent", async (request) => {
    const body = (request.body as AddAgentBody) ?? {};
    return {
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: deps.layeredConfig.addAgent(body.agent as any, body.workspaceId),
    };
  });
}
