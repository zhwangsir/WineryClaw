import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerWorkflowsRoutes } from "../src/server/workflows-routes.js";
import type { AgentManager } from "../src/agent/agent-manager.js";

interface FakeWorkflow {
  id: string;
  name: string;
  workspaceId?: string;
}

interface FakeRun {
  runId: string;
  workflowId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  inputs: Record<string, unknown>;
}

function makeFakeAgentManager() {
  const workflows = new Map<string, FakeWorkflow>();
  const runs = new Map<string, FakeRun>();

  const mgr = {
    listWorkflows: vi.fn((workspaceId?: string) => {
      const all = Array.from(workflows.values());
      return workspaceId ? all.filter((w) => w.workspaceId === workspaceId) : all;
    }),
    getWorkflow: vi.fn((id: string) => workflows.get(id)),
    createWorkflow: vi.fn((def: Partial<FakeWorkflow>) => {
      const w: FakeWorkflow = {
        id: `w-${workflows.size + 1}`,
        name: def.name ?? "",
        workspaceId: def.workspaceId,
      };
      workflows.set(w.id, w);
      return { ok: true, workflow: w };
    }),
    updateWorkflow: vi.fn((id: string, updates: Partial<FakeWorkflow>) => {
      const w = workflows.get(id);
      if (!w) return { ok: false, error: "not found" };
      Object.assign(w, updates);
      return { ok: true, workflow: w };
    }),
    deleteWorkflow: vi.fn((id: string) => workflows.delete(id)),
    validateWorkflow: vi.fn((id: string) => ({
      ok: workflows.has(id),
      valid: workflows.has(id),
    })),
    runWorkflow: vi.fn(async (id: string, inputs: Record<string, unknown>) => {
      const w = workflows.get(id);
      if (!w) throw new Error("workflow not found");
      const run: FakeRun = {
        runId: `r-${runs.size + 1}`,
        workflowId: id,
        status: "running",
        inputs,
      };
      runs.set(run.runId, run);
      return run;
    }),
    listWorkflowRuns: vi.fn((id: string, status?: string) => {
      const all = Array.from(runs.values()).filter((r) => r.workflowId === id);
      return status ? all.filter((r) => r.status === status) : all;
    }),
    getWorkflowRun: vi.fn((runId: string) => runs.get(runId)),
    cancelWorkflowRun: vi.fn((runId: string) => {
      const r = runs.get(runId);
      if (!r) return false;
      r.status = "cancelled";
      return true;
    }),
  };

  return { mgr, workflows, runs };
}

describe("workflows routes", () => {
  let app: FastifyInstance;
  let mgr: ReturnType<typeof makeFakeAgentManager>["mgr"];

  beforeEach(async () => {
    const fake = makeFakeAgentManager();
    mgr = fake.mgr;
    app = Fastify();
    registerWorkflowsRoutes(app, { agentManager: mgr as unknown as AgentManager });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /workflows returns empty initially", async () => {
    const res = await app.inject({ method: "GET", url: "/workflows" });
    expect(res.json()).toEqual({ workflows: [] });
  });

  it("GET /workflows?workspaceId=X filters", async () => {
    await app.inject({ method: "GET", url: "/workflows?workspaceId=ws1" });
    expect(mgr.listWorkflows).toHaveBeenCalledWith("ws1");
  });

  it("POST /workflows creates a workflow", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workflows",
      payload: { name: "w-a", workspaceId: "ws1" },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().workflow.name).toBe("w-a");
  });

  it("POST /workflows handles empty body", async () => {
    const res = await app.inject({ method: "POST", url: "/workflows", payload: {} });
    expect(res.json().ok).toBe(true);
  });

  it("GET /workflows/:id returns the workflow", async () => {
    await app.inject({ method: "POST", url: "/workflows", payload: { name: "x" } });
    const res = await app.inject({ method: "GET", url: "/workflows/w-1" });
    expect(res.json().workflow.name).toBe("x");
  });

  it("PUT /workflows/:id updates", async () => {
    await app.inject({ method: "POST", url: "/workflows", payload: { name: "x" } });
    const res = await app.inject({
      method: "PUT",
      url: "/workflows/w-1",
      payload: { name: "y" },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().workflow.name).toBe("y");
  });

  it("DELETE /workflows/:id removes", async () => {
    await app.inject({ method: "POST", url: "/workflows", payload: { name: "x" } });
    const res = await app.inject({ method: "DELETE", url: "/workflows/w-1" });
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /workflows/:id/validate returns ok=true when present", async () => {
    await app.inject({ method: "POST", url: "/workflows", payload: { name: "x" } });
    const res = await app.inject({ method: "GET", url: "/workflows/w-1/validate" });
    expect(res.json().valid).toBe(true);
  });

  it("POST /workflows/:id/run starts a run and returns it", async () => {
    await app.inject({ method: "POST", url: "/workflows", payload: { name: "x" } });
    const res = await app.inject({
      method: "POST",
      url: "/workflows/w-1/run",
      payload: { inputs: { a: 1 } },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().run.workflowId).toBe("w-1");
    expect(res.json().run.inputs).toEqual({ a: 1 });
  });

  it("POST /workflows/:id/run defaults inputs={}", async () => {
    await app.inject({ method: "POST", url: "/workflows", payload: { name: "x" } });
    await app.inject({ method: "POST", url: "/workflows/w-1/run", payload: {} });
    expect(mgr.runWorkflow).toHaveBeenCalledWith("w-1", {});
  });

  it("GET /workflows/:id/runs filters by ?status", async () => {
    await app.inject({ method: "POST", url: "/workflows", payload: { name: "x" } });
    await app.inject({ method: "POST", url: "/workflows/w-1/run", payload: {} });
    const r1 = await app.inject({ method: "GET", url: "/workflows/w-1/runs" });
    expect(r1.json().runs).toHaveLength(1);
    const r2 = await app.inject({ method: "GET", url: "/workflows/w-1/runs?status=succeeded" });
    expect(r2.json().runs).toEqual([]);
  });

  it("GET /workflow-runs/:runId returns the run", async () => {
    await app.inject({ method: "POST", url: "/workflows", payload: { name: "x" } });
    await app.inject({ method: "POST", url: "/workflows/w-1/run", payload: {} });
    const res = await app.inject({ method: "GET", url: "/workflow-runs/r-1" });
    expect(res.json().run.runId).toBe("r-1");
  });

  it("POST /workflow-runs/:runId/cancel cancels it", async () => {
    await app.inject({ method: "POST", url: "/workflows", payload: { name: "x" } });
    await app.inject({ method: "POST", url: "/workflows/w-1/run", payload: {} });
    const res = await app.inject({ method: "POST", url: "/workflow-runs/r-1/cancel" });
    expect(res.json()).toEqual({ ok: true });
    const status = await app.inject({ method: "GET", url: "/workflow-runs/r-1" });
    expect(status.json().run.status).toBe("cancelled");
  });

  it("POST /workflow-runs/:runId/cancel returns ok=false for unknown", async () => {
    const res = await app.inject({ method: "POST", url: "/workflow-runs/nope/cancel" });
    expect(res.json()).toEqual({ ok: false });
  });
});
