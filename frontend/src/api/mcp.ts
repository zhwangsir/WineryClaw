import { api } from "./client";

// ---------------------------------------------------------------------------
// MCP client side — webrain consuming external MCP servers (existing)
// ---------------------------------------------------------------------------

export interface McpServer {
  name: string;
  url?: string;
  connected: boolean;
  tools?: string[];
}

export interface McpTool {
  name: string;
  description?: string;
  server?: string;
  schema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MCP server side — webrain exposing itself as an MCP server (M4b)
// ---------------------------------------------------------------------------

export interface MCPExposedToolSummary {
  name: string;
  description: string;
  /** M4b.1: "read" (open) or "write" (requires bearer auth). */
  scope?: "read" | "write";
}

export interface MCPSelfServerInfo {
  ok: boolean;
  server: { name: string; version: string };
  transport: string;
  endpoint: string;
  /** M4b.1: when true, write-scope tools need Authorization: Bearer <token>. */
  auth_required_for_write?: boolean;
  /** M4b.1: true when the server resolved a token from env/file/generated. */
  token_configured?: boolean;
  tool_count: number;
  tools: MCPExposedToolSummary[];
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: "files" | "dev" | "data" | "web" | "ai" | "system";
  command: string;
  args: string[];
  type: "stdio";
  requiredEnv?: string[];
  pathArgHint?: string;
  sizeEstimateMb?: number;
  homepage?: string;
}

export const mcpApi = {
  // Client-side (webrain as consumer)
  listServers: () => api.get<{ servers: McpServer[] }>("/api/mcp/servers").then((r) => r.servers),
  listTools: () => api.get<{ tools: McpTool[] }>("/api/mcp/tools").then((r) => r.tools),
  connect: (data: { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }) =>
    api.post("/api/mcp/connect", data),
  callTool: (server: string, tool: string, params?: Record<string, unknown>) =>
    api.post(`/api/mcp/${server}/tool`, { tool, params }),

  // Builtin catalog (v2.8) — recommended MCP servers with one-click install.
  listCatalog: () => api.get<{ catalog: McpCatalogEntry[]; count: number }>("/api/mcp/catalog").then((r) => r.catalog),
  installFromCatalog: (id: string, body: { env?: Record<string, string>; pathArg?: string }) =>
    api.post<{ ok: boolean; error?: string; tools?: string[] }>(`/api/mcp/install/${id}`, body),

  // Server-side (webrain as provider, M4b)
  selfInfo: () => api.get<MCPSelfServerInfo>("/brain/mcp/info"),
};
