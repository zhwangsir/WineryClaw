import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerSandboxRoutes } from "../src/server/sandbox-routes.js";
import type { DockerSandbox } from "../src/sandbox/docker-sandbox.js";
import type { AgentManager } from "../src/agent/agent-manager.js";

function makeFakeDocker() {
  // In-memory workspace registry so tests can verify state across calls.
  const workspaces = new Map<string, { workspaceId: string; image: string; memory: string; cpus: number; network: boolean; lastActiveAt: string; hostPath: string }>();

  return {
    execute: vi.fn(async (command: string, inputFiles?: Record<string, string>) => ({
      ok: true,
      stdout: `ran: ${command}`,
      inputFiles: inputFiles ?? {},
    })),
    executePython: vi.fn(async (code: string) => ({ ok: true, output: `python: ${code.length} chars` })),
    isAvailable: vi.fn(() => true),
    // J1 workspace surface
    listWorkspaces: vi.fn(() => [...workspaces.values()]),
    // J2 image probe
    resolveDefaultWorkspaceImage: vi.fn(() => "webrain-workspace:latest"),
    ensureWorkspace: vi.fn(async (workspaceId: string, opts?: { image?: string; memory?: string; cpus?: number; network?: boolean }) => {
      const cfg = {
        workspaceId,
        image: opts?.image ?? "node:20-alpine",
        memory: opts?.memory ?? "512m",
        cpus: opts?.cpus ?? 1.0,
        network: opts?.network ?? false,
        lastActiveAt: new Date().toISOString(),
        hostPath: `/tmp/ws-${workspaceId}`,
      };
      workspaces.set(workspaceId, cfg);
      return { ok: true, workspace: cfg };
    }),
    execInWorkspace: vi.fn(async (workspaceId: string, command: string) => ({
      ok: true,
      output: `ws:${workspaceId}:${command}`,
      exitCode: 0,
    })),
    removeWorkspace: vi.fn(async (workspaceId: string) => {
      workspaces.delete(workspaceId);
      return { ok: true };
    }),
  };
}

function makeFakeAgentMgr() {
  const policies = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const audit: Array<{ agentId: string; action: string }> = [];

  const mgr = {
    getSandboxStats: vi.fn(() => ({
      totalAgents: policies.size,
      totalSessions: sessions.size,
    })),
    getSandboxAuditLogs: vi.fn((agentId?: string, limit = 100) => {
      const filtered = agentId ? audit.filter((a) => a.agentId === agentId) : audit;
      return filtered.slice(0, limit);
    }),
    createSandboxPolicy: vi.fn((agentId: string, body: Record<string, unknown>) => {
      const p = { agentId, ...body };
      policies.set(agentId, p);
      return p;
    }),
    getSandboxPolicy: vi.fn((agentId: string) => policies.get(agentId)),
    updateSandboxPolicy: vi.fn((agentId: string, body: Record<string, unknown>) => {
      const existing = policies.get(agentId);
      if (!existing) return undefined;
      const merged = { ...existing, ...body };
      policies.set(agentId, merged);
      return merged;
    }),
    createSandboxSession: vi.fn((agentId: string) => {
      const s = { sessionId: `s-${sessions.size + 1}`, agentId };
      sessions.set(s.sessionId, s);
      return s;
    }),
  };

  return { mgr, policies, sessions };
}

