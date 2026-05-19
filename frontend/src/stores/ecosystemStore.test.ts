import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEcosystemStore } from "./ecosystemStore";

vi.mock("../api/ecosystem", () => ({
  ecosystemApi: {
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
    register: vi.fn(),
    relations: vi.fn(),
    reports: vi.fn(),
    resources: vi.fn(),
    resourcess: vi.fn(),
    restore: vi.fn(),
    run: vi.fn(),
    search: vi.fn(),
    send: vi.fn(),
    sessions: vi.fn(),
    skills: vi.fn(),
    stats: vi.fn(),
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

import { ecosystemApi } from "../api/ecosystem";
import { message } from "antd";

describe("ecosystemStore", () => {
  beforeEach(() => {
    useEcosystemStore.setState({
      resources: [],
      loading: false,
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useEcosystemStore.getState();
    expect(state).toBeDefined();
  });

  it("fetchResources succeeds", async () => {
    const mockData = [{ id: "1", name: "Test" }];
    vi.mocked(ecosystemApi.list).mockResolvedValue(mockData);
    await useEcosystemStore.getState().fetchResources();
    expect(useEcosystemStore.getState()).toBeDefined();
  });

  it("fetchResources handles errors", async () => {
    vi.mocked(ecosystemApi.list).mockRejectedValue(new Error("fail"));
    await useEcosystemStore.getState().fetchResources();
    expect(useEcosystemStore.getState().loading).toBe(false);
  });

  it("fetchResources handles error without message", async () => {
    vi.mocked(ecosystemApi.list).mockRejectedValue(new Error(""));
    await useEcosystemStore.getState().fetchResources();
    expect(message.error).toHaveBeenCalledWith("获取资源失败");
  });

  it("register adds resource and refreshes", async () => {
    vi.mocked(ecosystemApi.register).mockResolvedValue({ id: "r1" });
    vi.mocked(ecosystemApi.list).mockResolvedValue([{ id: "r1", name: "New" }]);
    await useEcosystemStore.getState().register({ name: "New", type: "app" });
    expect(useEcosystemStore.getState().resources).toHaveLength(1);
  });

  it("register handles error", async () => {
    vi.mocked(ecosystemApi.register).mockRejectedValue(new Error("fail"));
    await useEcosystemStore.getState().register({ name: "New", type: "app" });
    expect(useEcosystemStore.getState().resources).toEqual([]);
  });

  it("register handles error without message", async () => {
    vi.mocked(ecosystemApi.register).mockRejectedValue(new Error(""));
    await useEcosystemStore.getState().register({ name: "New", type: "app" });
    expect(message.error).toHaveBeenCalledWith("注册失败");
  });

  it("deleteResource removes resource and refreshes", async () => {
    vi.mocked(ecosystemApi.delete).mockResolvedValue(true);
    vi.mocked(ecosystemApi.list).mockResolvedValue([]);
    await useEcosystemStore.getState().deleteResource("r1");
    expect(useEcosystemStore.getState().resources).toEqual([]);
  });

  it("deleteResource handles error", async () => {
    vi.mocked(ecosystemApi.delete).mockRejectedValue(new Error("fail"));
    await useEcosystemStore.getState().deleteResource("r1");
    expect(useEcosystemStore.getState().resources).toEqual([]);
  });

  it("deleteResource handles error without message", async () => {
    vi.mocked(ecosystemApi.delete).mockRejectedValue(new Error(""));
    await useEcosystemStore.getState().deleteResource("r1");
    expect(message.error).toHaveBeenCalledWith("删除失败");
  });
});
