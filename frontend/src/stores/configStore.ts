import { create } from "zustand";
import { message } from "antd";
import { configApi } from "../api/config";
import { createOptimisticDelete } from "./utils";
import type { ModelConfig, GlobalConfig } from "../api/types";
import type { Workspace, AgentConfig } from "../api/config";

interface ConfigState {
  modelConfig: ModelConfig | null;
  globalConfig: GlobalConfig | null;
  workspaces: Workspace[];
  agents: AgentConfig[];
  loading: boolean;
  detecting: boolean;
  detectResult: { ok: boolean; message: string; details?: any } | null;

  fetchModelConfig: () => Promise<void>;
  saveModelConfig: (config: Partial<ModelConfig>) => Promise<void>;
  detectModel: () => Promise<void>;
  resetModel: () => Promise<void>;
  fetchGlobalConfig: () => Promise<void>;
  saveGlobalConfig: (config: Partial<GlobalConfig>) => Promise<void>;
  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (data: Partial<Workspace>) => Promise<void>;
  fetchWorkspaceAgents: (id: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  modelConfig: null,
  globalConfig: null,
  workspaces: [],
  agents: [],
  loading: false,
  detecting: false,
  detectResult: null,

  fetchModelConfig: async () => {
    set({ loading: true });
    try {
      const config = await configApi.getModel();
      set({ modelConfig: config, loading: false });
    } catch (e: any) {
      message.error(e.message || "获取模型配置失败");
      set({ loading: false });
    }
  },

  saveModelConfig: async (config) => {
    set({ loading: true });
    try {
      await configApi.setModel(config);
      set((s) => ({ modelConfig: s.modelConfig ? { ...s.modelConfig, ...config } : null, loading: false }));
      message.success("模型配置已保存");
    } catch (e: any) {
      message.error(e.message || "保存模型配置失败");
      set({ loading: false });
    }
  },

  detectModel: async () => {
    set({ detecting: true, detectResult: null });
    try {
      const result = await configApi.detectModel();
      set({ detectResult: result, detecting: false });
    } catch (e: any) {
      message.error(e.message || "模型检测失败");
      set({ detecting: false });
    }
  },

  resetModel: async () => {
    set({ loading: true });
    try {
      const { config } = await configApi.resetModel();
      set({ modelConfig: config, loading: false });
      message.success("已重置为默认配置");
    } catch (e: any) {
      message.error(e.message || "重置配置失败");
      set({ loading: false });
    }
  },

  fetchGlobalConfig: async () => {
    set({ loading: true });
    try {
      const config = await configApi.getGlobal();
      set({ globalConfig: config, loading: false });
    } catch (e: any) {
      message.error(e.message || "获取通用配置失败");
      set({ loading: false });
    }
  },

  saveGlobalConfig: async (config) => {
    set({ loading: true });
    try {
      await configApi.setGlobal(config);
      set((s) => ({ globalConfig: s.globalConfig ? { ...s.globalConfig, ...config } : null, loading: false }));
      message.success("通用配置已保存");
    } catch (e: any) {
      message.error(e.message || "保存通用配置失败");
      set({ loading: false });
    }
  },

  fetchWorkspaces: async () => {
    set({ loading: true });
    try {
      const workspaces = await configApi.workspaces();
      set({ workspaces, loading: false });
    } catch (e: any) {
      set({ loading: false });
      message.error(e.message || "获取工作空间失败");
    }
  },

  createWorkspace: async (data) => {
    try {
      await configApi.createWorkspace(data);
      message.success("工作空间创建成功");
      await get().fetchWorkspaces();
    } catch (e: any) {
      message.error(e.message || "创建工作空间失败");
    }
  },

  fetchWorkspaceAgents: async (id: string) => {
    try {
      const agents = await configApi.workspaceAgents(id);
      set({ agents });
    } catch (e: any) {
      message.error(e.message || "获取代理配置失败");
    }
  },

  deleteWorkspace: createOptimisticDelete<Workspace>(
    get,
    set,
    "workspaces",
    configApi.deleteWorkspace,
    { successMsg: "工作空间已删除", errorMsg: "删除工作空间失败" }
  ),
}));
