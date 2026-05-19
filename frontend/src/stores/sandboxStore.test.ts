import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSandboxStore } from "./sandboxStore";

vi.mock("../api/sandbox", () => ({
  sandboxApi: {
    agents: vi.fn(),
    archive: vi.fn(),
    channels: vi.fn(),
    connect: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    disconnect: vi.fn(),
    download: vi.fn(),
    entities: vi.fn(),
    events: vi.fn(),
    execute: vi.fn(),
    fetch: vi.fn(),
    files: vi.fn(),
    get: vi.fn(),
    health: vi.fn(),
    history: vi.fn(),
    install: vi.fn(),
    jobs: vi.fn(),
    list: vi.fn(),
    logs: vi.fn(),
    memories: vi.fn(),
    messages: vi.fn(),
    notes: vi.fn(),
    plugins: vi.fn(),
    proposals: vi.fn(),
    query: vi.fn(),
    recent: vi.fn(),
    relations: vi.fn(),
    reports: vi.fn(),
    restore: vi.fn(),
    run: vi.fn(),
    search: vi.fn(),
    send: vi.fn(),
    sessions: vi.fn(),
    skills: vi.fn(),
    stats: vi.fn(),
    status: vi.fn(),
    audit: vi.fn(),
    executePython: vi.fn(),
    store: vi.fn(),
    tasks: vi.fn(),
    templates: vi.fn(),
    toggle: vi.fn(),
    tools: vi.fn(),
    uninstall: vi.fn(),
    update: vi.fn(),
    upload: vi.fn(),
    users: vi.fn(),
    workflows: vi.fn(),
    workspaces: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import { sandboxApi } from "../api/sandbox";
import { message } from "antd";

describe("sandboxStore", () => {
  beforeEach(() => {
    useSandboxStore.setState({
      available: false,
      stats: {},
      logs: [],
      loading: false,
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useSandboxStore.getState();
    expect(state.available).toBe(false);
    expect(state.stats).toEqual({});
    expect(state.logs).toEqual([]);
  });

  it("fetchStatus sets available on success", async () => {
    vi.mocked(sandboxApi.status).mockResolvedValue({ available: true });
    await useSandboxStore.getState().fetchStatus();
    expect(useSandboxStore.getState().available).toBe(true);
  });

  it("fetchStatus sets available false on error", async () => {
    vi.mocked(sandboxApi.status).mockRejectedValue(new Error("down"));
    await useSandboxStore.getState().fetchStatus();
    expect(useSandboxStore.getState().available).toBe(false);
  });

  it("fetchStats sets stats on success", async () => {
    vi.mocked(sandboxApi.stats).mockResolvedValue({ cpu: 12 });
    await useSandboxStore.getState().fetchStats();
    expect(useSandboxStore.getState().stats).toEqual({ cpu: 12 });
  });

  it("fetchStats shows error on failure", async () => {
    vi.mocked(sandboxApi.stats).mockRejectedValue(new Error("fail"));
    await useSandboxStore.getState().fetchStats();
    expect(useSandboxStore.getState().stats).toEqual({});
  });

  it("fetchStats handles error without message", async () => {
    vi.mocked(sandboxApi.stats).mockRejectedValue(new Error(""));
    await useSandboxStore.getState().fetchStats();
    expect(message.error).toHaveBeenCalledWith("获取沙箱统计失败");
  });

  it("fetchAudit sets logs on success", async () => {
    const logs = [{ agentId: "a1", action: "run", timestamp: "2024-01-01T00:00:00Z" }];
    vi.mocked(sandboxApi.audit).mockResolvedValue(logs);
    await useSandboxStore.getState().fetchAudit("a1", 10);
    expect(useSandboxStore.getState().logs).toEqual(logs);
    expect(useSandboxStore.getState().loading).toBe(false);
  });

  it("fetchAudit handles error", async () => {
    vi.mocked(sandboxApi.audit).mockRejectedValue(new Error("fail"));
    await useSandboxStore.getState().fetchAudit();
    expect(useSandboxStore.getState().loading).toBe(false);
    expect(useSandboxStore.getState().logs).toEqual([]);
  });

  it("fetchAudit handles error without message", async () => {
    vi.mocked(sandboxApi.audit).mockRejectedValue(new Error(""));
    await useSandboxStore.getState().fetchAudit();
    expect(message.error).toHaveBeenCalledWith("获取审计日志失败");
  });

  it("execute returns result on success", async () => {
    const res = { stdout: "ok", stderr: "", exitCode: 0 };
    vi.mocked(sandboxApi.execute).mockResolvedValue(res);
    const result = await useSandboxStore.getState().execute("ls");
    expect(result).toEqual(res);
  });

  it("execute returns undefined on error", async () => {
    vi.mocked(sandboxApi.execute).mockRejectedValue(new Error("fail"));
    const result = await useSandboxStore.getState().execute("ls");
    expect(result).toBeUndefined();
  });

  it("execute handles error without message", async () => {
    vi.mocked(sandboxApi.execute).mockRejectedValue(new Error(""));
    const result = await useSandboxStore.getState().execute("ls");
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("执行失败");
  });

  it("executePython returns result on success", async () => {
    const res = { stdout: "3.14", stderr: "", exitCode: 0 };
    vi.mocked(sandboxApi.executePython).mockResolvedValue(res);
    const result = await useSandboxStore.getState().executePython("print(3.14)");
    expect(result).toEqual(res);
  });

  it("executePython returns undefined on error", async () => {
    vi.mocked(sandboxApi.executePython).mockRejectedValue(new Error("fail"));
    const result = await useSandboxStore.getState().executePython("bad");
    expect(result).toBeUndefined();
  });

  it("executePython handles error without message", async () => {
    vi.mocked(sandboxApi.executePython).mockRejectedValue(new Error(""));
    const result = await useSandboxStore.getState().executePython("bad");
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("执行失败");
  });
});
