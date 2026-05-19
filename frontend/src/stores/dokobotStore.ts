import { create } from "zustand";
import { message } from "antd";
import { dokobotApi } from "../api/dokobot";

interface DokobotState {
  available: boolean;
  loading: boolean;

  fetchStatus: () => Promise<void>;
  browse: (url: string, action?: string) => Promise<unknown>;
  search: (query: string) => Promise<unknown>;
  screenshot: (url: string) => Promise<string | undefined>;
}

export const useDokobotStore = create<DokobotState>((set) => ({
  available: false,
  loading: false,

  fetchStatus: async () => {
    try {
      const res = await dokobotApi.status();
      set({ available: res.available });
    } catch {
      set({ available: false });
    }
  },

  browse: async (url, action) => {
    try {
      const res = await dokobotApi.browse(url, action);
      message.success("浏览完成");
      return res;
    } catch (e: any) {
      message.error(e.message || "浏览失败");
      return undefined;
    }
  },

  search: async (query) => {
    try {
      const res = await dokobotApi.search(query);
      message.success("搜索完成");
      return res;
    } catch (e: any) {
      message.error(e.message || "搜索失败");
      return undefined;
    }
  },

  screenshot: async (url) => {
    try {
      const res = await dokobotApi.screenshot(url);
      return res.dataUrl;
    } catch (e: any) {
      message.error(e.message || "截图失败");
      return undefined;
    }
  },
}));
