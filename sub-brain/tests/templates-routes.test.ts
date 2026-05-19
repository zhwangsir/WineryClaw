import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerTemplatesRoutes } from "../src/server/templates-routes.js";
import type { AgentManager } from "../src/agent/agent-manager.js";

interface FakeTemplate {
  id: string;
  name: string;
  category: string;
  tags: string[];
  card?: { name: string; owner?: string; workspaceId?: string };
}

function makeFakeAgentManager() {
  const templates = new Map<string, FakeTemplate>();
  const agents: Array<Record<string, unknown>> = [];

  const mgr = {
    listTemplates: vi.fn((category?: string, tag?: string) => {
      let out = Array.from(templates.values());
      if (category) out = out.filter((t) => t.category === category);
      if (tag) out = out.filter((t) => t.tags.includes(tag));
      return out;
    }),
    getTemplate: vi.fn((id: string) => templates.get(id)),
    createTemplate: vi.fn((tpl: Partial<FakeTemplate>) => {
      const t: FakeTemplate = {
        id: `t-${templates.size + 1}`,
        name: tpl.name ?? "",
        category: tpl.category ?? "general",
        tags: tpl.tags ?? [],
        card: tpl.card,
      };
      templates.set(t.id, t);
      return t;
    }),
    deleteTemplate: vi.fn((id: string) => templates.delete(id)),
    instantiateTemplate: vi.fn((id: string, opts: { name?: string; workspaceId?: string; owner?: string; variables?: Record<string, unknown> }) => {
      const t = templates.get(id);
      if (!t) return { ok: false, error: "not found" };
      return {
        ok: true,
        card: {
          name: opts.name ?? t.name,
          owner: opts.owner ?? "default",
          workspaceId: opts.workspaceId ?? "default",
        },
      };
    }),
    createAgent: vi.fn((card: Record<string, unknown>) => {
      const a = { id: `a-${agents.length + 1}`, ...card };
      agents.push(a);
      return a;
    }),
    getTemplateCategories: vi.fn(() => Array.from(new Set(Array.from(templates.values()).map((t) => t.category)))),
    getTemplateTags: vi.fn(() => Array.from(new Set(Array.from(templates.values()).flatMap((t) => t.tags)))),
  };

  return { mgr, templates, agents };
}

describe("templates routes", () => {
  let app: FastifyInstance;
  let mgr: ReturnType<typeof makeFakeAgentManager>["mgr"];

  beforeEach(async () => {
    const fake = makeFakeAgentManager();
    mgr = fake.mgr;
    app = Fastify();
    registerTemplatesRoutes(app, { agentManager: mgr as unknown as AgentManager });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /templates returns empty initially", async () => {
    const res = await app.inject({ method: "GET", url: "/templates" });
    expect(res.json()).toEqual({ templates: [] });
  });

  it("GET /templates passes category + tag query to manager", async () => {
    await app.inject({ method: "GET", url: "/templates?category=devops&tag=ci" });
    expect(mgr.listTemplates).toHaveBeenCalledWith("devops", "ci");
  });

  it("GET /templates/categories returns the literal categories list (beats /:id)", async () => {
    const res = await app.inject({ method: "GET", url: "/templates/categories" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ categories: [] });
    // Critical: must not be intercepted as /templates/:id
    expect(res.json()).not.toHaveProperty("template");
  });

  it("GET /templates/tags returns the literal tags list", async () => {
    const res = await app.inject({ method: "GET", url: "/templates/tags" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tags: [] });
  });

  it("POST /templates creates and returns ok+template", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/templates",
      payload: { name: "tpl-a", category: "demo", tags: ["x"] },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().template.name).toBe("tpl-a");
  });

  it("GET /templates/:id after create returns the template", async () => {
    await app.inject({
      method: "POST",
      url: "/templates",
      payload: { name: "tpl-b" },
    });
    const res = await app.inject({ method: "GET", url: "/templates/t-1" });
    expect(res.json().template.name).toBe("tpl-b");
  });

  it("DELETE /templates/:id removes", async () => {
    await app.inject({
      method: "POST",
      url: "/templates",
      payload: { name: "tpl-c" },
    });
    const res = await app.inject({ method: "DELETE", url: "/templates/t-1" });
    expect(res.json()).toEqual({ ok: true });
  });

  it("DELETE /templates/:id returns ok=false for missing", async () => {
    const res = await app.inject({ method: "DELETE", url: "/templates/nope" });
    expect(res.json()).toEqual({ ok: false });
  });

  it("POST /templates/:id/instantiate creates an agent and returns fromTemplate", async () => {
    await app.inject({
      method: "POST",
      url: "/templates",
      payload: { name: "tpl-d" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/templates/t-1/instantiate",
      payload: { name: "my-agent", workspaceId: "w1", owner: "alice" },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().fromTemplate).toBe("t-1");
    expect(res.json().agent.id).toBe("a-1");
    expect(res.json().agent.owner).toBe("alice");
    expect(mgr.createAgent).toHaveBeenCalled();
  });

  it("POST /templates/:id/instantiate returns ok=false when template missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/templates/nonexistent/instantiate",
      payload: { name: "x" },
    });
    expect(res.json()).toEqual({ ok: false, error: "not found" });
    expect(mgr.createAgent).not.toHaveBeenCalled();
  });
});
