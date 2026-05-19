import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerToolsRoutes } from "../src/server/tools-routes.js";
import type { ToolExecutor } from "../src/tools/tool-executor.js";

function makeFakeToolExecutor() {
  const enabled = new Map<string, boolean>();
  let globalEnabled = true;

  const exec = {
    execute: vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === "boom") throw new Error("kaboom");
      return { ok: true, result: { tool: name, params } };
    }),
    listTools: vi.fn(() => [{ name: "echo", description: "x", enabled: true, category: "test" }]),
    enableTool: vi.fn((name: string) => enabled.set(name, true)),
    disableTool: vi.fn((name: string) => enabled.set(name, false)),
    setGlobalEnabled: vi.fn((v: boolean) => {
      globalEnabled = v;
    }),
    _enabled: enabled,
    _global: () => globalEnabled,
  };
  return exec;
}

describe("tools routes", () => {
  let app: FastifyInstance;
  let exec: ReturnType<typeof makeFakeToolExecutor>;

  beforeEach(async () => {
    exec = makeFakeToolExecutor();
    app = Fastify();
    registerToolsRoutes(app, { toolExecutor: exec as unknown as ToolExecutor });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /tools/execute delegates and returns result", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tools/execute",
      payload: { tool: "echo", params: { x: 1 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: { tool: "echo", params: { x: 1 } } });
    expect(exec.execute).toHaveBeenCalledWith("echo", { x: 1 });
  });

  it("POST /tools/execute returns 500 when underlying tool throws", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tools/execute",
      payload: { tool: "boom", params: {} },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toContain("kaboom");
  });

  it("POST /tools/execute defaults params to {} when omitted", async () => {
    await app.inject({
      method: "POST",
      url: "/tools/execute",
      payload: { tool: "echo" },
    });
    expect(exec.execute).toHaveBeenCalledWith("echo", {});
  });

  it("GET /tools returns the registry list", async () => {
    const res = await app.inject({ method: "GET", url: "/tools" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tools[0].name).toBe("echo");
  });

  it("GET /tools/list returns the same shape as /tools (compat)", async () => {
    const r1 = await app.inject({ method: "GET", url: "/tools" });
    const r2 = await app.inject({ method: "GET", url: "/tools/list" });
    expect(r1.json()).toEqual(r2.json());
  });

  it("POST /tools/enable flips the enabled flag", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tools/enable",
      payload: { tool: "echo" },
    });
    expect(res.json().ok).toBe(true);
    expect(exec._enabled.get("echo")).toBe(true);
  });

  it("POST /tools/disable flips the enabled flag", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tools/disable",
      payload: { tool: "echo" },
    });
    expect(res.json().ok).toBe(true);
    expect(exec._enabled.get("echo")).toBe(false);
  });

  it("POST /tools/global-toggle reflects the boolean", async () => {
    const off = await app.inject({
      method: "POST",
      url: "/tools/global-toggle",
      payload: { enabled: false },
    });
    expect(off.json()).toEqual({ ok: true, globalEnabled: false });
    expect(exec._global()).toBe(false);

    const on = await app.inject({
      method: "POST",
      url: "/tools/global-toggle",
      payload: { enabled: true },
    });
    expect(on.json().globalEnabled).toBe(true);
    expect(exec._global()).toBe(true);
  });

  it("POST /tools/global-toggle coerces non-boolean inputs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tools/global-toggle",
      payload: {},
    });
    // Boolean(undefined) → false
    expect(res.json().globalEnabled).toBe(false);
  });
});
