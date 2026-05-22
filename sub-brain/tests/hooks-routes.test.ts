/**
 * v2.12 — Hooks cross-process routes
 *
 * Validates that POST /hooks/llm/pre, /hooks/llm/post, /hooks/session/start,
 * /hooks/session/end correctly dispatch into HookRegistry instances.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { HookRegistry } from "../src/plugin-sdk/hooks.js";
import { registerHooksRoutes } from "../src/server/hooks-routes.js";

let app: FastifyInstance;
let registry: HookRegistry;

beforeEach(async () => {
  registry = new HookRegistry();
  app = Fastify({ logger: false });
  registerHooksRoutes(app, { hookRegistry: registry });
  await app.ready();
});

describe("POST /hooks/llm/pre", () => {
  it("returns allowed:true with empty hook list", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/hooks/llm/pre",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ allowed: true });
  });

  it("rejects with 400 when messages missing", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/hooks/llm/pre",
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().allowed).toBe(false);
  });

  it("invokes registered pre_llm_call hook", async () => {
    const seen: Array<Record<string, unknown>> = [];
    registry.register("pre_llm_call", async (ctx) => {
      seen.push({ messages: ctx.messages, agentId: ctx.agentId });
      return { allowed: true };
    });
    const r = await app.inject({
      method: "POST",
      url: "/hooks/llm/pre",
      payload: {
        messages: [{ role: "user", content: "test" }],
        agentId: "a1",
      },
    });
    expect(r.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].agentId).toBe("a1");
  });

  it("propagates allowed:false to short-circuit chat", async () => {
    registry.register("pre_llm_call", async () => ({
      allowed: false,
      reason: "policy",
    }));
    const r = await app.inject({
      method: "POST",
      url: "/hooks/llm/pre",
      payload: { messages: [{ role: "user", content: "x" }] },
    });
    const body = r.json();
    expect(body.allowed).toBe(false);
    expect(body.reason).toBe("policy");
  });

  it("hook throwing returns allow-through (chat path stays robust)", async () => {
    registry.register("pre_llm_call", async () => {
      throw new Error("buggy plugin");
    });
    const r = await app.inject({
      method: "POST",
      url: "/hooks/llm/pre",
      payload: { messages: [{ role: "user", content: "x" }] },
    });
    expect(r.json().allowed).toBe(true);
    expect(r.json().reason).toMatch(/hook-error/);
  });
});

describe("POST /hooks/llm/post", () => {
  it("returns ok:true on empty registry", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/hooks/llm/post",
      payload: { context: { messages: [] }, response: { ok: true } },
    });
    expect(r.json()).toMatchObject({ ok: true });
  });

  it("invokes registered post_llm_call with response", async () => {
    let captured: unknown = null;
    registry.register("post_llm_call", async (_ctx, response) => {
      captured = response;
      return { allowed: true };
    });
    await app.inject({
      method: "POST",
      url: "/hooks/llm/post",
      payload: {
        context: { messages: [{ role: "user", content: "x" }] },
        response: { id: "r1", content: "ok" },
      },
    });
    expect(captured).toMatchObject({ id: "r1", content: "ok" });
  });
});

describe("POST /hooks/session/{start,end}", () => {
  it("start invokes on_session_start", async () => {
    const seen: string[] = [];
    registry.register("on_session_start", async (sid) => {
      seen.push(sid);
    });
    const r = await app.inject({
      method: "POST",
      url: "/hooks/session/start",
      payload: { sessionId: "s1" },
    });
    expect(r.json()).toMatchObject({ ok: true });
    expect(seen).toEqual(["s1"]);
  });

  it("end invokes on_session_end", async () => {
    const seen: string[] = [];
    registry.register("on_session_end", async (sid) => {
      seen.push(sid);
    });
    const r = await app.inject({
      method: "POST",
      url: "/hooks/session/end",
      payload: { sessionId: "s2", meta: { reason: "user-closed" } },
    });
    expect(r.json()).toMatchObject({ ok: true });
    expect(seen).toEqual(["s2"]);
  });

  it("rejects without sessionId", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/hooks/session/start",
      payload: {},
    });
    expect(r.json().ok).toBe(false);
  });
});

describe("HOOK_STATUS surface", () => {
  it("pre_llm_call / post_llm_call are now wired", async () => {
    const { HOOK_STATUS } = await import("../src/plugin-sdk/hooks.js");
    expect(HOOK_STATUS.pre_llm_call).toBe("wired");
    expect(HOOK_STATUS.post_llm_call).toBe("wired");
    expect(HOOK_STATUS.on_session_start).toBe("wired");
    expect(HOOK_STATUS.on_session_end).toBe("wired");
  });

  it("v2.15: on_shutdown is now wired (Axis 2 8/8)", async () => {
    const { HOOK_STATUS } = await import("../src/plugin-sdk/hooks.js");
    expect(HOOK_STATUS.on_shutdown).toBe("wired");
  });
});

describe("POST /hooks/process/shutdown (v2.15)", () => {
  it("returns ok:true on empty registry", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/hooks/process/shutdown",
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
  });

  it("invokes registered on_shutdown hook", async () => {
    const seen: string[] = [];
    registry.register("on_shutdown", async () => {
      seen.push("called");
    });
    const r = await app.inject({
      method: "POST",
      url: "/hooks/process/shutdown",
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(seen).toEqual(["called"]);
  });

  it("hook throwing returns ok:false but doesn't 500", async () => {
    registry.register("on_shutdown", async () => {
      throw new Error("buggy plugin cleanup");
    });
    const r = await app.inject({
      method: "POST",
      url: "/hooks/process/shutdown",
      payload: {},
    });
    // The route handler returns ok:false with error string,
    // but Fastify still treats it as 200 (no throw).
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/buggy plugin/);
  });

  it("accepts empty body", async () => {
    // Different payload formats — all should work.
    const r1 = await app.inject({
      method: "POST",
      url: "/hooks/process/shutdown",
      payload: {},
    });
    expect(r1.statusCode).toBe(200);
  });

  it("multiple shutdown hooks run sequentially", async () => {
    const seen: string[] = [];
    registry.register("on_shutdown", async () => {
      seen.push("first");
    });
    registry.register("on_shutdown", async () => {
      seen.push("second");
    });
    await app.inject({
      method: "POST",
      url: "/hooks/process/shutdown",
      payload: {},
    });
    expect(seen).toEqual(["first", "second"]);
  });
});
