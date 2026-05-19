import { describe, it, expect, vi, beforeEach } from "vitest";
import { useWorkflowStore } from "./workflowStore";

vi.mock("../api/workflows", () => ({
  workflowsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    run: vi.fn(),
    runs: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { workflowsApi } from "../api/workflows";
import { message } from "antd";

describe("workflowStore", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ workflows: [], runs: [], loading: false, error: null });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useWorkflowStore.getState();
    expect(state.workflows).toEqual([]);
  });

  it("fetchWorkflows loads workflows", async () => {
    vi.mocked(workflowsApi.list).mockResolvedValue([{ id: "w1" }]);
    await useWorkflowStore.getState().fetchWorkflows();
    expect(useWorkflowStore.getState().workflows).toHaveLength(1);
    expect(useWorkflowStore.getState().loading).toBe(false);
  });

  it("fetchWorkflows handles errors", async () => {
    vi.mocked(workflowsApi.list).mockRejectedValue(new Error("fail"));
    await useWorkflowStore.getState().fetchWorkflows();
    expect(useWorkflowStore.getState().loading).toBe(false);
  });

  it("fetchWorkflows handles error without message", async () => {
    vi.mocked(workflowsApi.list).mockRejectedValue(new Error(""));
    await useWorkflowStore.getState().fetchWorkflows();
    expect(message.error).toHaveBeenCalledWith("获取工作流失败");
  });

  it("createWorkflow succeeds and refetches", async () => {
    vi.mocked(workflowsApi.create).mockResolvedValue(undefined);
    vi.mocked(workflowsApi.list).mockResolvedValue([]);
    await useWorkflowStore.getState().createWorkflow({ name: "W1" });
    expect(message.success).toHaveBeenCalledWith("工作流创建成功");
  });

  it("createWorkflow handles errors", async () => {
    vi.mocked(workflowsApi.create).mockRejectedValue(new Error("fail"));
    await useWorkflowStore.getState().createWorkflow({});
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("createWorkflow handles error without message", async () => {
    vi.mocked(workflowsApi.create).mockRejectedValue(new Error(""));
    await useWorkflowStore.getState().createWorkflow({});
    expect(message.error).toHaveBeenCalledWith("创建工作流失败");
  });

  it("updateWorkflow succeeds and refetches", async () => {
    vi.mocked(workflowsApi.update).mockResolvedValue(undefined);
    vi.mocked(workflowsApi.list).mockResolvedValue([]);
    await useWorkflowStore.getState().updateWorkflow("w1", { name: "New" });
    expect(message.success).toHaveBeenCalledWith("工作流更新成功");
  });

  it("updateWorkflow handles errors", async () => {
    vi.mocked(workflowsApi.update).mockRejectedValue(new Error("fail"));
    await useWorkflowStore.getState().updateWorkflow("w1", {});
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("updateWorkflow handles error without message", async () => {
    vi.mocked(workflowsApi.update).mockRejectedValue(new Error(""));
    await useWorkflowStore.getState().updateWorkflow("w1", {});
    expect(message.error).toHaveBeenCalledWith("更新工作流失败");
  });

  it("deleteWorkflow succeeds and refetches", async () => {
    vi.mocked(workflowsApi.delete).mockResolvedValue(undefined);
    vi.mocked(workflowsApi.list).mockResolvedValue([]);
    await useWorkflowStore.getState().deleteWorkflow("w1");
    expect(message.success).toHaveBeenCalledWith("工作流已删除");
  });

  it("deleteWorkflow handles errors", async () => {
    vi.mocked(workflowsApi.delete).mockRejectedValue(new Error("fail"));
    await useWorkflowStore.getState().deleteWorkflow("w1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("deleteWorkflow handles error without message", async () => {
    vi.mocked(workflowsApi.delete).mockRejectedValue(new Error(""));
    await useWorkflowStore.getState().deleteWorkflow("w1");
    expect(message.error).toHaveBeenCalledWith("删除工作流失败");
  });

  it("runWorkflow succeeds and fetches runs", async () => {
    vi.mocked(workflowsApi.run).mockResolvedValue({ runId: "r1" });
    vi.mocked(workflowsApi.runs).mockResolvedValue([]);
    await useWorkflowStore.getState().runWorkflow("w1", { x: 1 });
    expect(message.success).toHaveBeenCalledWith("工作流已启动 (Run: r1)");
  });

  it("runWorkflow handles errors", async () => {
    vi.mocked(workflowsApi.run).mockRejectedValue(new Error("fail"));
    await useWorkflowStore.getState().runWorkflow("w1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("runWorkflow handles error without message", async () => {
    vi.mocked(workflowsApi.run).mockRejectedValue(new Error(""));
    await useWorkflowStore.getState().runWorkflow("w1");
    expect(message.error).toHaveBeenCalledWith("启动工作流失败");
  });

  it("fetchRuns loads runs", async () => {
    vi.mocked(workflowsApi.runs).mockResolvedValue([{ id: "r1" }]);
    await useWorkflowStore.getState().fetchRuns("w1");
    expect(useWorkflowStore.getState().runs).toHaveLength(1);
  });

  it("fetchRuns handles errors", async () => {
    vi.mocked(workflowsApi.runs).mockRejectedValue(new Error("fail"));
    await useWorkflowStore.getState().fetchRuns("w1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("fetchRuns handles error without message", async () => {
    vi.mocked(workflowsApi.runs).mockRejectedValue(new Error(""));
    await useWorkflowStore.getState().fetchRuns("w1");
    expect(message.error).toHaveBeenCalledWith("获取运行记录失败");
  });
});
