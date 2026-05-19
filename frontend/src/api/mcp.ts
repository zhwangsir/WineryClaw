import { api } from "./client";

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

export const mcpApi = {
  listServers: () => api.get<{ servers: McpServer[] }>("/api/mcp/servers").then((r) => r.servers),
  listTools: () => api.get<{ tools: McpTool[] }>("/api/mcp/tools").then((r) => r.tools),
  connect: (data: { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }) =>
    api.post("/api/mcp/connect", data),
  callTool: (server: string, tool: string, params?: Record<string, unknown>) =>
    api.post(`/api/mcp/${server}/tool`, { tool, params }),
};
