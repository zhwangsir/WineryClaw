import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerEcosystemRoutes } from "../src/server/ecosystem-routes.js";
import type { EcosystemHub } from "../src/ecosystem/ecosystem-hub.js";

function makeFakeEcosystemHub() {
  const resources = new Map<string, { id: string; name: string; type: string; data: unknown; owner: string; sharedWith: string[] }>();

  const hub = {
    register: vi.fn(async (name: string, type: string, data: unknown, owner?: string) => {
      const id = `r-${resources.size + 1}`;
      resources.set(id, { id, name, type, data, owner: owner ?? "default", sharedWith: [] });
      return { ok: true, resource_id: id };
    }),
    share: vi.fn(async (id: string, target: string) => {
      const r = resources.get(id);
      if (!r) return { ok: false, error: "not found" };
      if (!r.sharedWith.includes(target)) r.sharedWith.push(target);
      return { ok: true };
    }),
    revoke: vi.fn(async (id: string, target: string) => {
      const r = resources.get(id);
      if (!r) return { ok: false, error: "not found" };
      r.sharedWith = r.sharedWith.filter((t) => t !== target);
      return { ok: true };
    }),
    deleteResource: vi.fn(async (id: string) => {
      const ok = resources.delete(id);
      return ok ? { ok: true } : { ok: false, error: "not found" };
    }),
    listResources: vi.fn(() => Array.from(resources.values())),
  };
  return { hub, resources };
}

describe("ecosystem routes", () => {
  let app: FastifyInstance;
  let hub: ReturnType<typeof makeFakeEcosystemHub>["hub"];

  beforeEach(async () => {
    const fake = makeFakeEcosystemHub();
    hub = fake.hub;
    app = Fastify();
    registerEcosystemRoutes(app, { ecosystemHub: hub as unknown as EcosystemHub });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /ecosystem/resources returns empty array initially", async () => {
    const res = await app.inject({ method: "GET", url: "/ecosystem/resources" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resources: [] });
  });

  it("POST /ecosystem/register creates a resource and returns id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ecosystem/register",
      payload: { name: "model-a", type: "model", data: { v: 1 }, owner: "alice" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.resource_id).toMatch(/^r-/);
    expect(hub.register).toHaveBeenCalledWith("model-a", "model", { v: 1 }, "alice");
  });

  it("POST /ecosystem/register omits owner → manager default applied", async () => {
    await app.inject({
      method: "POST",
      url: "/ecosystem/register",
      payload: { name: "x", type: "y", data: null },
    });
    expect(hub.register.mock.calls[0][3]).toBeUndefined();
  });

  it("POST /ecosystem/share adds target to sharedWith", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/ecosystem/register",
      payload: { name: "x", type: "y", data: null },
    });
    const id = reg.json().resource_id;
    const res = await app.inject({
      method: "POST",
      url: "/ecosystem/share",
      payload: { resource_id: id, target: "bob" },
    });
    expect(res.json().ok).toBe(true);
    const list = await app.inject({ method: "GET", url: "/ecosystem/resources" });
    expect(list.json().resources[0].sharedWith).toContain("bob");
  });

  it("POST /ecosystem/revoke removes target", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/ecosystem/register",
      payload: { name: "x", type: "y", data: null },
    });
    const id = reg.json().resource_id;
    await app.inject({
      method: "POST",
      url: "/ecosystem/share",
      payload: { resource_id: id, target: "bob" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/ecosystem/revoke",
      payload: { resource_id: id, target: "bob" },
    });
    expect(res.json().ok).toBe(true);
    const list = await app.inject({ method: "GET", url: "/ecosystem/resources" });
    expect(list.json().resources[0].sharedWith).not.toContain("bob");
  });

  it("POST /ecosystem/delete removes the resource", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/ecosystem/register",
      payload: { name: "x", type: "y", data: null },
    });
    const id = reg.json().resource_id;
    const del = await app.inject({
      method: "POST",
      url: "/ecosystem/delete",
      payload: { resource_id: id },
    });
    expect(del.json().ok).toBe(true);
    const list = await app.inject({ method: "GET", url: "/ecosystem/resources" });
    expect(list.json().resources).toEqual([]);
  });

  it("delete + share with unknown id returns ok=false", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/ecosystem/delete",
      payload: { resource_id: "nope" },
    });
    expect(a.json().ok).toBe(false);
    const b = await app.inject({
      method: "POST",
      url: "/ecosystem/share",
      payload: { resource_id: "nope", target: "x" },
    });
    expect(b.json().ok).toBe(false);
  });
});
