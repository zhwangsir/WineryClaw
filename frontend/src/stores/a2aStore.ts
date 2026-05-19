import { create } from "zustand";
import { message } from "antd";
import { a2aApi } from "../api/a2a";
import type { A2ATask } from "../api/a2a";

interface A2AState {
  tasks: A2ATask[];
  loading: boolean;

  fetchTasks: () => Promise<void>;
  sendTask: (senderId: string, receiverId: string, type: string, payload?: Record<string, unknown>) => Promise<void>;
}

export const useA2aStore = create<A2AState>((set, get) => ({
  tasks: [],
  loading: false,

  fetchTasks: async () => {
    set({ loading: true });
    try {
      const tasks = await a2aApi.listTasks();
      set({ tasks, loading: false });
    } catch (e: any) {
      set({ loading: false });
      message.error(e.message || "获取任务失败");
    }
  },

  sendTask: async (senderId, receiverId, type, payload) => {
    try {
      const res = await a2aApi.sendTask(senderId, receiverId, type, payload);
      message.success(`任务已发送 (ID: ${res.taskId})`);
      await get().fetchTasks();
    } catch (e: any) {
      message.error(e.message || "发送任务失败");
    }
  },
}));
