/**
 * Agent routes — the full /agents/* surface, divided into 5 internal sections:
 *
 *  1) CRUD + lifecycle              (8 routes)
 *  2) Agent files (system / tools)  (4 routes)
 *  3) Tasks                         (7 routes)
 *  4) Harness                       (4 routes)
 *  5) Collaboration (A2A)           (7 routes)
 *  6) Stats                         (2 routes)
 *
 * Total: 32 route handlers (the "/agents" GET serves both JSON and the SPA
 * shell when Accept: text/html, so it counts as one route).
 *
 * Literal/specific paths register BEFORE param routes to avoid being captured
 * by /:id matchers — pay close attention to ordering when modifying.
 */

import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agent/agent-manager.js";

export interface AgentsRouteDeps {
  agentManager: AgentManager;
}

// --------------------------------------------------------------------------
// Body / param types
// --------------------------------------------------------------------------

interface CreateTaskBody {
  type?: string;
  payload?: Record<string, unknown>;
  contextId?: string;
}

interface RunBody {
  input?: unknown;
}

interface CompleteTaskBody {
  result?: unknown;
}

interface FailTaskBody {
  error?: string;
}

interface DelegateBody {
  type?: string;
  payload?: Record<string, unknown>;
}

interface StatusBody {
  status?: string;
}

interface SystemPromptBody {
  content?: string;
}

interface ToolsBody {
  tools?: unknown;
}

interface BindSubagentBody {
  subagentId?: string;
  role?: string;
  capabilities?: string[];
}

interface BroadcastBody {
  topic?: string;
  payload?: Record<string, unknown>;
}

interface AgentMessageBody {
  to?: string;
  topic?: string;
  payload?: Record<string, unknown>;
}

