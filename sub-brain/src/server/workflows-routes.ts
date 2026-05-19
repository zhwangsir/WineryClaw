/**
 * Workflow definition + run routes.
 *
 *   GET    /workflows                         — list (optional ?workspaceId)
 *   GET    /workflows/:id                     — fetch one
 *   POST   /workflows                         — create
 *   PUT    /workflows/:id                     — update
 *   DELETE /workflows/:id                     — delete
 *   GET    /workflows/:id/validate            — validate definition
 *   POST   /workflows/:id/run                 — kick off a run
 *   GET    /workflows/:id/runs                — list this workflow's runs (?status)
 *   GET    /workflow-runs/:runId              — fetch one run
 *   POST   /workflow-runs/:runId/cancel       — cancel a run
 */

import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agent/agent-manager.js";

export interface WorkflowsRouteDeps {
  agentManager: AgentManager;
}

interface RunBody {
  inputs?: Record<string, unknown>;
}

export function registerWorkflowsRoutes(
  app: FastifyInstance,
  deps: WorkflowsRouteDeps,
): void {
  app.get("/workflows", async (request) => {
    const { workspaceId } = request.query as { workspaceId?: string };
    return { workflows: deps.agentManager.listWorkflows(workspaceId) };
  });

  app.get("/workflows/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { workflow: deps.agentManager.getWorkflow(id) };
  });

  app.post("/workflows", async (request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = (request.body as any) ?? {};
    return deps.agentManager.createWorkflow(def);
  });

  app.put("/workflows/:id", async (request) => {
    const { id } = request.params as { id: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates = (request.body as any) ?? {};
    return deps.agentManager.updateWorkflow(id, updates);
  });

  app.delete("/workflows/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { ok: deps.agentManager.deleteWorkflow(id) };
  });

  app.get("/workflows/:id/validate", async (request) => {
    const { id } = request.params as { id: string };
    return deps.agentManager.validateWorkflow(id);
  });

  app.post("/workflows/:id/run", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as RunBody) ?? {};
    const run = await deps.agentManager.runWorkflow(id, body.inputs ?? {});
    return { ok: true, run };
  });

  app.get("/workflows/:id/runs", async (request) => {
    const { id } = request.params as { id: string };
    const { status } = request.query as { status?: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { runs: deps.agentManager.listWorkflowRuns(id, status as any) };
  });

  app.get("/workflow-runs/:runId", async (request) => {
    const { runId } = request.params as { runId: string };
    return { run: deps.agentManager.getWorkflowRun(runId) };
  });

  app.post("/workflow-runs/:runId/cancel", async (request) => {
    const { runId } = request.params as { runId: string };
    return { ok: deps.agentManager.cancelWorkflowRun(runId) };
  });
}
