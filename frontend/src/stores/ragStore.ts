import { create } from "zustand";
import { message } from "antd";
import { ragApi } from "../api/rag";
import type { RAGChunk, RAGStats, WatcherStatus } from "../api/rag";

interface RAGState {
  stats: RAGStats | null;
  statsLoading: boolean;

  watcherStatus: WatcherStatus;
  watcherLoading: boolean;

  queryResults: RAGChunk[];
  queryLoading: boolean;
  lastQuery: string;

  // actions
  fetchStats: () => Promise<void>;
  fetchWatcherStatus: () => Promise<void>;

  indexFile: (path: string) => Promise<boolean>;
  indexDir: (dir_path: string, glob?: string) => Promise<number>;
  removeFile: (path: string) => Promise<boolean>;
  query: (q: string, k?: number) => Promise<void>;

  startWatcher: (paths: string[], glob?: string, debounce_ms?: number) => Promise<boolean>;
  stopWatcher: () => Promise<boolean>;
}

function errMsg(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message || fallback;
  if (typeof e === "string") return e;
  return fallback;
}

export const useRagStore = create<RAGState>((set, get) => ({
  stats: null,
  statsLoading: false,
  watcherStatus: { running: false },
  watcherLoading: false,
  queryResults: [],
  queryLoading: false,
  lastQuery: "",

  fetchStats: async () => {
    set({ statsLoading: true });
    try {
      const stats = await ragApi.stats();
      set({ stats, statsLoading: false });
    } catch (e: unknown) {
      set({ statsLoading: false });
      message.error(errMsg(e, "获取 RAG 统计失败"));
    }
  },

  fetchWatcherStatus: async () => {
    set({ watcherLoading: true });
    try {
      const status = await ragApi.watcherStatus();
      set({ watcherStatus: status, watcherLoading: false });
    } catch (e: unknown) {
      set({ watcherLoading: false });
      message.error(errMsg(e, "获取 watcher 状态失败"));
    }
  },

  indexFile: async (path) => {
    try {
      const result = await ragApi.indexFile(path);
      if (result.ok && result.indexed) {
        message.success(`已索引 ${result.chunks_count} 个 chunk`);
        await get().fetchStats();
        return true;
      } else if (result.ok && !result.indexed) {
        message.info(`跳过:${result.reason}`);
        return false;
      } else {
        message.error(result.error || "索引失败");
        return false;
      }
    } catch (e: unknown) {
      message.error(errMsg(e, "索引失败"));
      return false;
    }
  },

  indexDir: async (dir_path, glob = "**/*.md") => {
    try {
      const result = await ragApi.indexDir(dir_path, glob);
      if (result.ok) {
        const count = result.indexed_count ?? 0;
        message.success(`已索引 ${count} 个新文件(共 ${result.files?.length ?? 0} 个匹配)`);
        await get().fetchStats();
        return count;
      } else {
        message.error(result.error || "批量索引失败");
        return 0;
      }
    } catch (e: unknown) {
      message.error(errMsg(e, "批量索引失败"));
      return 0;
    }
  },

  removeFile: async (path) => {
    try {
      const result = await ragApi.removeFile(path);
      if (result.ok && result.removed) {
        message.success("已从索引中移除");
        await get().fetchStats();
        return true;
      } else {
        message.warning("文件未在索引中");
        return false;
      }
    } catch (e: unknown) {
      message.error(errMsg(e, "移除失败"));
      return false;
    }
  },

  query: async (q, k = 5) => {
    if (!q.trim()) {
      set({ queryResults: [], lastQuery: "" });
      return;
    }
    set({ queryLoading: true, lastQuery: q });
    try {
      const result = await ragApi.query(q, k);
      if (result.ok) {
        set({ queryResults: result.chunks ?? [], queryLoading: false });
      } else {
        set({ queryLoading: false });
        message.error(result.error || "检索失败");
      }
    } catch (e: unknown) {
      set({ queryLoading: false });
      message.error(errMsg(e, "检索失败"));
    }
  },

  startWatcher: async (paths, glob = "**/*.md", debounce_ms = 500) => {
    try {
      const result = await ragApi.watcherStart({ paths, glob, debounce_ms });
      if (result.ok) {
        message.success(`Watcher 已启动,监听 ${result.watching?.length ?? 0} 个目录`);
        await get().fetchWatcherStatus();
        return true;
      } else {
        message.error(result.error || "启动 watcher 失败");
        return false;
      }
    } catch (e: unknown) {
      message.error(errMsg(e, "启动 watcher 失败"));
      return false;
    }
  },

  stopWatcher: async () => {
    try {
      await ragApi.watcherStop();
      message.success("Watcher 已停止");
      await get().fetchWatcherStatus();
      return true;
    } catch (e: unknown) {
      message.error(errMsg(e, "停止 watcher 失败"));
      return false;
    }
  },
}));
