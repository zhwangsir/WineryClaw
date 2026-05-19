/**
 * Sandbox routes — two related concerns that share the `/sandbox/*` prefix:
 *
 * 1) Docker sandbox (DockerSandbox dep):
 *    POST   /sandbox/execute              — run shell command in a container
 *    POST   /sandbox/python               — run python code
 *    GET    /sandbox/status               — Docker availability
 *
 * 2) Agent sandbox policy (AgentManager dep):
 *    GET    /sandbox/policies             — built-in policy presets
 *    GET    /sandbox/stats                — aggregate sandbox stats
 *    GET    /sandbox/audit                — audit logs (?agentId, ?limit)
 *    POST   /sandbox/:agentId/policy      — create policy for agent
 *    GET    /sandbox/:agentId/policy      — fetch agent's policy
 *    PUT    /sandbox/:agentId/policy      — update policy
 *    POST   /sandbox/:agentId/session     — create a sandbox session
 *
 * Literal-path routes register BEFORE /:agentId/* so they win route matching.
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
