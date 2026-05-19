import { create } from "zustand";
import { message } from "antd";
import { cliApi } from "../api/cli";

interface CliState {
  status: string;
  loading: boolean;

  fetchStatus: () => Promise<void>;
  chat: (msg: string) => Promise<string | undefined>;
  exec: (tool: string, params?: Record<string, unknown>) => Promise<unknown>;
}

export const useCliStore = create<CliState>((set) => ({
  status: "",
  loading: false,

  fetchStatus: async () => {
    try {
      const res = await cliApi.status();
      set({ status: res.text });
    } catch (e: any) {
      set({ status: " unavailable" });
    }
  },

  chat: async (msg) => {
    set({ loading: true });
    try {
      const reply = await cliApi.chat(msg);
      set({ loading: false });
      return reply;
    } catch (e: any) {
      set({ loading: false });
      message.error(e.message || "请求失败");
      return undefined;
    }
  },

  exec: async (tool, params) => {
    set({ loading: true });
    try {
      const result = await cliApi.exec(tool, params);
      set({ loading: false });
      return result;
    } catch (e: any) {
      set({ loading: false });
      message.error(e.message || "执行失败");
      return undefined;
    }
  },
}));
