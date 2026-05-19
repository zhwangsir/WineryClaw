import { create } from "zustand";
import { message } from "antd";
import { pluginsApi } from "../api/plugins";

interface PluginState {
  loading: boolean;
  deletePlugin: (id: string) => Promise<void>;
}

export const usePluginStore = create<PluginState>(() => ({
  loading: false,

  deletePlugin: async (id) => {
    try {
      await pluginsApi.delete(id);
      message.success("插件已删除");
    } catch (e: any) {
      message.error(e.message || "删除插件失败");
    }
  },
}));
