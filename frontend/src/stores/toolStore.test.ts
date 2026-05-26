import { describe, it, expect, vi, beforeEach } from "vitest";
import { useToolStore } from "./toolStore";

vi.mock("../api/tools", () => ({
  toolsApi: {
    agents: vi.fn(),
    archive: vi.fn(),
    channels: vi.fn(),
    connect: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    disable: vi.fn(),
    disconnect: vi.fn(),
    download: vi.fn(),
    enable: vi.fn(),
    entities: vi.fn(),
    events: vi.fn(),
    execute: vi.fn(),
    fetch: vi.fn(),
    files: vi.fn(),
    get: vi.fn(),
    globalToggle: vi.fn(),
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

import { toolsApi } from "../api/tools";
import { message } from "antd";

describe("toolStore", () => {
  beforeEach(() => {
    useToolStore.setState({
      tools: [],
      loading: false,
      error: null,
      globalEnabled: true,
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useToolStore.getState();
    expect(state.tools).toEqual([]);
    expect(state.globalEnabled).toBe(true);
  });

  it("fetchTools succeeds", async () => {
    const mockData = [{ name: "Test", enabled: true }];
    vi.mocked(toolsApi.list).mockResolvedValue(mockData);
    await useToolStore.getState().fetchTools();
    expect(useToolStore.getState().tools).toEqual(mockData);
    expect(useToolStore.getState().loading).toBe(false);
  });

  it("fetchTools skips when already loading", async () => {
    useToolStore.setState({ loading: true });
    await useToolStore.getState().fetchTools();
    expect(toolsApi.list).not.toHaveBeenCalled();
  });

  it("fetchTools handles non-array response", async () => {
    vi.mocked(toolsApi.list).mockResolvedValue(null as any);
    await useToolStore.getState().fetchTools();
    expect(useToolStore.getState().tools).toEqual([]);
  });

  it("fetchTools handles errors", async () => {
    vi.mocked(toolsApi.list).mockRejectedValue(new Error("fail"));
    await useToolStore.getState().fetchTools();
    expect(useToolStore.getState().loading).toBe(false);
    expect(useToolStore.getState().error).toBeInstanceOf(Error);
  });

  it("fetchTools handles error without message", async () => {
    vi.mocked(toolsApi.list).mockRejectedValue(new Error(""));
    await useToolStore.getState().fetchTools();
    expect(message.error).toHaveBeenCalledWith("获取工具列表失败");
  });

  it("toggleTool enables tool with optimistic update", async () => {
    useToolStore.setState({
      tools: [
        { name: "t1", enabled: false },
        { name: "t2", enabled: false },
      ],
    });
    vi.mocked(toolsApi.enable).mockResolvedValue(undefined);
    await useToolStore.getState().toggleTool("t1", true);
    expect(useToolStore.getState().tools[0].enabled).toBe(true);
    expect(useToolStore.getState().tools[1].enabled).toBe(false);
    expect(toolsApi.enable).toHaveBeenCalledWith("t1");
  });

  it("toggleTool disables tool with optimistic update", async () => {
    useToolStore.setState({ tools: [{ name: "t1", enabled: true }] });
    vi.mocked(toolsApi.disable).mockResolvedValue(undefined);
    await useToolStore.getState().toggleTool("t1", false);
    expect(useToolStore.getState().tools[0].enabled).toBe(false);
    expect(toolsApi.disable).toHaveBeenCalledWith("t1");
  });

  it("toggleTool toggles when nextEnabled omitted", async () => {
    useToolStore.setState({ tools: [{ name: "t1", enabled: true }] });
    vi.mocked(toolsApi.disable).mockResolvedValue(undefined);
    await useToolStore.getState().toggleTool("t1");
    expect(useToolStore.getState().tools[0].enabled).toBe(false);
  });

  it("toggleTool toggles false to true when nextEnabled omitted", async () => {
    useToolStore.setState({ tools: [{ name: "t1", enabled: false }] });
    vi.mocked(toolsApi.enable).mockResolvedValue(undefined);
    await useToolStore.getState().toggleTool("t1");
    expect(useToolStore.getState().tools[0].enabled).toBe(true);
  });

  it("toggleTool does nothing when tool not found", async () => {
    await useToolStore.getState().toggleTool("missing");
    expect(toolsApi.enable).not.toHaveBeenCalled();
    expect(toolsApi.disable).not.toHaveBeenCalled();
  });

  it("toggleTool rolls back on error", async () => {
    useToolStore.setState({ tools: [{ name: "t1", enabled: false }] });
    vi.mocked(toolsApi.enable).mockRejectedValue(new Error("fail"));
    await useToolStore.getState().toggleTool("t1", true);
    expect(useToolStore.getState().tools[0].enabled).toBe(false);
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("toggleTool rolls back on error without message", async () => {
    useToolStore.setState({ tools: [{ name: "t1", enabled: false }] });
    vi.mocked(toolsApi.enable).mockRejectedValue(new Error(""));
    await useToolStore.getState().toggleTool("t1", true);
    expect(message.error).toHaveBeenCalledWith("切换工具状态失败");
  });

  it("setGlobalEnabled toggles globally", async () => {
    vi.mocked(toolsApi.globalToggle).mockResolvedValue(undefined);
    await useToolStore.getState().setGlobalEnabled(false);
    expect(useToolStore.getState().globalEnabled).toBe(false);
    expect(toolsApi.globalToggle).toHaveBeenCalledWith(false);
  });

  it("setGlobalEnabled rolls back on error", async () => {
    useToolStore.setState({ globalEnabled: true });
    vi.mocked(toolsApi.globalToggle).mockRejectedValue(new Error("fail"));
    await useToolStore.getState().setGlobalEnabled(false);
    expect(useToolStore.getState().globalEnabled).toBe(true);
  });

  it("setGlobalEnabled rolls back on error without message", async () => {
    useToolStore.setState({ globalEnabled: true });
    vi.mocked(toolsApi.globalToggle).mockRejectedValue(new Error(""));
    await useToolStore.getState().setGlobalEnabled(false);
    expect(message.error).toHaveBeenCalledWith("全局工具切换失败");
  });

  it("executeTool returns result on success", async () => {
    const res = { ok: true, result: 42 };
    vi.mocked(toolsApi.execute).mockResolvedValue(res);
    const result = await useToolStore.getState().executeTool("t1", { x: 1 });
    expect(result).toEqual(res);
  });

  it("executeTool returns error on failure", async () => {
    vi.mocked(toolsApi.execute).mockRejectedValue(new Error("fail"));
    const result = await useToolStore.getState().executeTool("t1", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fail");
  });

  it("executeTool handles error without message", async () => {
    vi.mocked(toolsApi.execute).mockRejectedValue(new Error(""));
    const result = await useToolStore.getState().executeTool("t1", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("");
    expect(message.error).toHaveBeenCalledWith("工具执行失败");
  });
});
