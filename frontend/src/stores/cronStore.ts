import { create } from "zustand";
import { message } from "antd";
import { cronApi } from "../api/cron";
import type { CronJob, CronJobData, CronRun } from "../api/types";

interface CronState {
  jobs: CronJob[];
  runs: CronRun[];
  stats: Record<string, number>;
  loading: boolean;
  error: Error | null;

  fetchJobs: () => Promise<void>;
  fetchRuns: (jobId?: string) => Promise<void>;
  fetchStats: () => Promise<void>;
  createJob: (data: CronJobData) => Promise<void>;
  deleteJob: (id: string) => Promise<void>;
  enableJob: (id: string) => Promise<void>;
  disableJob: (id: string) => Promise<void>;
}

export const useCronStore = create<CronState>((set, get) => ({
  jobs: [],
  runs: [],
  stats: {},
  loading: false,
  error: null,

  fetchJobs: async () => {
    if (get().loading) return;

    set({ loading: true, error: null });
    try {
      const list = await cronApi.list();
      set({ jobs: list, loading: false, error: null });
    } catch (e: any) {
      message.error(e.message || "获取任务列表失败");
      set({ loading: false, error: e });
    }
  },

  fetchRuns: async (jobId) => {
    set({ loading: true, error: null });
    try {
      const list = await cronApi.runs(jobId);
      set({ runs: list as CronRun[], loading: false, error: null });
    } catch (e: any) {
      message.error(e.message || "获取运行记录失败");
      set({ loading: false, error: e });
    }
  },

  fetchStats: async () => {
    set({ loading: true, error: null });
    try {
      const data = await cronApi.stats();
      set({ stats: data as Record<string, number>, loading: false, error: null });
    } catch (e: any) {
      console.error("[cronStore] fetchStats failed:", e.message);
      set({ loading: false, error: e });
    }
  },

  createJob: async (data) => {
    try {
      await cronApi.create(data);
      message.success("定时任务已创建");
      await get().fetchJobs();
    } catch (e: any) {
      message.error(e.message || "创建定时任务失败");
    }
  },

  deleteJob: async (id) => {
    try {
      await cronApi.delete(id);
      message.success("定时任务已删除");
      await get().fetchJobs();
    } catch (e: any) {
      message.error(e.message || "删除定时任务失败");
    }
  },

  enableJob: async (id) => {
    try {
      await cronApi.enable(id);
      message.success("任务已启用");
      await get().fetchJobs();
    } catch (e: any) {
      message.error(e.message || "启用任务失败");
    }
  },

  disableJob: async (id) => {
    try {
      await cronApi.disable(id);
      message.success("任务已禁用");
      await get().fetchJobs();
    } catch (e: any) {
      message.error(e.message || "禁用任务失败");
    }
  },
}));
