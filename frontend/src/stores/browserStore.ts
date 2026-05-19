import { create } from "zustand";
import { message } from "antd";
import { browserApi } from "../api/browser";
import type { BrowserSession } from "../api/browser";

interface BrowserState {
  sessions: BrowserSession[];
  loading: boolean;

  fetchSessions: () => Promise<void>;
  launch: (headless?: boolean) => Promise<void>;
  newPage: (url?: string) => Promise<BrowserSession | undefined>;
  navigate: (id: string, url: string) => Promise<void>;
  click: (id: string, selector: string) => Promise<void>;
  type: (id: string, selector: string, text: string) => Promise<void>;
  screenshot: (id: string, fullPage?: boolean) => Promise<string | undefined>;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  sessions: [],
  loading: false,

  fetchSessions: async () => {
    set({ loading: true });
    try {
      const sessions = await browserApi.sessions();
      set({ sessions, loading: false });
    } catch (e: any) {
      set({ loading: false });
      message.error(e.message || "获取会话失败");
    }
  },

  launch: async (headless) => {
    try {
      const res = await browserApi.launch(headless);
      if (res.ok) {
        message.success("浏览器已启动");
      } else {
        message.error(res.error || "启动失败");
      }
    } catch (e: any) {
      message.error(e.message || "启动失败");
    }
  },

  newPage: async (url) => {
    try {
      const res = await browserApi.newPage(url);
      if (res.ok && res.session) {
        message.success("新页面已创建");
        await get().fetchSessions();
        return res.session;
      } else {
        message.error(res.error || "创建页面失败");
      }
    } catch (e: any) {
      message.error(e.message || "创建页面失败");
    }
    return undefined;
  },

  navigate: async (id, url) => {
    try {
      const res = await browserApi.navigate(id, url);
      if (res.ok) {
        message.success("导航成功");
        await get().fetchSessions();
      } else {
        message.error(res.error || "导航失败");
      }
    } catch (e: any) {
      message.error(e.message || "导航失败");
    }
  },

  click: async (id, selector) => {
    try {
      const res = await browserApi.click(id, selector);
      if (res.ok) {
        message.success("点击成功");
      } else {
        message.error(res.error || "点击失败");
      }
    } catch (e: any) {
      message.error(e.message || "点击失败");
    }
  },

  type: async (id, selector, text) => {
    try {
      const res = await browserApi.type(id, selector, text);
      if (res.ok) {
        message.success("输入成功");
      } else {
        message.error(res.error || "输入失败");
      }
    } catch (e: any) {
      message.error(e.message || "输入失败");
    }
  },

  screenshot: async (id, fullPage) => {
    try {
      const res = await browserApi.screenshot(id, fullPage);
      if (res.ok && res.dataUrl) {
        return res.dataUrl;
      } else {
        message.error(res.error || "截图失败");
      }
    } catch (e: any) {
      message.error(e.message || "截图失败");
    }
    return undefined;
  },
}));
