import { create } from "zustand";
import { message } from "antd";
import { ecosystemApi } from "../api/ecosystem";
import type { EcosystemResource } from "../api/ecosystem";

interface EcosystemState {
  resources: EcosystemResource[];
  loading: boolean;

  fetchResources: () => Promise<void>;
  register: (data: { name: string; type: string; data?: Record<string, unknown>; owner?: string }) => Promise<void>;
  deleteResource: (id: string) => Promise<void>;
}

export const useEcosystemStore = create<EcosystemState>((set, get) => ({
  resources: [],
  loading: false,

  fetchResources: async () => {
    set({ loading: true });
    try {
      const resources = await ecosystemApi.list();
      set({ resources, loading: false });
    } catch (e: any) {
      set({ loading: false });
      message.error(e.message || "获取资源失败");
    }
  },

  register: async (data) => {
    try {
      await ecosystemApi.register(data);
      message.success("资源注册成功");
      await get().fetchResources();
    } catch (e: any) {
      message.error(e.message || "注册失败");
    }
  },

  deleteResource: async (id) => {
    try {
      await ecosystemApi.delete(id);
      message.success("资源已删除");
      await get().fetchResources();
    } catch (e: any) {
      message.error(e.message || "删除失败");
    }
  },
}));
