/**
 * Consensus / voting routes — proposals exchanged between agents.
 *
 *   POST   /proposals             — create a new proposal
 *   POST   /proposals/:id/vote    — cast a vote on a proposal
 *   GET    /proposals             — list (optional status query)
 *   GET    /proposals/:id         — fetch one
 *   POST   /proposals/:id/close   — close the proposal
 */

import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agent/agent-manager.js";

export interface ProposalRouteDeps {
  agentManager: AgentManager;
}

interface CreateProposalBody {
  proposerId?: string;
  topic?: string;
  description?: string;
  quorum?: number;
  timeoutSec?: number;
}

interface VoteBody {
  agentId?: string;
  vote?: string;
  reason?: string;
}

export function registerProposalsRoutes(
  app: FastifyInstance,
  deps: ProposalRouteDeps,
): void {
  app.post("/proposals", async (request) => {
    const body = (request.body as CreateProposalBody) ?? {};
    const proposal = deps.agentManager.createProposal(
      String(body.proposerId ?? ""),
      String(body.topic ?? ""),
      String(body.description ?? ""),
      typeof body.quorum === "number" ? body.quorum : 1,
      typeof body.timeoutSec === "number" ? body.timeoutSec : 300,
    );
    return { ok: true, proposal };
  });

  app.post("/proposals/:id/vote", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as VoteBody) ?? {};
    return deps.agentManager.vote(
      String(body.agentId ?? ""),
      id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body.vote as any,
      body.reason,
    );
  });

  app.get("/proposals", async (request) => {
    const { status } = request.query as { status?: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { proposals: deps.agentManager.listProposals(status as any) };
  });

  app.get("/proposals/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { proposal: deps.agentManager.getProposal(id) };
  });

  app.post("/proposals/:id/close", async (request) => {
    const { id } = request.params as { id: string };
    return deps.agentManager.closeProposal(id);
  });
}
