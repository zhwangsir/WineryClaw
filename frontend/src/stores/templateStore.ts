import { create } from "zustand";
import { message } from "antd";
import { templatesApi } from "../api/templates";
import type { AgentTemplate } from "../api/types";

interface TemplateState {
  templates: AgentTemplate[];
  categories: string[];
  tags: string[];
  loading: boolean;
  error: Error | null;

  fetchTemplates: (category?: string, tag?: string) => Promise<void>;
  fetchCategories: () => Promise<void>;
  fetchTags: () => Promise<void>;
  createTemplate: (data: Partial<AgentTemplate>) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  instantiate: (
    id: string,
    data: { name: string; workspaceId?: string; owner?: string; variables?: Record<string, string> }
  ) => Promise<{ id: string; name: string } | undefined>;
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  templates: [],
  categories: [],
  tags: [],
  loading: false,
  error: null,

  fetchTemplates: async (category, tag) => {
    set({ loading: true, error: null });
    try {
      const templates = await templatesApi.list(category, tag);
      set({ templates, loading: false });
    } catch (e: any) {
      set({ error: e, loading: false });
      message.error(e.message || "获取模板失败");
    }
  },

  fetchCategories: async () => {
    try {
      const categories = await templatesApi.categories();
      set({ categories });
    } catch (e: any) {
      message.error(e.message || "获取分类失败");
    }
  },

  fetchTags: async () => {
    try {
      const tags = await templatesApi.tags();
      set({ tags });
    } catch (e: any) {
      message.error(e.message || "获取标签失败");
    }
  },

  createTemplate: async (data) => {
    try {
      await templatesApi.create(data);
      message.success("模板创建成功");
      await get().fetchTemplates();
    } catch (e: any) {
      message.error(e.message || "创建模板失败");
    }
  },

  deleteTemplate: async (id) => {
    try {
      await templatesApi.delete(id);
      message.success("模板已删除");
      await get().fetchTemplates();
    } catch (e: any) {
      message.error(e.message || "删除模板失败");
    }
  },

  instantiate: async (id, data) => {
    try {
      const agent = await templatesApi.instantiate(id, data);
      message.success(`智能体 "${agent.name}" 创建成功`);
      return agent;
    } catch (e: any) {
      message.error(e.message || "实例化失败");
      return undefined;
    }
  },
}));
