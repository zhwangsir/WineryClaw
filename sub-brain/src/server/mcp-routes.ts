/**
 * MCP (Model Context Protocol) routes.
 *
 *   POST /mcp/connect          — connect to a new MCP server
 *   GET  /mcp/servers          — list connected servers
 *   GET  /mcp/tools            — list tools exposed by all servers
 *   POST /mcp/:server/tool     — invoke a tool on one server
 */

import type { FastifyInstance } from "fastify";
import type { MCPClient } from "../mcp/mcp-client.js";

export interface MCPRouteDeps {
  mcpClient: MCPClient;
}

interface ToolCallBody {
  tool?: string;
  params?: Record<string, unknown>;
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
}
