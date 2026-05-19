import { describe, it, expect, vi, beforeEach } from "vitest";
import { useCronStore } from "./cronStore";

vi.mock("../api/cron", () => ({
  cronApi: {
    list: vi.fn(),
    runs: vi.fn(),
    stats: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { cronApi } from "../api/cron";
import { message } from "antd";

describe("cronStore", () => {
  beforeEach(() => {
    useCronStore.setState({
      jobs: [],
      runs: [],
      stats: {},
      loading: false,
      error: null,
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useCronStore.getState();
    expect(state.jobs).toEqual([]);
    expect(state.stats).toEqual({});
  });

  it("fetchJobs loads jobs", async () => {
    vi.mocked(cronApi.list).mockResolvedValue([{ id: "j1" }]);
    await useCronStore.getState().fetchJobs();
    expect(useCronStore.getState().jobs).toHaveLength(1);
    expect(useCronStore.getState().loading).toBe(false);
  });

  it("fetchJobs skips when loading", async () => {
    useCronStore.setState({ loading: true });
    await useCronStore.getState().fetchJobs();
    expect(cronApi.list).not.toHaveBeenCalled();
  });

  it("fetchJobs handles errors", async () => {
    vi.mocked(cronApi.list).mockRejectedValue(new Error("fail"));
    await useCronStore.getState().fetchJobs();
    expect(useCronStore.getState().loading).toBe(false);
  });

  it("fetchJobs handles error without message", async () => {
    vi.mocked(cronApi.list).mockRejectedValue(new Error(""));
    await useCronStore.getState().fetchJobs();
    expect(message.error).toHaveBeenCalledWith("获取任务列表失败");
  });

  it("fetchRuns loads runs", async () => {
    vi.mocked(cronApi.runs).mockResolvedValue([{ id: "r1" }]);
    await useCronStore.getState().fetchRuns("j1");
    expect(useCronStore.getState().runs).toHaveLength(1);
  });

  it("fetchRuns handles errors", async () => {
    vi.mocked(cronApi.runs).mockRejectedValue(new Error("fail"));
    await useCronStore.getState().fetchRuns();
    expect(useCronStore.getState().loading).toBe(false);
  });

  it("fetchRuns handles error without message", async () => {
    vi.mocked(cronApi.runs).mockRejectedValue(new Error(""));
    await useCronStore.getState().fetchRuns();
    expect(message.error).toHaveBeenCalledWith("获取运行记录失败");
  });

  it("fetchStats sets stats", async () => {
    vi.mocked(cronApi.stats).mockResolvedValue({ total: 5 });
    await useCronStore.getState().fetchStats();
    expect(useCronStore.getState().stats).toEqual({ total: 5 });
  });

  it("fetchStats handles errors", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(cronApi.stats).mockRejectedValue(new Error("fail"));
    await useCronStore.getState().fetchStats();
    expect(useCronStore.getState().loading).toBe(false);
    consoleSpy.mockRestore();
  });

  it("createJob succeeds and refetches", async () => {
    vi.mocked(cronApi.create).mockResolvedValue(undefined);
    vi.mocked(cronApi.list).mockResolvedValue([{ id: "j1" }]);
    await useCronStore.getState().createJob({ name: "Job1", schedule: "* * * * *" } as any);
    expect(message.success).toHaveBeenCalledWith("定时任务已创建");
  });

  it("createJob handles errors", async () => {
    vi.mocked(cronApi.create).mockRejectedValue(new Error("fail"));
    await useCronStore.getState().createJob({} as any);
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("createJob handles error without message", async () => {
    vi.mocked(cronApi.create).mockRejectedValue(new Error(""));
    await useCronStore.getState().createJob({} as any);
    expect(message.error).toHaveBeenCalledWith("创建定时任务失败");
  });

  it("deleteJob succeeds and refetches", async () => {
    vi.mocked(cronApi.delete).mockResolvedValue(undefined);
    vi.mocked(cronApi.list).mockResolvedValue([]);
    await useCronStore.getState().deleteJob("j1");
    expect(message.success).toHaveBeenCalledWith("定时任务已删除");
  });

  it("deleteJob handles errors", async () => {
    vi.mocked(cronApi.delete).mockRejectedValue(new Error("fail"));
    await useCronStore.getState().deleteJob("j1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("deleteJob handles error without message", async () => {
    vi.mocked(cronApi.delete).mockRejectedValue(new Error(""));
    await useCronStore.getState().deleteJob("j1");
    expect(message.error).toHaveBeenCalledWith("删除定时任务失败");
  });

  it("enableJob succeeds and refetches", async () => {
    vi.mocked(cronApi.enable).mockResolvedValue(undefined);
    vi.mocked(cronApi.list).mockResolvedValue([]);
    await useCronStore.getState().enableJob("j1");
    expect(message.success).toHaveBeenCalledWith("任务已启用");
  });

  it("enableJob handles errors", async () => {
    vi.mocked(cronApi.enable).mockRejectedValue(new Error("fail"));
    await useCronStore.getState().enableJob("j1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("enableJob handles error without message", async () => {
    vi.mocked(cronApi.enable).mockRejectedValue(new Error(""));
    await useCronStore.getState().enableJob("j1");
    expect(message.error).toHaveBeenCalledWith("启用任务失败");
  });

  it("disableJob succeeds and refetches", async () => {
    vi.mocked(cronApi.disable).mockResolvedValue(undefined);
    vi.mocked(cronApi.list).mockResolvedValue([]);
    await useCronStore.getState().disableJob("j1");
    expect(message.success).toHaveBeenCalledWith("任务已禁用");
  });

  it("disableJob handles errors", async () => {
    vi.mocked(cronApi.disable).mockRejectedValue(new Error("fail"));
    await useCronStore.getState().disableJob("j1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("disableJob handles error without message", async () => {
    vi.mocked(cronApi.disable).mockRejectedValue(new Error(""));
    await useCronStore.getState().disableJob("j1");
    expect(message.error).toHaveBeenCalledWith("禁用任务失败");
  });
});
