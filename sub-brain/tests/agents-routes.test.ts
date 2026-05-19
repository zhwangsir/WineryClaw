import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerAgentsRoutes } from "../src/server/agents-routes.js";
import type { AgentManager } from "../src/agent/agent-manager.js";

interface FakeAgent {
  id: string;
  name: string;
  status: string;
}

interface FakeTask {
  taskId: string;
  agentId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result?: unknown;
  error?: string;
}

function makeFakeAgentManager() {
  const agents = new Map<string, FakeAgent>();
  const tasks = new Map<string, FakeTask>();
  const files = new Map<string, { systemPrompt: string; tools: unknown }>();
  const conversations = new Map<string, { id: string; agentId: string; messages: unknown[] }>();
  const broadcasts: Array<{ from: string; topic: string; payload: unknown }> = [];
  const sent: Array<{ from: string; to: string; topic: string; payload: unknown }> = [];

  let nextId = 1;
  const mkId = (prefix: string) => `${prefix}-${nextId++}`;

  const mgr = {
    listAgents: vi.fn(() => Array.from(agents.values())),
    getAgent: vi.fn((id: string) => agents.get(id)),
    createAgent: vi.fn((card: Partial<FakeAgent>) => {
      const a: FakeAgent = { id: mkId("a"), name: card.name ?? "", status: "idle" };
      agents.set(a.id, a);
      files.set(a.id, { systemPrompt: "default", tools: [] });
      return a;
    }),
    updateAgent: vi.fn((id: string, updates: Partial<FakeAgent>) => {
      const a = agents.get(id);
      if (!a) return undefined;
      Object.assign(a, updates);
      return a;
    }),
    deleteAgent: vi.fn((id: string) => agents.delete(id)),
    updateAgentStatus: vi.fn((id: string, status: string) => {
      const a = agents.get(id);
      if (a) a.status = status;
    }),
    getAgentFiles: vi.fn((id: string) => files.get(id)),
    updateAgentSystemPrompt: vi.fn((id: string, content: string) => {
      const f = files.get(id);
      if (!f) return false;
      f.systemPrompt = content;
      return true;
    }),
    updateAgentTools: vi.fn((id: string, tools: unknown) => {
      const f = files.get(id);
      if (!f) return false;
      f.tools = tools;
      return true;
    }),
    listTasks: vi.fn((id?: string) => {
      const all = Array.from(tasks.values());
      return id ? all.filter((t) => t.agentId === id) : all;
    }),
    createTask: vi.fn((agentId: string, _type: string, _payload: Record<string, unknown>, _ctx: string) => {
      const t: FakeTask = { taskId: mkId("t"), agentId, status: "pending" };
      tasks.set(t.taskId, t);
      return t;
    }),
    startTask: vi.fn((taskId: string) => {
      const t = tasks.get(taskId);
      if (t) t.status = "running";
    }),
    completeTask: vi.fn((taskId: string, result: unknown) => {
      const t = tasks.get(taskId);
      if (t) {
        t.status = "completed";
        t.result = result;
      }
    }),
    failTask: vi.fn((taskId: string, error: string) => {
      const t = tasks.get(taskId);
      if (t) {
        t.status = "failed";
        t.error = error;
      }
    }),
    cancelTask: vi.fn((taskId: string) => {
      const t = tasks.get(taskId);
      if (!t) return false;
      t.status = "cancelled";
      return true;
    }),
    delegateTask: vi.fn(async (from: string, to: string, _type: string, _payload: Record<string, unknown>) => ({
      taskId: mkId("t"),
      from,
      to,
      status: "pending",
    })),
    getHarnessState: vi.fn((id: string) => ({ agentId: id, paused: false })),
    runTaskWithHarness: vi.fn(async (taskId: string) => ({ ok: true, taskId })),
    pauseHarness: vi.fn(async (id: string) => ({ ok: true, agentId: id, paused: true })),
    bindSubagent: vi.fn(async (id: string, subagentId: string, role: string, capabilities: string[]) => ({
      ok: true,
      parentId: id,
      subagentId,
      role,
      capabilities,
    })),
    broadcast: vi.fn(async (from: string, topic: string, payload: Record<string, unknown>) => {
      const msg = { id: mkId("m"), from, topic, payload };
      broadcasts.push({ from, topic, payload });
      return msg;
    }),
    sendMessage: vi.fn(async (from: string, to: string, topic: string, payload: Record<string, unknown>) => {
      const msg = { id: mkId("m"), from, to, topic, payload };
      sent.push({ from, to, topic, payload });
      return msg;
    }),
    request: vi.fn(async (_from: string, _to: string, _action: string, _params: Record<string, unknown>, _timeoutMs: number) => ({
      ok: true,
      result: "responded",
    })),
    listConversations: vi.fn((id: string) =>
      Array.from(conversations.values()).filter((c) => c.agentId === id),
    ),
    getConversation: vi.fn((convId: string) => conversations.get(convId)),
    getMessages: vi.fn((_filter: Record<string, unknown>) => sent),
    getCollaborationStats: vi.fn(() => ({ totalSent: sent.length, totalBroadcasts: broadcasts.length })),
    getStats: vi.fn(() => ({ totalAgents: agents.size, totalTasks: tasks.size })),
  };

  return { mgr, agents, tasks, broadcasts, sent };
}

