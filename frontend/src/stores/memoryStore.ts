import { create } from "zustand";
import { message } from "antd";
import { memoryApi } from "../api/memory";
import type { ConflictGroup, Memory } from "../api/types";
import { createOptimisticDelete } from "./utils";

type LevelFilter = "all" | "L1" | "L2" | "L3" | "L4";

interface MemoryState {
  memories: Memory[];
  conflicts: ConflictGroup[];
  loading: boolean;
  conflictsLoading: boolean;
  dreamingRunning: boolean;
  error: Error | null;
  searchQuery: string;
  levelFilter: LevelFilter;

  fetchMemories: () => Promise<void>;
  fetchConflicts: () => Promise<void>;
  setLevelFilter: (level: LevelFilter) => Promise<void>;
  search: (query: string, levels?: string[]) => Promise<void>;
  store: (data: Partial<Memory>) => Promise<void>;
  clearSearch: () => Promise<void>;
  markCurrent: (id: string) => Promise<void>;
  runDreaming: () => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  conflicts: [],
  loading: false,
  conflictsLoading: false,
  dreamingRunning: false,
  error: null,
  searchQuery: "",
  levelFilter: "all",

  fetchMemories: async () => {
    if (get().loading) return;
    set({ loading: true, error: null, searchQuery: "" });
    try {
      const filter = get().levelFilter;
      const list = await memoryApi.list(filter === "all" ? undefined : filter, 100);
      set({ memories: list, loading: false, error: null });
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      message.error(err.message || "获取记忆失败");
      set({ loading: false, error: err });
    }
  },

  fetchConflicts: async () => {
    set({ conflictsLoading: true });
    try {
      const res = await memoryApi.conflicts();
      set({ conflicts: res.groups, conflictsLoading: false });
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      message.error(err.message || "获取冲突列表失败");
      set({ conflictsLoading: false });
    }
  },

  setLevelFilter: async (level) => {
    set({ levelFilter: level, searchQuery: "" });
    await get().fetchMemories();
  },

  search: async (query, levels) => {
    set({ loading: true, error: null, searchQuery: query });
    try {
      const results = await memoryApi.search(query, levels);
      set({ memories: results, loading: false, error: null });
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      message.error(err.message || "搜索记忆失败");
      set({ loading: false, error: err });
    }
  },

  store: async (data) => {
    try {
      await memoryApi.store(data);
      message.success("记忆已存储");
      await get().fetchMemories();
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      message.error(err.message || "存储记忆失败");
    }
  },

  clearSearch: async () => {
    set({ searchQuery: "" });
    await get().fetchMemories();
  },

  markCurrent: async (id) => {
    try {
      const res = await memoryApi.markCurrent(id);
      if (!res.ok) {
        message.error(res.error || "标记失败");
        return;
      }
      message.success("已更新当前版本");
      await get().fetchConflicts();
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      message.error(err.message || "标记失败");
    }
  },

  runDreaming: async () => {
    set({ dreamingRunning: true });
    try {
      await memoryApi.runDreaming();
      message.success("Dreaming 周期已运行");
      // Refresh both views — consolidation likely produced new L2/L3 rows
      await Promise.all([get().fetchMemories(), get().fetchConflicts()]);
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      message.error(err.message || "Dreaming 运行失败");
    } finally {
      set({ dreamingRunning: false });
    }
  },

  deleteMemory: createOptimisticDelete<Memory>(get, set, "memories", memoryApi.delete, {
    successMsg: "记忆已删除",
    errorMsg: "删除记忆失败",
  }),
}));
