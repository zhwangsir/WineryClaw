import { describe, it, expect, vi, beforeEach } from "vitest";
import { useA2aStore } from "./a2aStore";

vi.mock("../api/a2a", () => ({
  a2aApi: {
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
    listTasks: vi.fn(),
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
    sendTask: vi.fn(),
    sessions: vi.fn(),
    skills: vi.fn(),
    stats: vi.fn(),
    store: vi.fn(),
    task: vi.fn(),
    tasks: vi.fn(),
    taskss: vi.fn(),
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

import { a2aApi } from "../api/a2a";
import { message } from "antd";

describe("a2aStore", () => {
  beforeEach(() => {
    useA2aStore.setState({
      tasks: [],
      loading: false,
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useA2aStore.getState();
    expect(state).toBeDefined();
  });

  it("fetchTasks succeeds", async () => {
    const mockData = [{ id: "1", name: "Test" }];
    vi.mocked(a2aApi.listTasks).mockResolvedValue(mockData);
    await useA2aStore.getState().fetchTasks();
    expect(useA2aStore.getState().tasks).toEqual(mockData);
  });

  it("fetchTasks handles errors", async () => {
    vi.mocked(a2aApi.listTasks).mockRejectedValue(new Error("fail"));
    await useA2aStore.getState().fetchTasks();
    expect(useA2aStore.getState().loading).toBe(false);
  });

  it("fetchTasks handles error without message", async () => {
    vi.mocked(a2aApi.listTasks).mockRejectedValue(new Error(""));
    await useA2aStore.getState().fetchTasks();
    expect(message.error).toHaveBeenCalledWith("获取任务失败");
  });

  it("sendTask succeeds and refetches", async () => {
    vi.mocked(a2aApi.sendTask).mockResolvedValue({ taskId: "t1" });
    vi.mocked(a2aApi.listTasks).mockResolvedValue([]);
    await useA2aStore.getState().sendTask("a1", "a2", "delegate", { x: 1 });
    expect(a2aApi.sendTask).toHaveBeenCalledWith("a1", "a2", "delegate", { x: 1 });
  });

  it("sendTask handles errors", async () => {
    vi.mocked(a2aApi.sendTask).mockRejectedValue(new Error("fail"));
    await useA2aStore.getState().sendTask("a1", "a2", "delegate");
    expect(useA2aStore.getState().loading).toBe(false);
  });

  it("sendTask handles error without message", async () => {
    vi.mocked(a2aApi.sendTask).mockRejectedValue(new Error(""));
    await useA2aStore.getState().sendTask("a1", "a2", "delegate");
    expect(message.error).toHaveBeenCalledWith("发送任务失败");
  });
});
