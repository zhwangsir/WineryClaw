import { create } from "zustand";
import { message } from "antd";
import { toolsApi } from "../api/tools";

import type { Tool } from "../api/types";

interface ToolState {
  tools: Tool[];
  loading: boolean;
  error: Error | null;
  globalEnabled: boolean;

  fetchTools: () => Promise<void>;
  toggleTool: (name: string, nextEnabled?: boolean) => Promise<void>;
  setGlobalEnabled: (enabled: boolean) => Promise<void>;
  executeTool: (name: string, params: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export const useToolStore = create<ToolState>((set, get) => ({
  tools: [],
  loading: false,
  error: null,
  globalEnabled: true,

  fetchTools: async () => {
    if (get().loading) return;

    set((s) => ({ ...s, loading: true, error: null }));
    try {
      const list = await toolsApi.list();
      const tools = Array.isArray(list) ? list : [];
      set({ tools, loading: false, error: null });
    } catch (e: any) {
      message.error(e.message || "获取工具列表失败");
      set({ loading: false, error: e });
    }
  },

  toggleTool: async (name, nextEnabled?) => {
    const prevTools = get().tools;
    const tool = prevTools.find((t) => t.name === name);
    if (!tool) return;

    const targetEnabled = nextEnabled !== undefined ? nextEnabled : !tool.enabled;
    // Optimistic update
    set((s) => ({
      tools: s.tools.map((t) => (t.name === name ? { ...t, enabled: targetEnabled } : t)),
    }));

    try {
      if (targetEnabled) {
        await toolsApi.enable(name);
      } else {
        await toolsApi.disable(name);
      }
    } catch (e: any) {
      message.error(e.message || "切换工具状态失败");
      // Rollback
      set({ tools: prevTools });
    }
  },

  setGlobalEnabled: async (enabled) => {
    const prev = get().globalEnabled;
    set({ globalEnabled: enabled });
    try {
      await toolsApi.globalToggle(enabled);
    } catch (e: any) {
      message.error(e.message || "全局工具切换失败");
      set({ globalEnabled: prev });
    }
  },

  executeTool: async (name, params) => {
    try {
      return await toolsApi.execute(name, params);
    } catch (e: any) {
      message.error(e.message || "工具执行失败");
      return { ok: false, error: e.message };
    }
  },
}));
