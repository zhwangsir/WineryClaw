/**
 * MCP (Model Context Protocol) routes.
 *
 *   POST /mcp/connect          — connect to a new MCP server
 *   GET  /mcp/servers          — list connected servers
 *   GET  /mcp/tools            — list tools exposed by all servers
 *   POST /mcp/:server/tool     — invoke a tool on one server
 *   GET  /mcp/catalog          — list builtin recommended MCP servers
 *   POST /mcp/install/:id      — install a builtin server by catalog id
 */

import type { FastifyInstance } from "fastify";
import type { MCPClient } from "../mcp/mcp-client.js";
import { BUILTIN_MCP_CATALOG } from "../mcp/builtin-catalog.js";

export interface MCPRouteDeps {
  mcpClient: MCPClient;
}

interface ToolCallBody {
  tool?: string;
  params?: Record<string, unknown>;
}

interface InstallBody {
  /** Optional env vars (e.g. API keys) the user supplies for this server. */
  env?: Record<string, string>;
  /** Optional path/arg substitution for catalog entries that need one. */
  pathArg?: string;
}

export function registerMCPRoutes(app: FastifyInstance, deps: MCPRouteDeps): void {
  app.post("/mcp/connect", async (request) => {
    // Pass-through to MCPClient.connectServer — it owns its own param shape.
    return deps.mcpClient.connectServer(request.body as Parameters<MCPClient["connectServer"]>[0]);
  });

  app.get("/mcp/servers", async () => ({
    servers: deps.mcpClient.listServers(),
  }));

  app.get("/mcp/tools", async () => ({
    tools: deps.mcpClient.listTools(),
  }));

  app.post("/mcp/:server/tool", async (request) => {
    const { server } = request.params as { server: string };
    const body = (request.body as ToolCallBody) ?? {};
    try {
      const result = await deps.mcpClient.callTool(
        String(server),
        String(body.tool ?? ""),
        body.params ?? {},
      );
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  // Builtin catalog: recommended MCP servers the user can install with one click.
  app.get("/mcp/catalog", async () => ({
    catalog: BUILTIN_MCP_CATALOG,
    count: BUILTIN_MCP_CATALOG.length,
  }));

  // One-click install from catalog. Substitutes ${VAR} placeholders in
  // args with values from request.body.env / pathArg.
  app.post("/mcp/install/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as InstallBody) ?? {};
    const entry = BUILTIN_MCP_CATALOG.find((e) => e.id === id);
    if (!entry) return { ok: false, error: `Unknown catalog id: ${id}` };

    const env = { ...(body.env ?? {}) };
    // Check required env vars are present
    if (entry.requiredEnv) {
      const missing = entry.requiredEnv.filter((k) => !env[k]);
      if (missing.length > 0) {
        return { ok: false, error: `Missing required env: ${missing.join(", ")}` };
      }
    }
    // Substitute ${VAR} in args. Also support ${HOME} via process.env.
    const args = entry.args.map((a) =>
      a.replace(/\$\{([^}]+)\}/g, (_, name) => {
        if (body.pathArg && (name === "HOME" || name === "POSTGRES_URL" || name === "SQLITE_DB_PATH")) {
          return body.pathArg;
        }
        return env[name] ?? process.env[name] ?? "";
      }),
    );

    return deps.mcpClient.connectServer({
      id: entry.id,
      name: entry.name,
      command: entry.command,
      args,
      env,
      type: entry.type,
    });
  });
}
