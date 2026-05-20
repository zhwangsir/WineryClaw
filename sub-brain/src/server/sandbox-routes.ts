/**
 * Sandbox routes — three related concerns that share the `/sandbox/*` prefix:
 *
 * 1) Docker one-shot sandbox (DockerSandbox dep):
 *    POST   /sandbox/execute              — run shell command in --rm container
 *    POST   /sandbox/python               — run python code (one-shot)
 *    GET    /sandbox/status               — Docker availability
 *
 * 2) Docker workspace sandbox (Round J1 — stateful):
 *    GET    /sandbox/workspaces                  — list active workspaces
 *    POST   /sandbox/workspaces                  — create/ensure workspace
 *    POST   /sandbox/workspaces/:id/exec         — run command in workspace
 *    DELETE /sandbox/workspaces/:id              — tear down workspace
 *
 * 3) Agent sandbox policy (AgentManager dep):
 *    GET    /sandbox/policies             — built-in policy presets
 *    GET    /sandbox/stats                — aggregate sandbox stats
 *    GET    /sandbox/audit                — audit logs (?agentId, ?limit)
 *    POST   /sandbox/:agentId/policy      — create policy for agent
 *    GET    /sandbox/:agentId/policy      — fetch agent's policy
 *    PUT    /sandbox/:agentId/policy      — update policy
 *    POST   /sandbox/:agentId/session     — create a sandbox session
 *
 * Literal-path routes (including /workspaces/*) register BEFORE /:agentId/*
 * so they win route matching.
 */

import type { FastifyInstance } from "fastify";
import type { DockerSandbox } from "../sandbox/docker-sandbox.js";
import type { AgentManager } from "../agent/agent-manager.js";

export interface SandboxRouteDeps {
  dockerSandbox: DockerSandbox;
  agentManager: AgentManager;
}

interface ExecuteBody {
  command?: string;
  inputFiles?: Record<string, string>;
}

interface PythonBody {
  code?: string;
}

interface AuditQuery {
  agentId?: string;
  limit?: string;
}

export function registerSandboxRoutes(app: FastifyInstance, deps: SandboxRouteDeps): void {
  // ---- Docker sandbox ----

  app.post("/sandbox/execute", async (request) => {
    const body = (request.body as ExecuteBody) ?? {};
    return deps.dockerSandbox.execute(String(body.command ?? ""), body.inputFiles);
  });

  app.post("/sandbox/python", async (request) => {
    const body = (request.body as PythonBody) ?? {};
    return deps.dockerSandbox.executePython(String(body.code ?? ""));
  });

  app.get("/sandbox/status", async () => ({
    available: deps.dockerSandbox.isAvailable(),
  }));

  // ---- Docker workspace sandbox (Round J1) ----
  // Literal /workspaces/* paths register BEFORE the /:agentId routes so
  // Fastify's static-first matcher gives them priority over the dynamic
  // segment.

  app.get("/sandbox/workspaces", async () => ({
    workspaces: deps.dockerSandbox.listWorkspaces(),
  }));

  app.post("/sandbox/workspaces", async (request, reply) => {
    const body = (request.body as {
      workspaceId?: string;
      image?: string;
      memory?: string;
      cpus?: number;
      network?: boolean;
    }) ?? {};
    if (!body.workspaceId) {
      reply.code(400);
      return { ok: false, error: "workspaceId required" };
    }
    const result = await deps.dockerSandbox.ensureWorkspace(body.workspaceId, {
      image: body.image,
      memory: body.memory,
      cpus: body.cpus,
      network: body.network,
    });
    if (!result.ok) reply.code(400);
    return result;
  });

  app.post("/sandbox/workspaces/:id/exec", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { command?: string; timeoutMs?: number }) ?? {};
    if (!body.command) {
      reply.code(400);
      return { ok: false, output: "", exitCode: -1, error: "command required" };
    }
    return deps.dockerSandbox.execInWorkspace(id, body.command, {
      timeoutMs: body.timeoutMs,
    });
  });

  app.delete("/sandbox/workspaces/:id", async (request) => {
    const { id } = request.params as { id: string };
    return deps.dockerSandbox.removeWorkspace(id);
  });

  // ---- Agent sandbox policy ----
  // Literal-path routes must come first to avoid being captured by /:agentId/*.

  app.get("/sandbox/policies", async () => ({
    policies: [],
  }));

  app.get("/sandbox/stats", async () => deps.agentManager.getSandboxStats());

  app.get("/sandbox/audit", async (request) => {
    const { agentId, limit } = request.query as AuditQuery;
    return {
      logs: deps.agentManager.getSandboxAuditLogs(
        agentId,
        limit ? parseInt(limit, 10) : 100,
      ),
    };
  });

  app.post("/sandbox/:agentId/policy", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const policy = deps.agentManager.createSandboxPolicy(
      agentId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (request.body as any) ?? {},
    );
    return { ok: true, policy };
  });

  app.get("/sandbox/:agentId/policy", async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { policy: deps.agentManager.getSandboxPolicy(agentId) };
  });

  app.put("/sandbox/:agentId/policy", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const policy = deps.agentManager.updateSandboxPolicy(
      agentId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (request.body as any) ?? {},
    );
    return { ok: !!policy, policy };
  });

  app.post("/sandbox/:agentId/session", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const session = deps.agentManager.createSandboxSession(agentId);
    return { ok: true, session };
  });
}