describe("sandbox routes", () => {
  let app: FastifyInstance;
  let docker: ReturnType<typeof makeFakeDocker>;
  let agentMgr: ReturnType<typeof makeFakeAgentMgr>["mgr"];

  beforeEach(async () => {
    docker = makeFakeDocker();
    const fake = makeFakeAgentMgr();
    agentMgr = fake.mgr;
    app = Fastify();
    registerSandboxRoutes(app, {
      dockerSandbox: docker as unknown as DockerSandbox,
      agentManager: agentMgr as unknown as AgentManager,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ---- Docker sandbox ----

  it("POST /sandbox/execute forwards command + inputFiles", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sandbox/execute",
      payload: { command: "ls", inputFiles: { "a.txt": "x" } },
    });
    expect(res.json().ok).toBe(true);
    expect(docker.execute).toHaveBeenCalledWith("ls", { "a.txt": "x" });
  });

  it("POST /sandbox/python forwards code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sandbox/python",
      payload: { code: "print(1)" },
    });
    expect(res.json().ok).toBe(true);
    expect(docker.executePython).toHaveBeenCalledWith("print(1)");
  });

  it("GET /sandbox/status returns availability", async () => {
    const res = await app.inject({ method: "GET", url: "/sandbox/status" });
    expect(res.json()).toEqual({ available: true });
  });

  // ---- Literal vs param route ordering ----

  it("GET /sandbox/policies hits literal route (not /:agentId/policy)", async () => {
    const res = await app.inject({ method: "GET", url: "/sandbox/policies" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ policies: [] });
    // Critical: we should NOT have invoked getSandboxPolicy with "policies" as the id
    expect(agentMgr.getSandboxPolicy).not.toHaveBeenCalled();
  });

  it("GET /sandbox/stats hits literal route", async () => {
    const res = await app.inject({ method: "GET", url: "/sandbox/stats" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("totalAgents");
  });

  it("GET /sandbox/audit parses ?limit and ?agentId", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/sandbox/audit?agentId=a1&limit=50",
    });
    expect(res.statusCode).toBe(200);
    expect(agentMgr.getSandboxAuditLogs).toHaveBeenCalledWith("a1", 50);
  });

  it("GET /sandbox/audit defaults limit to 100 when omitted", async () => {
    await app.inject({ method: "GET", url: "/sandbox/audit" });
    expect(agentMgr.getSandboxAuditLogs).toHaveBeenCalledWith(undefined, 100);
  });

  // ---- Agent policy ----

  it("POST /sandbox/:agentId/policy creates and stores", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sandbox/a1/policy",
      payload: { allow: ["read"] },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().policy.agentId).toBe("a1");
    expect(res.json().policy.allow).toEqual(["read"]);
  });

  it("GET /sandbox/:agentId/policy returns the policy", async () => {
    await app.inject({
      method: "POST",
      url: "/sandbox/a2/policy",
      payload: { allow: ["x"] },
    });
    const res = await app.inject({ method: "GET", url: "/sandbox/a2/policy" });
    expect(res.json().policy.allow).toEqual(["x"]);
  });

  it("PUT /sandbox/:agentId/policy merges with existing", async () => {
    await app.inject({
      method: "POST",
      url: "/sandbox/a3/policy",
      payload: { allow: ["read"] },
    });
    const res = await app.inject({
      method: "PUT",
      url: "/sandbox/a3/policy",
      payload: { deny: ["write"] },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().policy.allow).toEqual(["read"]);
    expect(res.json().policy.deny).toEqual(["write"]);
  });

  it("PUT /sandbox/:agentId/policy returns ok=false for missing", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/sandbox/nonexistent/policy",
      payload: { x: 1 },
    });
    expect(res.json().ok).toBe(false);
  });

  // ---- Workspace sandbox (Round J1) ----

  it("GET /sandbox/workspaces returns empty list + default image initially", async () => {
    const res = await app.inject({ method: "GET", url: "/sandbox/workspaces" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workspaces: [],
      defaultImage: "webrain-workspace:latest",
    });
  });

  it("POST /sandbox/workspaces creates a workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sandbox/workspaces",
      payload: { workspaceId: "demo", network: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().workspace.workspaceId).toBe("demo");
    expect(res.json().workspace.network).toBe(true);
    expect(docker.ensureWorkspace).toHaveBeenCalledWith("demo", {
      image: undefined,
      memory: undefined,
      cpus: undefined,
      network: true,
    });
  });

  it("POST /sandbox/workspaces 400s without workspaceId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sandbox/workspaces",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });

  it("POST /sandbox/workspaces/:id/exec runs command in workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sandbox/workspaces/demo/exec",
      payload: { command: "echo hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().output).toBe("ws:demo:echo hi");
    expect(docker.execInWorkspace).toHaveBeenCalledWith("demo", "echo hi", { timeoutMs: undefined });
  });

  it("POST /sandbox/workspaces/:id/exec 400s without command", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sandbox/workspaces/demo/exec",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });

  it("DELETE /sandbox/workspaces/:id tears down workspace", async () => {
    await app.inject({
      method: "POST",
      url: "/sandbox/workspaces",
      payload: { workspaceId: "doomed" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: "/sandbox/workspaces/doomed",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(docker.removeWorkspace).toHaveBeenCalledWith("doomed");
  });

  it("workspaces endpoint reflects ensureWorkspace state", async () => {
    await app.inject({
      method: "POST",
      url: "/sandbox/workspaces",
      payload: { workspaceId: "ws1" },
    });
    await app.inject({
      method: "POST",
      url: "/sandbox/workspaces",
      payload: { workspaceId: "ws2", network: true },
    });
    const res = await app.inject({ method: "GET", url: "/sandbox/workspaces" });
    const ids = res.json().workspaces.map((w: { workspaceId: string }) => w.workspaceId);
    expect(ids).toEqual(expect.arrayContaining(["ws1", "ws2"]));
  });

  it("POST /sandbox/:agentId/session creates a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sandbox/a1/session",
      payload: {},
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().session.sessionId).toBe("s-1");
    expect(res.json().session.agentId).toBe("a1");
  });
});
