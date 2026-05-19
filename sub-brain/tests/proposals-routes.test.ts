import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerProposalsRoutes } from "../src/server/proposals-routes.js";
import type { AgentManager } from "../src/agent/agent-manager.js";

function makeFakeAgentManager() {
  const proposals = new Map<string, any>();

  const mgr = {
    createProposal: vi.fn((proposerId: string, topic: string, description: string, quorum: number, timeoutSec: number) => {
      const id = `p-${proposals.size + 1}`;
      const p = { id, proposerId, topic, description, quorum, timeoutSec, status: "open", votes: [] };
      proposals.set(id, p);
      return p;
    }),
    vote: vi.fn((agentId: string, proposalId: string, vote: string, reason?: string) => {
      const p = proposals.get(proposalId);
      if (!p) return { ok: false, error: "not found" };
      p.votes.push({ agentId, vote, reason });
      return { ok: true, voteCount: p.votes.length };
    }),
    listProposals: vi.fn((status?: string) => {
      const all = Array.from(proposals.values());
      return status ? all.filter((p) => p.status === status) : all;
    }),
    getProposal: vi.fn((id: string) => proposals.get(id)),
    closeProposal: vi.fn((id: string) => {
      const p = proposals.get(id);
      if (!p) return { ok: false, error: "not found" };
      p.status = "closed";
      return { ok: true, proposal: p };
    }),
  };

  return { mgr, proposals };
}

describe("proposals routes", () => {
  let app: FastifyInstance;
  let mgr: ReturnType<typeof makeFakeAgentManager>["mgr"];

  beforeEach(async () => {
    const fake = makeFakeAgentManager();
    mgr = fake.mgr;
    app = Fastify();
    registerProposalsRoutes(app, { agentManager: mgr as unknown as AgentManager });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /proposals creates with explicit fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/proposals",
      payload: { proposerId: "a1", topic: "T", description: "D", quorum: 3, timeoutSec: 600 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.proposal.proposerId).toBe("a1");
    expect(mgr.createProposal).toHaveBeenCalledWith("a1", "T", "D", 3, 600);
  });

  it("POST /proposals defaults quorum=1, timeoutSec=300", async () => {
    await app.inject({
      method: "POST",
      url: "/proposals",
      payload: { proposerId: "a1", topic: "T", description: "D" },
    });
    expect(mgr.createProposal).toHaveBeenCalledWith("a1", "T", "D", 1, 300);
  });

  it("POST /proposals handles empty body without crashing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/proposals",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("POST /proposals/:id/vote forwards agentId / vote / reason", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/proposals",
      payload: { proposerId: "a1", topic: "T", description: "D" },
    });
    const id = create.json().proposal.id;
    const res = await app.inject({
      method: "POST",
      url: `/proposals/${id}/vote`,
      payload: { agentId: "a2", vote: "approve", reason: "looks good" },
    });
    expect(res.json().ok).toBe(true);
    expect(mgr.vote).toHaveBeenCalledWith("a2", id, "approve", "looks good");
  });

  it("GET /proposals lists all when no status query", async () => {
    await app.inject({
      method: "POST",
      url: "/proposals",
      payload: { proposerId: "a1", topic: "T1", description: "D" },
    });
    await app.inject({
      method: "POST",
      url: "/proposals",
      payload: { proposerId: "a1", topic: "T2", description: "D" },
    });
    const res = await app.inject({ method: "GET", url: "/proposals" });
    expect(res.json().proposals).toHaveLength(2);
  });

  it("GET /proposals?status=open filters", async () => {
    await app.inject({
      method: "POST",
      url: "/proposals",
      payload: { proposerId: "a1", topic: "T1", description: "D" },
    });
    const res = await app.inject({ method: "GET", url: "/proposals?status=closed" });
    expect(res.json().proposals).toEqual([]);
  });

  it("GET /proposals/:id returns single proposal", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/proposals",
      payload: { proposerId: "a1", topic: "T", description: "D" },
    });
    const id = create.json().proposal.id;
    const res = await app.inject({ method: "GET", url: `/proposals/${id}` });
    expect(res.json().proposal.id).toBe(id);
  });

  it("POST /proposals/:id/close closes the proposal", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/proposals",
      payload: { proposerId: "a1", topic: "T", description: "D" },
    });
    const id = create.json().proposal.id;
    const res = await app.inject({ method: "POST", url: `/proposals/${id}/close` });
    expect(res.json().ok).toBe(true);
    expect(res.json().proposal.status).toBe("closed");
  });
});
