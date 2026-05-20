import { create } from "zustand";
import { message } from "antd";
import { sandboxApi, type SandboxWorkspace, type WorkspaceExecResult } from "../api/sandbox";

interface SandboxState {
  available: boolean;
  stats: Record<string, number>;
  logs: Array<{ agentId: string; action: string; timestamp: string; details?: Record<string, unknown> }>;
  loading: boolean;
  /** Round J1 — persistent workspace registry. */
  workspaces: SandboxWorkspace[];

  fetchStatus: () => Promise<void>;
  fetchStats: () => Promise<void>;
  fetchAudit: (agentId?: string, limit?: number) => Promise<void>;
  execute: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;
  executePython: (code: string) => Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;

  // ── Round J1 ──────────────────────────────────────────────────────
  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (workspaceId: string, opts?: { network?: boolean; image?: string }) => Promise<boolean>;
  execInWorkspace: (workspaceId: string, command: string) => Promise<WorkspaceExecResult | undefined>;
  removeWorkspace: (workspaceId: string) => Promise<boolean>;
}

export const useSandboxStore = create<SandboxState>((set, get) => ({
  available: false,
  stats: {},
  logs: [],
  loading: false,
  workspaces: [],

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

  // ── Round J1 — workspaces ─────────────────────────────────────────
  fetchWorkspaces: async () => {
    try {
      const workspaces = await sandboxApi.listWorkspaces();
      set({ workspaces });
    } catch (e: any) {
      message.error(e?.message || "获取工作区列表失败");
    }
  },

  createWorkspace: async (workspaceId, opts) => {
    try {
      const res = await sandboxApi.createWorkspace({ workspaceId, ...opts });
      if (!res.ok) {
        message.error(res.error || "创建工作区失败");
        return false;
      }
      await get().fetchWorkspaces();
      message.success(`工作区 ${workspaceId} 已就绪`);
      return true;
    } catch (e: any) {
      message.error(e?.message || "创建工作区失败");
      return false;
    }
  },

  execInWorkspace: async (workspaceId, command) => {
    try {
      const res = await sandboxApi.execInWorkspace(workspaceId, command);
      // refresh lastActiveAt
      await get().fetchWorkspaces();
      return res;
    } catch (e: any) {
      message.error(e?.message || "工作区执行失败");
      return undefined;
    }
  },

  removeWorkspace: async (workspaceId) => {
    try {
      const res = await sandboxApi.removeWorkspace(workspaceId);
      if (!res.ok) {
        message.error(res.error || "删除工作区失败");
        return false;
      }
      await get().fetchWorkspaces();
      message.success(`工作区 ${workspaceId} 已删除`);
      return true;
    } catch (e: any) {
      message.error(e?.message || "删除工作区失败");
      return false;
    }
  },
}));
