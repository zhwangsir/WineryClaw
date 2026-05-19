import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAgentStore } from "./agentStore";

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    run: vi.fn(),
    getSystemPrompt: vi.fn(),
    updateSystemPrompt: vi.fn(),
    getTools: vi.fn(),
    updateTools: vi.fn(),
  },
}));

vi.mock("../utils/storage", () => ({
  StorageAdapter: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { agentsApi } from "../api/agents";
import { StorageAdapter } from "../utils/storage";
import { message } from "antd";

describe("agentStore", () => {
  beforeEach(() => {
    useAgentStore.setState({
      agents: [],
      loading: false,
      error: null,
      selectedAgent: null,
      currentAgentId: "agent-default",
    });
    vi.clearAllMocks();
    vi.mocked(StorageAdapter.get).mockReturnValue(null);
  });

  it("has correct initial state", () => {
    const state = useAgentStore.getState();
    expect(state.agents).toEqual([]);
    expect(state.currentAgentId).toBe("agent-default");
  });

  it("fetchAgents loads agents", async () => {
    const agents = [{ id: "a1", name: "Agent1", isDefault: true }];
    vi.mocked(agentsApi.list).mockResolvedValue(agents);
    await useAgentStore.getState().fetchAgents();
    expect(useAgentStore.getState().agents).toEqual(agents);
    expect(useAgentStore.getState().loading).toBe(false);
  });

  it("fetchAgents skips when loading", async () => {
    useAgentStore.setState({ loading: true });
    await useAgentStore.getState().fetchAgents();
    expect(agentsApi.list).not.toHaveBeenCalled();
  });

  it("fetchAgents falls back to default agent when current invalid", async () => {
    useAgentStore.setState({ currentAgentId: "invalid" });
    const agents = [{ id: "a1", name: "Agent1", isDefault: true }];
    vi.mocked(agentsApi.list).mockResolvedValue(agents);
    await useAgentStore.getState().fetchAgents();
    expect(useAgentStore.getState().currentAgentId).toBe("a1");
    expect(StorageAdapter.set).toHaveBeenCalledWith("webrain-current-agent-id", "a1");
  });

  it("fetchAgents keeps current agent when valid", async () => {
    useAgentStore.setState({ currentAgentId: "a1" });
    const agents = [{ id: "a1", name: "Agent1" }, { id: "a2", name: "Agent2" }];
    vi.mocked(agentsApi.list).mockResolvedValue(agents);
    await useAgentStore.getState().fetchAgents();
    expect(useAgentStore.getState().currentAgentId).toBe("a1");
  });

  it("fetchAgents falls back to first agent when no default", async () => {
    useAgentStore.setState({ currentAgentId: "invalid" });
    const agents = [{ id: "a2", name: "Agent2" }, { id: "a3", name: "Agent3" }];
    vi.mocked(agentsApi.list).mockResolvedValue(agents);
    await useAgentStore.getState().fetchAgents();
    expect(useAgentStore.getState().currentAgentId).toBe("a2");
  });

  it("fetchAgents handles non-array response", async () => {
    vi.mocked(agentsApi.list).mockResolvedValue(null as any);
    await useAgentStore.getState().fetchAgents();
    expect(useAgentStore.getState().agents).toEqual([]);
  });

  it("fetchAgents handles errors", async () => {
    vi.mocked(agentsApi.list).mockRejectedValue(new Error("fail"));
    await useAgentStore.getState().fetchAgents();
    expect(useAgentStore.getState().loading).toBe(false);
    expect(useAgentStore.getState().error).toBeInstanceOf(Error);
  });

  it("fetch handles errors without message", async () => {
    vi.mocked(agentsApi.list).mockRejectedValue({});
    await useAgentStore.getState().fetchAgents();
    expect(message.error).toHaveBeenCalledWith("获取智能体失败");
  });

  it("selectAgent updates current and stores id", () => {
    useAgentStore.setState({ agents: [{ id: "a1", name: "A1" }] });
    useAgentStore.getState().selectAgent("a1");
    expect(useAgentStore.getState().currentAgentId).toBe("a1");
    expect(useAgentStore.getState().selectedAgent).toEqual({ id: "a1", name: "A1" });
    expect(StorageAdapter.set).toHaveBeenCalledWith("webrain-current-agent-id", "a1");
  });

  it("selectAgent clears stored id when empty", () => {
    useAgentStore.setState({ agents: [{ id: "a1", name: "A1" }] });
    useAgentStore.getState().selectAgent("");
    expect(StorageAdapter.remove).toHaveBeenCalledWith("webrain-current-agent-id");
  });

  it("createAgent succeeds", async () => {
    const agent = { id: "a2", name: "A2" };
    vi.mocked(agentsApi.create).mockResolvedValue(agent);
    const result = await useAgentStore.getState().createAgent({ name: "A2" });
    expect(useAgentStore.getState().agents).toContainEqual(agent);
    expect(result).toEqual(agent);
    expect(message.success).toHaveBeenCalledWith("智能体已创建");
  });

  it("createAgent handles errors", async () => {
    vi.mocked(agentsApi.create).mockRejectedValue(new Error("fail"));
    const result = await useAgentStore.getState().createAgent({});
    expect(result).toBeUndefined();
  });

  it("createAgent handles error without message", async () => {
    vi.mocked(agentsApi.create).mockRejectedValue(new Error(""));
    await useAgentStore.getState().createAgent({});
    expect(message.error).toHaveBeenCalledWith("创建智能体失败");
  });

  it("updateAgent updates existing agent and selectedAgent", async () => {
    useAgentStore.setState({
      agents: [{ id: "a1", name: "Old" }],
      selectedAgent: { id: "a1", name: "Old" },
    });
    const updated = { id: "a1", name: "New" };
    vi.mocked(agentsApi.update).mockResolvedValue(updated);
    await useAgentStore.getState().updateAgent("a1", { name: "New" });
    expect(useAgentStore.getState().agents[0].name).toBe("New");
    expect(useAgentStore.getState().selectedAgent?.name).toBe("New");
  });

  it("updateAgent skips selectedAgent when null", async () => {
    useAgentStore.setState({
      agents: [{ id: "a1", name: "Old" }],
      selectedAgent: null,
    });
    const updated = { id: "a1", name: "New" };
    vi.mocked(agentsApi.update).mockResolvedValue(updated);
    await useAgentStore.getState().updateAgent("a1", { name: "New" });
    expect(useAgentStore.getState().selectedAgent).toBeNull();
  });

  it("updateAgent skips selectedAgent when different id", async () => {
    useAgentStore.setState({
      agents: [{ id: "a1", name: "Old" }, { id: "a2", name: "Other" }],
      selectedAgent: { id: "a2", name: "Other" },
    });
    const updated = { id: "a1", name: "New" };
    vi.mocked(agentsApi.update).mockResolvedValue(updated);
    await useAgentStore.getState().updateAgent("a1", { name: "New" });
    expect(useAgentStore.getState().selectedAgent?.name).toBe("Other");
  });

  it("updateAgent handles errors", async () => {
    vi.mocked(agentsApi.update).mockRejectedValue(new Error("fail"));
    await useAgentStore.getState().updateAgent("a1", {});
    expect(useAgentStore.getState().loading).toBe(false);
  });

  it("updateAgent handles error without message", async () => {
    vi.mocked(agentsApi.update).mockRejectedValue(new Error(""));
    await useAgentStore.getState().updateAgent("a1", {});
    expect(message.error).toHaveBeenCalledWith("更新智能体失败");
  });

  it("deleteAgent removes agent and updates currentId", async () => {
    useAgentStore.setState({
      agents: [{ id: "a1" }, { id: "a2" }],
      currentAgentId: "a1",
    });
    vi.mocked(agentsApi.delete).mockResolvedValue(undefined);
    await useAgentStore.getState().deleteAgent("a1");
    expect(useAgentStore.getState().agents).toHaveLength(1);
    expect(useAgentStore.getState().currentAgentId).toBe("a2");
  });

  it("deleteAgent clears selectedAgent when matching", async () => {
    useAgentStore.setState({
      agents: [{ id: "a1" }, { id: "a2" }],
      currentAgentId: "a1",
      selectedAgent: { id: "a1", name: "A1" },
    });
    vi.mocked(agentsApi.delete).mockResolvedValue(undefined);
    await useAgentStore.getState().deleteAgent("a1");
    expect(useAgentStore.getState().selectedAgent).toBeNull();
  });

  it("deleteAgent handles errors", async () => {
    vi.mocked(agentsApi.delete).mockRejectedValue(new Error("fail"));
    await useAgentStore.getState().deleteAgent("a1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("deleteAgent handles error without message", async () => {
    vi.mocked(agentsApi.delete).mockRejectedValue(new Error(""));
    await useAgentStore.getState().deleteAgent("a1");
    expect(message.error).toHaveBeenCalledWith("删除智能体失败");
  });

  it("runAgent returns result", async () => {
    vi.mocked(agentsApi.run).mockResolvedValue({ result: "output" });
    const result = await useAgentStore.getState().runAgent("a1", "input");
    expect(result).toBe("output");
  });

  it("runAgent handles errors", async () => {
    vi.mocked(agentsApi.run).mockRejectedValue(new Error("fail"));
    const result = await useAgentStore.getState().runAgent("a1", "input");
    expect(result).toBe("");
  });

  it("runAgent handles error without message", async () => {
    vi.mocked(agentsApi.run).mockRejectedValue(new Error(""));
    await useAgentStore.getState().runAgent("a1", "input");
    expect(message.error).toHaveBeenCalledWith("运行智能体失败");
  });

  it("getSystemPrompt returns prompt", async () => {
    vi.mocked(agentsApi.getSystemPrompt).mockResolvedValue("prompt text");
    const result = await useAgentStore.getState().getSystemPrompt("a1");
    expect(result).toBe("prompt text");
  });

  it("getSystemPrompt handles errors", async () => {
    vi.mocked(agentsApi.getSystemPrompt).mockRejectedValue(new Error("fail"));
    const result = await useAgentStore.getState().getSystemPrompt("a1");
    expect(result).toBe("");
  });

  it("getSystemPrompt handles error without message", async () => {
    vi.mocked(agentsApi.getSystemPrompt).mockRejectedValue(new Error(""));
    await useAgentStore.getState().getSystemPrompt("a1");
    expect(message.error).toHaveBeenCalledWith("获取系统提示词失败");
  });

  it("updateSystemPrompt succeeds", async () => {
    vi.mocked(agentsApi.updateSystemPrompt).mockResolvedValue(undefined);
    await useAgentStore.getState().updateSystemPrompt("a1", "new prompt");
    expect(message.success).toHaveBeenCalledWith("系统提示词已更新");
  });

  it("updateSystemPrompt handles errors", async () => {
    vi.mocked(agentsApi.updateSystemPrompt).mockRejectedValue(new Error("fail"));
    await useAgentStore.getState().updateSystemPrompt("a1", "x");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("updateSystemPrompt handles error without message", async () => {
    vi.mocked(agentsApi.updateSystemPrompt).mockRejectedValue(new Error(""));
    await useAgentStore.getState().updateSystemPrompt("a1", "x");
    expect(message.error).toHaveBeenCalledWith("更新系统提示词失败");
  });

  it("getTools returns tools", async () => {
    const tools = [{ tool: "t1", enabled: true }];
    vi.mocked(agentsApi.getTools).mockResolvedValue(tools);
    const result = await useAgentStore.getState().getTools("a1");
    expect(result).toEqual(tools);
  });

  it("getTools handles errors", async () => {
    vi.mocked(agentsApi.getTools).mockRejectedValue(new Error("fail"));
    const result = await useAgentStore.getState().getTools("a1");
    expect(result).toEqual([]);
  });

  it("getTools handles error without message", async () => {
    vi.mocked(agentsApi.getTools).mockRejectedValue(new Error(""));
    await useAgentStore.getState().getTools("a1");
    expect(message.error).toHaveBeenCalledWith("获取工具配置失败");
  });

  it("updateTools succeeds", async () => {
    vi.mocked(agentsApi.updateTools).mockResolvedValue(undefined);
    await useAgentStore.getState().updateTools("a1", [{ tool: "t1", enabled: true }]);
    expect(message.success).toHaveBeenCalledWith("工具配置已更新");
  });

  it("updateTools handles errors", async () => {
    vi.mocked(agentsApi.updateTools).mockRejectedValue(new Error("fail"));
    await useAgentStore.getState().updateTools("a1", []);
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("updateTools handles error without message", async () => {
    vi.mocked(agentsApi.updateTools).mockRejectedValue(new Error(""));
    await useAgentStore.getState().updateTools("a1", []);
    expect(message.error).toHaveBeenCalledWith("更新工具配置失败");
  });
});
