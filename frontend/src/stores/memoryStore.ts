import { create } from "zustand";
import { message } from "antd";
import { memoryApi } from "../api/memory";
import type { Memory } from "../api/types";
import { createOptimisticDelete } from "./utils";

interface MemoryState {
  memories: Memory[];
  loading: boolean;
  error: Error | null;
  searchQuery: string;

  fetchMemories: () => Promise<void>;
  search: (query: string, levels?: string[]) => Promise<void>;
  store: (data: Partial<Memory>) => Promise<void>;
  clearSearch: () => Promise<void>;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  loading: false,
  error: null,
  searchQuery: "",

  fetchMemories: async () => {
    if (get().loading) return;

    set({ loading: true, error: null, searchQuery: "" });
    try {
      const list = await memoryApi.list();
      set({ memories: list, loading: false, error: null });
    } catch (e: any) {
      message.error(e.message || "获取记忆失败");
      set({ loading: false, error: e });
    }
  },

  search: async (query, levels) => {
    set({ loading: true, error: null, searchQuery: query });
    try {
      const results = await memoryApi.search(query, levels);
      set({ memories: results, loading: false, error: null });
    } catch (e: any) {
      message.error(e.message || "搜索记忆失败");
      set({ loading: false, error: e });
    }
  },

  store: async (data) => {
    try {
      await memoryApi.store(data);
      message.success("记忆已存储");
      await get().fetchMemories();
    } catch (e: any) {
      message.error(e.message || "存储记忆失败");
    }
  },

  clearSearch: async () => {
    set({ searchQuery: "" });
    await get().fetchMemories();
  },

  deleteMemory: createOptimisticDelete<Memory>(
    get,
    set,
    "memories",
    memoryApi.delete,
    { successMsg: "记忆已删除", errorMsg: "删除记忆失败" }
  ),
}));
