import { create } from "zustand";
import { message } from "antd";
import { sandboxApi } from "../api/sandbox";

interface SandboxState {
  available: boolean;
  stats: Record<string, number>;
  logs: Array<{ agentId: string; action: string; timestamp: string; details?: Record<string, unknown> }>;
  loading: boolean;

  fetchStatus: () => Promise<void>;
  fetchStats: () => Promise<void>;
  fetchAudit: (agentId?: string, limit?: number) => Promise<void>;
  execute: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;
  executePython: (code: string) => Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;
}

export const useSandboxStore = create<SandboxState>((set) => ({
  available: false,
  stats: {},
  logs: [],
  loading: false,

  fetchStatus: async () => {
    try {
      const res = await sandboxApi.status();
      set({ available: res.available });
    } catch (e: any) {
      set({ available: false });
    }
  },

  fetchStats: async () => {
    try {
      const stats = await sandboxApi.stats();
      set({ stats });
    } catch (e: any) {
      message.error(e.message || "获取沙箱统计失败");
    }
  },

  fetchAudit: async (agentId, limit) => {
    set({ loading: true });
    try {
      const logs = await sandboxApi.audit(agentId, limit);
      set({ logs, loading: false });
    } catch (e: any) {
      set({ loading: false });
      message.error(e.message || "获取审计日志失败");
    }
  },

  execute: async (command) => {
    try {
      const res = await sandboxApi.execute(command);
      return res;
    } catch (e: any) {
      message.error(e.message || "执行失败");
      return undefined;
    }
  },

  executePython: async (code) => {
    try {
      const res = await sandboxApi.executePython(code);
      return res;
    } catch (e: any) {
      message.error(e.message || "执行失败");
      return undefined;
    }
  },
}));
