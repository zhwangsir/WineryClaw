import { create } from "zustand";
import { message } from "antd";
import { mcpApi } from "../api/mcp";
import type { McpServer, McpTool } from "../api/mcp";

interface McpState {
  servers: McpServer[];
  tools: McpTool[];
  loading: boolean;

  fetchServers: () => Promise<void>;
  fetchTools: () => Promise<void>;
  connect: (data: { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }) => Promise<void>;
  callTool: (server: string, tool: string, params?: Record<string, unknown>) => Promise<unknown>;
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  tools: [],
  loading: false,

  fetchServers: async () => {
    set({ loading: true });
    try {
      const servers = await mcpApi.listServers();
      set({ servers, loading: false });
    } catch (e: any) {
      set({ loading: false });
      message.error(e.message || "获取 MCP 服务器失败");
    }
  },

  fetchTools: async () => {
    try {
      const tools = await mcpApi.listTools();
      set({ tools });
    } catch (e: any) {
      message.error(e.message || "获取 MCP 工具失败");
    }
  },

  connect: async (data) => {
    try {
      await mcpApi.connect(data);
      message.success(`MCP 服务器 "${data.name}" 连接成功`);
      await get().fetchServers();
      await get().fetchTools();
    } catch (e: any) {
      message.error(e.message || "连接失败");
    }
  },

  callTool: async (server, tool, params) => {
    try {
      const res = await mcpApi.callTool(server, tool, params);
      return res;
    } catch (e: any) {
      message.error(e.message || "调用工具失败");
      return undefined;
    }
  },
}));
