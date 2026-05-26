import { describe, it, expect, vi, beforeEach } from "vitest";
import { useConfigStore } from "./configStore";

vi.mock("../api/config", () => ({
  configApi: {
    getModel: vi.fn(),
    setModel: vi.fn(),
    detectModel: vi.fn(),
    resetModel: vi.fn(),
    getGlobal: vi.fn(),
    setGlobal: vi.fn(),
    workspaces: vi.fn(),
    createWorkspace: vi.fn(),
    workspaceAgents: vi.fn(),
    deleteWorkspace: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { configApi } from "../api/config";
import { message } from "antd";

describe("configStore", () => {
  beforeEach(() => {
    useConfigStore.setState({
      modelConfig: null,
      globalConfig: null,
      workspaces: [],
      agents: [],
      loading: false,
      detecting: false,
      detectResult: null,
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useConfigStore.getState();
    expect(state.modelConfig).toBeNull();
    expect(state.workspaces).toEqual([]);
  });

  it("fetchModelConfig succeeds", async () => {
    vi.mocked(configApi.getModel).mockResolvedValue({ modelId: "gpt-4" });
    await useConfigStore.getState().fetchModelConfig();
    expect(useConfigStore.getState().modelConfig).toEqual({ modelId: "gpt-4" });
  });

  it("fetchModelConfig handles errors", async () => {
    vi.mocked(configApi.getModel).mockRejectedValue(new Error("fail"));
    await useConfigStore.getState().fetchModelConfig();
    expect(useConfigStore.getState().loading).toBe(false);
  });

  it("fetch handles errors without message", async () => {
    vi.mocked(configApi.getModel).mockRejectedValue({});
    await useConfigStore.getState().fetchModelConfig();
    expect(message.error).toHaveBeenCalledWith("获取模型配置失败");
  });

  it("saveModelConfig merges into existing", async () => {
    useConfigStore.setState({ modelConfig: { modelId: "gpt-4", temperature: 0.5 } });
    vi.mocked(configApi.setModel).mockResolvedValue(undefined);
    await useConfigStore.getState().saveModelConfig({ temperature: 0.8 });
    expect(useConfigStore.getState().modelConfig).toEqual({ modelId: "gpt-4", temperature: 0.8 });
  });

  it("saveModelConfig keeps null when no existing config", async () => {
    vi.mocked(configApi.setModel).mockResolvedValue(undefined);
    await useConfigStore.getState().saveModelConfig({ modelId: "gpt-4" });
    expect(useConfigStore.getState().modelConfig).toBeNull();
  });

  it("saveModelConfig handles errors", async () => {
    vi.mocked(configApi.setModel).mockRejectedValue(new Error("fail"));
    await useConfigStore.getState().saveModelConfig({});
    expect(useConfigStore.getState().loading).toBe(false);
  });

  it("saveModelConfig handles error without message", async () => {
    vi.mocked(configApi.setModel).mockRejectedValue(new Error(""));
    await useConfigStore.getState().saveModelConfig({});
    expect(message.error).toHaveBeenCalledWith("保存模型配置失败");
  });

  it("detectModel sets result", async () => {
    vi.mocked(configApi.detectModel).mockResolvedValue({ ok: true, message: "found" });
    await useConfigStore.getState().detectModel();
    expect(useConfigStore.getState().detectResult).toEqual({ ok: true, message: "found" });
    expect(useConfigStore.getState().detecting).toBe(false);
  });

  it("detectModel handles errors", async () => {
    vi.mocked(configApi.detectModel).mockRejectedValue(new Error("fail"));
    await useConfigStore.getState().detectModel();
    expect(useConfigStore.getState().detecting).toBe(false);
  });

  it("detectModel handles error without message", async () => {
    vi.mocked(configApi.detectModel).mockRejectedValue(new Error(""));
    await useConfigStore.getState().detectModel();
    expect(message.error).toHaveBeenCalledWith("模型检测失败");
  });

  it("resetModel sets config", async () => {
    vi.mocked(configApi.resetModel).mockResolvedValue({ config: { modelId: "default" } });
    await useConfigStore.getState().resetModel();
    expect(useConfigStore.getState().modelConfig).toEqual({ modelId: "default" });
  });

  it("resetModel handles errors", async () => {
    vi.mocked(configApi.resetModel).mockRejectedValue(new Error("fail"));
    await useConfigStore.getState().resetModel();
    expect(useConfigStore.getState().loading).toBe(false);
  });

  it("resetModel handles error without message", async () => {
    vi.mocked(configApi.resetModel).mockRejectedValue(new Error(""));
    await useConfigStore.getState().resetModel();
    expect(message.error).toHaveBeenCalledWith("重置配置失败");
  });

  it("fetchGlobalConfig succeeds", async () => {
    vi.mocked(configApi.getGlobal).mockResolvedValue({ debug: true });
    await useConfigStore.getState().fetchGlobalConfig();
    expect(useConfigStore.getState().globalConfig).toEqual({ debug: true });
  });

  it("fetchGlobalConfig handles errors", async () => {
    vi.mocked(configApi.getGlobal).mockRejectedValue(new Error("fail"));
    await useConfigStore.getState().fetchGlobalConfig();
    expect(useConfigStore.getState().loading).toBe(false);
  });

  it("fetchGlobalConfig handles error without message", async () => {
    vi.mocked(configApi.getGlobal).mockRejectedValue(new Error(""));
    await useConfigStore.getState().fetchGlobalConfig();
    expect(message.error).toHaveBeenCalledWith("获取通用配置失败");
  });

  it("saveGlobalConfig merges into existing", async () => {
    useConfigStore.setState({ globalConfig: { debug: false, logLevel: "info" } });
    vi.mocked(configApi.setGlobal).mockResolvedValue(undefined);
    await useConfigStore.getState().saveGlobalConfig({ debug: true });
    expect(useConfigStore.getState().globalConfig).toEqual({ debug: true, logLevel: "info" });
  });

  it("saveGlobalConfig keeps null when no existing config", async () => {
    vi.mocked(configApi.setGlobal).mockResolvedValue(undefined);
    await useConfigStore.getState().saveGlobalConfig({ debug: true });
    expect(useConfigStore.getState().globalConfig).toBeNull();
  });

  it("saveGlobalConfig handles errors", async () => {
    vi.mocked(configApi.setGlobal).mockRejectedValue(new Error("fail"));
    await useConfigStore.getState().saveGlobalConfig({});
    expect(useConfigStore.getState().loading).toBe(false);
  });

  it("saveGlobalConfig handles error without message", async () => {
    vi.mocked(configApi.setGlobal).mockRejectedValue(new Error(""));
    await useConfigStore.getState().saveGlobalConfig({});
    expect(message.error).toHaveBeenCalledWith("保存通用配置失败");
  });

  it("fetchWorkspaces succeeds", async () => {
    vi.mocked(configApi.workspaces).mockResolvedValue([{ workspaceId: "w1" }]);
    await useConfigStore.getState().fetchWorkspaces();
    expect(useConfigStore.getState().workspaces).toEqual([{ workspaceId: "w1" }]);
  });

  it("fetchWorkspaces handles errors", async () => {
    vi.mocked(configApi.workspaces).mockRejectedValue(new Error("fail"));
    await useConfigStore.getState().fetchWorkspaces();
    expect(useConfigStore.getState().loading).toBe(false);
  });

  it("fetchWorkspaces handles error without message", async () => {
    vi.mocked(configApi.workspaces).mockRejectedValue(new Error(""));
    await useConfigStore.getState().fetchWorkspaces();
    expect(message.error).toHaveBeenCalledWith("获取工作空间失败");
  });

  it("createWorkspace succeeds and refetches", async () => {
    vi.mocked(configApi.createWorkspace).mockResolvedValue(undefined);
    vi.mocked(configApi.workspaces).mockResolvedValue([{ workspaceId: "w1" }]);
    await useConfigStore.getState().createWorkspace({ name: "W1" });
    expect(message.success).toHaveBeenCalledWith("工作空间创建成功");
    expect(useConfigStore.getState().workspaces).toEqual([{ workspaceId: "w1" }]);
  });

  it("createWorkspace handles errors", async () => {
    vi.mocked(configApi.createWorkspace).mockRejectedValue(new Error("fail"));
    await useConfigStore.getState().createWorkspace({});
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("createWorkspace handles error without message", async () => {
    vi.mocked(configApi.createWorkspace).mockRejectedValue(new Error(""));
    await useConfigStore.getState().createWorkspace({});
    expect(message.error).toHaveBeenCalledWith("创建工作空间失败");
  });

  it("fetchWorkspaceAgents sets agents", async () => {
    vi.mocked(configApi.workspaceAgents).mockResolvedValue([{ id: "a1" }]);
    await useConfigStore.getState().fetchWorkspaceAgents("w1");
    expect(useConfigStore.getState().agents).toEqual([{ id: "a1" }]);
  });

  it("fetchWorkspaceAgents handles errors", async () => {
    vi.mocked(configApi.workspaceAgents).mockRejectedValue(new Error("fail"));
    await useConfigStore.getState().fetchWorkspaceAgents("w1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("fetchWorkspaceAgents handles error without message", async () => {
    vi.mocked(configApi.workspaceAgents).mockRejectedValue(new Error(""));
    await useConfigStore.getState().fetchWorkspaceAgents("w1");
    expect(message.error).toHaveBeenCalledWith("获取代理配置失败");
  });

  it("deleteWorkspace removes item optimistically", async () => {
    useConfigStore.setState({ workspaces: [{ workspaceId: "w1" }, { workspaceId: "w2" }] });
    vi.mocked(configApi.deleteWorkspace).mockResolvedValue(undefined);
    await useConfigStore.getState().deleteWorkspace("w1");
    expect(useConfigStore.getState().workspaces).toHaveLength(1);
    expect(message.success).toHaveBeenCalledWith("工作空间已删除");
  });

  it("deleteWorkspace rolls back on error", async () => {
    useConfigStore.setState({ workspaces: [{ workspaceId: "w1" }] });
    vi.mocked(configApi.deleteWorkspace).mockRejectedValue(new Error("fail"));
    await useConfigStore.getState().deleteWorkspace("w1");
    expect(useConfigStore.getState().workspaces).toHaveLength(1);
    expect(message.error).toHaveBeenCalledWith("fail");
  });
});
