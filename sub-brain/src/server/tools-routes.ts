/**
 * Tool execution & registry routes.
 *
 *   POST /tools/execute          — run a named tool (catches throws → 500)
 *   GET  /tools                  — list registered tools
 *   GET  /tools/list             — compat alias for /tools
 *   POST /tools/enable           — enable a tool by name
 *   POST /tools/disable          — disable a tool by name
 *   POST /tools/global-toggle    — flip the global enabled flag
 */

import type { FastifyInstance } from "fastify";
import type { ToolExecutor } from "../tools/tool-executor.js";

export interface ToolsRouteDeps {
  toolExecutor: ToolExecutor;
}

interface ExecuteBody {
  tool?: string;
  params?: Record<string, unknown>;
}

interface NameBody {
  tool?: string;
}

interface GlobalToggleBody {
  enabled?: boolean;
}

export function registerToolsRoutes(app: FastifyInstance, deps: ToolsRouteDeps): void {
  app.post("/tools/execute", async (request, reply) => {
    try {
      const body = (request.body as ExecuteBody) ?? {};
      return await deps.toolExecutor.execute(String(body.tool ?? ""), body.params ?? {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Tool execution failed";
      return reply.code(500).send({ ok: false, error: msg });
    }
  });

  const listHandler = async () => ({ tools: deps.toolExecutor.listTools() });
  app.get("/tools", listHandler);
  app.get("/tools/list", listHandler); // compat

  app.post("/tools/enable", async (request) => {
    const body = (request.body as NameBody) ?? {};
    deps.toolExecutor.enableTool(String(body.tool ?? ""));
    return { ok: true };
  });

  app.post("/tools/disable", async (request) => {
    const body = (request.body as NameBody) ?? {};
    deps.toolExecutor.disableTool(String(body.tool ?? ""));
    return { ok: true };
  });

  app.post("/tools/global-toggle", async (request) => {
    const body = (request.body as GlobalToggleBody) ?? {};
    const enabled = Boolean(body.enabled);
    deps.toolExecutor.setGlobalEnabled(enabled);
    return { ok: true, globalEnabled: enabled };
  });
}
