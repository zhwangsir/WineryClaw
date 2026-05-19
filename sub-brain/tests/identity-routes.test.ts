import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerIdentityRoutes } from "../src/server/identity-routes.js";
import type { IdentityManager } from "../src/identity/identity-manager.js";

interface FakeUser {
  id: string;
  name: string;
  role: string;
  workspaces: string[];
}

function makeFakeIdentityManager() {
  const users = new Map<string, FakeUser>();

  const mgr = {
    listUsers: vi.fn(() => Array.from(users.values())),
    getUser: vi.fn((id: string) => users.get(id)),
    createUser: vi.fn(
      (name: string, role?: "admin" | "user" | "guest", workspaces?: string[]) => {
        const u: FakeUser = {
          id: `u-${users.size + 1}`,
          name,
          role: role ?? "user",
          workspaces: workspaces ?? ["default"],
        };
        users.set(u.id, u);
        return u;
      },
    ),
    hasWorkspaceAccess: vi.fn(
      (userId: string, workspaceId: string) =>
        users.get(userId)?.workspaces.includes(workspaceId) ?? false,
    ),
    deleteUser: vi.fn((id: string) => users.delete(id)),
  };

  return { mgr, users };
}

describe("identity routes", () => {
  let app: FastifyInstance;
  let mgr: ReturnType<typeof makeFakeIdentityManager>["mgr"];

  beforeEach(async () => {
    const fake = makeFakeIdentityManager();
    mgr = fake.mgr;
    app = Fastify();
    registerIdentityRoutes(app, { identityManager: mgr as unknown as IdentityManager });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /identity/users returns empty array initially", async () => {
    const res = await app.inject({ method: "GET", url: "/identity/users" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ users: [] });
  });

  it("POST /identity/user creates a user with provided fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/identity/user",
      payload: { name: "alice", role: "admin", workspaces: ["w1", "w2"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.user.name).toBe("alice");
    expect(body.user.role).toBe("admin");
    expect(body.user.workspaces).toEqual(["w1", "w2"]);
  });

  it("POST /identity/user falls back to IdentityManager defaults when role/workspaces omitted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/identity/user",
      payload: { name: "bob" },
    });
    expect(res.statusCode).toBe(200);
    // Verify the manager was called with undefined (so its defaults apply)
    const call = mgr.createUser.mock.calls[0];
    expect(call[0]).toBe("bob");
    expect(call[1]).toBeUndefined();
    expect(call[2]).toBeUndefined();
  });

  it("POST /identity/user handles empty body without crashing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/identity/user",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("GET /identity/user/:id returns the user when present", async () => {
    await app.inject({
      method: "POST",
      url: "/identity/user",
      payload: { name: "carol", role: "user" },
    });
    const res = await app.inject({ method: "GET", url: "/identity/user/u-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.user.name).toBe("carol");
  });

  it("GET /identity/user/:id returns ok=false for unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/identity/user/unknown" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });

  it("GET /identity/user/:id/workspaces/:ws reflects membership", async () => {
    await app.inject({
      method: "POST",
      url: "/identity/user",
      payload: { name: "dave", role: "user", workspaces: ["alpha"] },
    });
    const yes = await app.inject({
      method: "GET",
      url: "/identity/user/u-1/workspaces/alpha",
    });
    expect(yes.json()).toEqual({ ok: true, access: true });

    const no = await app.inject({
      method: "GET",
      url: "/identity/user/u-1/workspaces/beta",
    });
    expect(no.json()).toEqual({ ok: true, access: false });
  });

  it("DELETE /identity/user/:id removes the user", async () => {
    await app.inject({
      method: "POST",
      url: "/identity/user",
      payload: { name: "evan" },
    });
    const del = await app.inject({ method: "DELETE", url: "/identity/user/u-1" });
    expect(del.json()).toEqual({ ok: true });

    const after = await app.inject({ method: "GET", url: "/identity/user/u-1" });
    expect(after.json().ok).toBe(false);
  });

  it("DELETE /identity/user/:id returns ok=false for unknown id", async () => {
    const res = await app.inject({ method: "DELETE", url: "/identity/user/nope" });
    expect(res.json()).toEqual({ ok: false });
  });
});