interface RequestBody {
  to?: string;
  action?: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

interface MessagesQuery {
  from?: string;
  to?: string;
  type?: string;
  topic?: string;
  limit?: string;
}

// --------------------------------------------------------------------------
// Run-task polling helper
// --------------------------------------------------------------------------

const RUN_TIMEOUT_MS = 60_000;
const RUN_POLL_MS = 500;

async function pollTaskToCompletion(
  mgr: AgentManager,
  agentId: string,
  taskId: string,
): Promise<{ ok: boolean; result?: unknown; error?: string; taskId: string }> {
  const start = Date.now();
  while (Date.now() - start < RUN_TIMEOUT_MS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = mgr.listTasks(agentId).find((x: any) => x.taskId === taskId);
    if (!t) return { ok: false, error: "Task disappeared", taskId };
    if (t.status === "completed") return { ok: true, result: t.result, taskId };
    if (t.status === "failed") return { ok: false, error: t.error || "Task failed", taskId };
    if (t.status === "cancelled") return { ok: false, error: "Task cancelled", taskId };
    await new Promise((r) => setTimeout(r, RUN_POLL_MS));
  }
  return { ok: false, error: "Task timeout", taskId };
}

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------

export function registerAgentsRoutes(app: FastifyInstance, deps: AgentsRouteDeps): void {
  const mgr = deps.agentManager;

  // ===== Literal /agents/* paths first (must beat /agents/:id) =====
  // tasks/:taskId/* group — taskId param is in a fixed position different from /agents/:id
  app.post("/agents/tasks/:taskId/start", async (request) => {
    const { taskId } = request.params as { taskId: string };
    mgr.startTask(taskId);
    return { ok: true };
  });
  app.post("/agents/tasks/:taskId/complete", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const body = (request.body as CompleteTaskBody) ?? {};
    mgr.completeTask(taskId, body.result);
    return { ok: true };
  });
  app.post("/agents/tasks/:taskId/fail", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const body = (request.body as FailTaskBody) ?? {};
    mgr.failTask(taskId, String(body.error ?? ""));
    return { ok: true };
  });
  app.post("/agents/tasks/:taskId/cancel", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const ok = mgr.cancelTask(taskId);
    return { ok };
  });

  // conversations/:convId — single literal segment then param
  app.get("/agents/conversations/:convId", async (request) => {
    const { convId } = request.params as { convId: string };
    return { conversation: mgr.getConversation(convId) };
  });

  // /agents/messages and /agents/collaboration/stats and /agents/stats — all literal
  app.get("/agents/messages", async (request) => {
    const q = request.query as MessagesQuery;
    return {
      messages: mgr.getMessages({
        from: q.from,
        to: q.to,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: q.type as any,
        topic: q.topic,
        limit: q.limit ? parseInt(q.limit, 10) : undefined,
      }),
    };
  });

  app.get("/agents/collaboration/stats", async () => mgr.getCollaborationStats());
  app.get("/agents/stats", async () => mgr.getStats());

  // ===== Section 1: CRUD + lifecycle =====

  app.get("/agents", async (request, reply) => {
    if (request.headers.accept?.includes("text/html")) {
      await reply.sendFile("index.html");
      return;
    }
    return { agents: mgr.listAgents() };
  });

  app.post("/agents", async (request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const card = (request.body as any) ?? {};
    const agent = mgr.createAgent(card);
    return { ok: true, agent };
  });

  app.get("/agents/:id", async (request) => {
    const { id } = request.params as { id: string };
    const agent = mgr.getAgent(id);
    return { ok: !!agent, agent };
  });

  app.get("/agents/:id/card", async (request) => {
    const { id } = request.params as { id: string };
    const agent = mgr.getAgent(id);
    return { ok: !!agent, card: agent };
  });

  app.post("/agents/:id/status", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as StatusBody) ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mgr.updateAgentStatus(id, body.status as any);
    return { ok: true };
  });

  app.put("/agents/:id", async (request) => {
    const { id } = request.params as { id: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates = (request.body as any) ?? {};
    const agent = mgr.updateAgent(id, updates);
    return { ok: !!agent, agent };
  });

  app.delete("/agents/:id", async (request) => {
    const { id } = request.params as { id: string };
    const ok = mgr.deleteAgent(id);
    return { ok };
  });

  // ===== Section 2: Agent files =====

  app.get("/agents/:id/system-prompt", async (request) => {
    const { id } = request.params as { id: string };
    const files = mgr.getAgentFiles(id);
    if (!files) return { ok: false, error: "Agent not found" };
    return { ok: true, content: files.systemPrompt };
  });

  app.put("/agents/:id/system-prompt", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as SystemPromptBody) ?? {};
    const ok = mgr.updateAgentSystemPrompt(id, String(body.content ?? ""));
    return { ok };
  });

  app.get("/agents/:id/tools", async (request) => {
    const { id } = request.params as { id: string };
    const files = mgr.getAgentFiles(id);
    if (!files) return { ok: false, error: "Agent not found" };
    return { ok: true, tools: files.tools };
  });

  app.put("/agents/:id/tools", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as ToolsBody) ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = mgr.updateAgentTools(id, body.tools as any);
    return { ok };
  });

  // ===== Section 3: Tasks =====

  app.get("/agents/:id/tasks", async (request) => {
    const { id } = request.params as { id: string };
    return { tasks: mgr.listTasks(id) };
  });

  app.post("/agents/:id/tasks", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as CreateTaskBody) ?? {};
    const task = mgr.createTask(
      id,
      String(body.type ?? ""),
      body.payload ?? {},
      body.contextId ?? `ctx-${id}`,
    );
    return { ok: true, task };
  });

  app.post("/agents/:id/run", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as RunBody) ?? {};
    const agent = mgr.getAgent(id);
    if (!agent) return { ok: false, error: "Agent not found" };
    const task = mgr.createTask(id, "run", { input: body.input }, `ctx-run-${id}`);
    mgr.startTask(task.taskId);
    return pollTaskToCompletion(mgr, id, task.taskId);
  });

  app.post("/agents/:from/delegate/:to", async (request) => {
    const { from, to } = request.params as { from: string; to: string };
    const body = (request.body as DelegateBody) ?? {};
    const task = await mgr.delegateTask(
      from,
      to,
      String(body.type ?? ""),
      body.payload ?? {},
    );
    return { ok: true, task };
  });

  // ===== Section 4: Harness =====

  app.get("/agents/:id/harness/state", async (request) => {
    const { id } = request.params as { id: string };
    return mgr.getHarnessState(id);
  });

  app.post("/agents/:id/harness/run/:taskId", async (request) => {
    const { taskId } = request.params as { id: string; taskId: string };
    return mgr.runTaskWithHarness(taskId);
  });

  app.post("/agents/:id/harness/pause", async (request) => {
    const { id } = request.params as { id: string };
    return mgr.pauseHarness(id);
  });

  app.post("/agents/:id/harness/bind", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as BindSubagentBody) ?? {};
    return mgr.bindSubagent(
      id,
      String(body.subagentId ?? ""),
      String(body.role ?? ""),
      body.capabilities ?? [],
    );
  });

  // ===== Section 5: Collaboration =====

  app.post("/agents/:id/broadcast", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as BroadcastBody) ?? {};
    const msg = await mgr.broadcast(id, body.topic ?? "general", body.payload ?? {});
    return { ok: true, message: msg };
  });

  app.post("/agents/:id/message", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as AgentMessageBody) ?? {};
    const msg = await mgr.sendMessage(
      id,
      String(body.to ?? ""),
      body.topic ?? "general",
      body.payload ?? {},
    );
    return { ok: true, message: msg };
  });

  app.post("/agents/:id/request", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as RequestBody) ?? {};
    const resp = await mgr.request(
      id,
      String(body.to ?? ""),
      String(body.action ?? ""),
      body.params ?? {},
      body.timeoutMs ?? 30_000,
    );
    return { ok: true, response: resp };
  });

  app.get("/agents/:id/conversations", async (request) => {
    const { id } = request.params as { id: string };
    return { conversations: mgr.listConversations(id) };
  });
}