describe("agents routes", () => {
  let app: FastifyInstance;
  let mgr: ReturnType<typeof makeFakeAgentManager>["mgr"];

  beforeEach(async () => {
    const fake = makeFakeAgentManager();
    mgr = fake.mgr;
    app = Fastify();
    registerAgentsRoutes(app, { agentManager: mgr as unknown as AgentManager });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ===== Section 1: CRUD =====

  it("GET /agents returns empty initially", async () => {
    const res = await app.inject({ method: "GET", url: "/agents" });
    expect(res.json()).toEqual({ agents: [] });
  });

  it("POST /agents creates", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { name: "agent-1" },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().agent.name).toBe("agent-1");
  });

  it("GET /agents/:id returns the agent", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const res = await app.inject({ method: "GET", url: `/agents/${id}` });
    expect(res.json().ok).toBe(true);
    expect(res.json().agent.id).toBe(id);
  });

  it("GET /agents/:id/card returns same data under `card` key", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const res = await app.inject({ method: "GET", url: `/agents/${id}/card` });
    expect(res.json().card.id).toBe(id);
  });

  it("POST /agents/:id/status updates status", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    await app.inject({
      method: "POST",
      url: `/agents/${id}/status`,
      payload: { status: "running" },
    });
    expect(mgr.updateAgentStatus).toHaveBeenCalledWith(id, "running");
  });

  it("PUT /agents/:id updates", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const res = await app.inject({
      method: "PUT",
      url: `/agents/${id}`,
      payload: { name: "renamed" },
    });
    expect(res.json().agent.name).toBe("renamed");
  });

  it("DELETE /agents/:id removes", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const res = await app.inject({ method: "DELETE", url: `/agents/${id}` });
    expect(res.json()).toEqual({ ok: true });
  });

  // ===== Section 2: Files =====

  it("GET /agents/:id/system-prompt returns content", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const res = await app.inject({ method: "GET", url: `/agents/${id}/system-prompt` });
    expect(res.json().ok).toBe(true);
    expect(res.json().content).toBe("default");
  });

  it("PUT /agents/:id/system-prompt updates", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const res = await app.inject({
      method: "PUT",
      url: `/agents/${id}/system-prompt`,
      payload: { content: "you are a test agent" },
    });
    expect(res.json().ok).toBe(true);
  });

  it("PUT /agents/:id/tools updates", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const res = await app.inject({
      method: "PUT",
      url: `/agents/${id}/tools`,
      payload: { tools: ["shell"] },
    });
    expect(res.json().ok).toBe(true);
    expect(mgr.updateAgentTools).toHaveBeenCalledWith(id, ["shell"]);
  });

  it("GET /agents/:id/system-prompt returns ok=false for unknown agent", async () => {
    const res = await app.inject({ method: "GET", url: "/agents/unknown/system-prompt" });
    expect(res.json()).toEqual({ ok: false, error: "Agent not found" });
  });

  // ===== Section 3: Tasks =====

  it("POST /agents/:id/tasks creates a task", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const res = await app.inject({
      method: "POST",
      url: `/agents/${id}/tasks`,
      payload: { type: "test", payload: {} },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().task.agentId).toBe(id);
  });

  it("POST /agents/tasks/:taskId/start delegates", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const t = await app.inject({
      method: "POST",
      url: `/agents/${id}/tasks`,
      payload: { type: "x" },
    });
    const taskId = t.json().task.taskId;
    const res = await app.inject({
      method: "POST",
      url: `/agents/tasks/${taskId}/start`,
      payload: {},
    });
    expect(res.json()).toEqual({ ok: true });
  });

  it("POST /agents/tasks/:taskId/complete sets result", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const t = await app.inject({
      method: "POST",
      url: `/agents/${id}/tasks`,
      payload: { type: "x" },
    });
    const taskId = t.json().task.taskId;
    const res = await app.inject({
      method: "POST",
      url: `/agents/tasks/${taskId}/complete`,
      payload: { result: { output: 42 } },
    });
    expect(res.json()).toEqual({ ok: true });
    expect(mgr.completeTask).toHaveBeenCalledWith(taskId, { output: 42 });
  });

  it("POST /agents/tasks/:taskId/cancel works", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const t = await app.inject({
      method: "POST",
      url: `/agents/${id}/tasks`,
      payload: { type: "x" },
    });
    const taskId = t.json().task.taskId;
    const res = await app.inject({
      method: "POST",
      url: `/agents/tasks/${taskId}/cancel`,
      payload: {},
    });
    expect(res.json()).toEqual({ ok: true });
  });

  // ===== Section 4: Harness =====

  it("GET /agents/:id/harness/state returns state object", async () => {
    const res = await app.inject({ method: "GET", url: "/agents/a-X/harness/state" });
    expect(res.json().agentId).toBe("a-X");
  });

  it("POST /agents/:id/harness/pause delegates", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/a-X/harness/pause",
      payload: {},
    });
    expect(res.json().paused).toBe(true);
  });

  it("POST /agents/:id/harness/bind forwards all 4 fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/parent/harness/bind",
      payload: { subagentId: "sub1", role: "worker", capabilities: ["shell"] },
    });
    expect(res.json()).toMatchObject({
      ok: true,
      parentId: "parent",
      subagentId: "sub1",
      role: "worker",
    });
  });

  // ===== Section 5: Collaboration =====

  it("POST /agents/:id/broadcast forwards topic + payload", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    const res = await app.inject({
      method: "POST",
      url: `/agents/${id}/broadcast`,
      payload: { topic: "news", payload: { text: "hi" } },
    });
    expect(res.json().ok).toBe(true);
    expect(mgr.broadcast).toHaveBeenCalledWith(id, "news", { text: "hi" });
  });

  it("POST /agents/:id/broadcast defaults topic=general and payload={}", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    await app.inject({ method: "POST", url: `/agents/${id}/broadcast`, payload: {} });
    expect(mgr.broadcast).toHaveBeenCalledWith(id, "general", {});
  });

  it("POST /agents/:id/message forwards", async () => {
    const c = await app.inject({ method: "POST", url: "/agents", payload: { name: "x" } });
    const id = c.json().agent.id;
    await app.inject({
      method: "POST",
      url: `/agents/${id}/message`,
      payload: { to: "b", topic: "t", payload: { x: 1 } },
    });
    expect(mgr.sendMessage).toHaveBeenCalledWith(id, "b", "t", { x: 1 });
  });

  it("POST /agents/:id/request forwards + defaults timeout", async () => {
    await app.inject({
      method: "POST",
      url: "/agents/a/request",
      payload: { to: "b", action: "do", params: {} },
    });
    expect(mgr.request).toHaveBeenCalledWith("a", "b", "do", {}, 30000);
  });

  it("POST /agents/:from/delegate/:to forwards type + payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/a/delegate/b",
      payload: { type: "work", payload: { k: "v" } },
    });
    expect(res.json().ok).toBe(true);
    expect(mgr.delegateTask).toHaveBeenCalledWith("a", "b", "work", { k: "v" });
  });

  // ===== Section 6: Literal-path routing precedence =====

  it("GET /agents/messages hits literal route (not /agents/:id)", async () => {
    const res = await app.inject({ method: "GET", url: "/agents/messages?from=a&limit=5" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("messages");
    // Critical: getAgent should not have been invoked with "messages" as the id
    expect(mgr.getAgent).not.toHaveBeenCalled();
  });

  it("GET /agents/collaboration/stats hits literal route", async () => {
    const res = await app.inject({ method: "GET", url: "/agents/collaboration/stats" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("totalSent");
  });

  it("GET /agents/stats hits literal route", async () => {
    const res = await app.inject({ method: "GET", url: "/agents/stats" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("totalAgents");
  });
});
