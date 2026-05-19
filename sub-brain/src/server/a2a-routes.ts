/**
 * Agent-to-Agent (A2A) routes.
 *
 *   GET  /a2a/tasks            — list all tasks
 *   POST /a2a/task/send        — delegate a task from one agent to another
 *   GET  /a2a/task/:taskId     — fetch one task by id
 */

import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agent/agent-manager.js";

export interface A2ARouteDeps {
  agentManager: AgentManager;
}

interface SendTaskBody {
  senderId?: string;
  receiverId?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export function registerA2ARoutes(app: FastifyInstance, deps: A2ARouteDeps): void {
  app.get("/a2a/tasks", async () => ({
    tasks: deps.agentManager.listTasks(),
  }));

  app.post("/a2a/task/send", async (request) => {
    const body = (request.body as SendTaskBody) ?? {};
    const task = await deps.agentManager.delegateTask(
      String(body.senderId ?? ""),
      String(body.receiverId ?? ""),
      String(body.type ?? ""),
      body.payload ?? {},
    );
    return { ok: true, taskId: task.taskId, status: task.status };
  });

  app.get("/a2a/task/:taskId", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const task = deps.agentManager.getTask(taskId);
    return { ok: !!task, task };
  });
}
