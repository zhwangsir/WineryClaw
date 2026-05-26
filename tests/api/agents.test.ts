import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getJson, postJson, deleteJson } from "./fetch-helper";

const SUB_URL = "http://127.0.0.1:3456";

describe("Agents API", () => {
  let agentId: string;
  let taskId: string;
  const agentName = `ApiTestAgent-${Date.now()}`;

  afterAll(async () => {
    if (agentId) {
      try { await deleteJson(`${SUB_URL}/agents/${agentId}`, 5000); } catch {}
    }
  });

  it("should create an agent", async () => {
    const resp = await postJson(`${SUB_URL}/agents`, {
      name: agentName,
      description: "Created by agents API test",
      capabilities: ["chat"],
      modelConfig: {},
      tools: [],
      channels: [],
      owner: "api-test",
      workspaceId: "api-test",
    }, 5000);

    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("ok", true);
    expect(resp.data).toHaveProperty("agent");
    expect(resp.data.agent).toHaveProperty("id");
    expect(resp.data.agent.name).toBe(agentName);
    expect(resp.data.agent.status).toBe("idle");
    agentId = resp.data.agent.id;
  });

  it("should get the created agent", async () => {
    const resp = await getJson(`${SUB_URL}/agents/${agentId}`, 5000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("ok", true);
    expect(resp.data.agent).toHaveProperty("id", agentId);
    expect(resp.data.agent.name).toBe(agentName);
  });

  it("should create a task for the agent", async () => {
    const resp = await postJson(`${SUB_URL}/agents/${agentId}/tasks`, {
      type: "custom",
      payload: { code: "console.log(42)", language: "javascript" },
      contextId: `ctx-${agentId}`,
    }, 5000);

    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("ok", true);
    expect(resp.data).toHaveProperty("task");
    expect(resp.data.task).toHaveProperty("taskId");
    expect(resp.data.task.agentId).toBe(agentId);
    expect(resp.data.task.status).toBe("pending");
    taskId = resp.data.task.taskId;
  });

  it("should start the task", async () => {
    const resp = await postJson(`${SUB_URL}/agents/tasks/${taskId}/start`, {}, 5000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("ok", true);
  });

  it("should list tasks for the agent and reflect lifecycle", async () => {
    await new Promise((r) => setTimeout(r, 2500));
    const resp = await getJson(`${SUB_URL}/agents/${agentId}/tasks`, 5000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("tasks");
    expect(Array.isArray(resp.data.tasks)).toBe(true);
    const task = resp.data.tasks.find((t: any) => t.taskId === taskId);
    expect(task).toBeDefined();
    expect(["in_progress", "completed", "failed"]).toContain(task.status);
  });

  it("should update agent status", async () => {
    const resp = await postJson(`${SUB_URL}/agents/${agentId}/status`, { status: "running" }, 5000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("ok", true);
    const getResp = await getJson(`${SUB_URL}/agents/${agentId}`, 5000);
    expect(getResp.data.agent.status).toBe("running");
  });

  it("should delete the agent", async () => {
    const resp = await deleteJson(`${SUB_URL}/agents/${agentId}`, 5000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("ok", true);
    const getResp = await getJson(`${SUB_URL}/agents/${agentId}`, 5000);
    expect(getResp.data).toHaveProperty("ok", false);
  });
});
