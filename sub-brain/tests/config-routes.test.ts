import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import axios from "axios";

import { registerConfigRoutes } from "../src/server/config-routes.js";
import type { ModelConfigManager } from "../src/config/model-config.js";
import type { LayeredConfigManager } from "../src/config/layered-config.js";

function makeFakeModelConfig() {
  let current = { endpoints: [], temperature: 0.7, maxTokens: 2048 };
  return {
    get: vi.fn(() => current),
    save: vi.fn((cfg: any) => {
      current = { ...current, ...cfg };
      return current;
    }),
    detect: vi.fn(async () => ({ ok: true, message: "detected" })),
    reset: vi.fn(() => {
      current = { endpoints: [], temperature: 0.7, maxTokens: 2048 };
      return current;
    }),
  };
}

function makeFakeLayered() {
  const global: any = { theme: "dark" };
  const workspaces = new Map<string, any>();
  const agents = new Map<string, any>();
  return {
    getGlobal: vi.fn(() => global),
    updateGlobal: vi.fn((upd: any) => Object.assign(global, upd)),
    listWorkspaces: vi.fn(() => Array.from(workspaces.values())),
    getWorkspace: vi.fn((id: string) => workspaces.get(id)),
    addWorkspace: vi.fn((w: any) => {
      const id = w.id ?? `ws-${workspaces.size + 1}`;
      const ws = { id, ...w };
      workspaces.set(id, ws);
      return ws;
    }),
    deleteWorkspace: vi.fn((id: string) => workspaces.delete(id)),
    listAgents: vi.fn((wsId?: string) => {
      const all = Array.from(agents.values());
      return wsId ? all.filter((a) => a.workspaceId === wsId) : all;
    }),
    getAgent: vi.fn((aid: string, wid?: string) => {
      const a = agents.get(aid);
      return a && (!wid || a.workspaceId === wid) ? a : undefined;
    }),
    addAgent: vi.fn((agent: any, wsId?: string) => {
      const id = agent?.id ?? `a-${agents.size + 1}`;
      const a = { id, workspaceId: wsId, ...agent };
      agents.set(id, a);
      return a;
    }),
  };
}

describe("config routes", () => {
  let app: FastifyInstance;
  let modelConfig: ReturnType<typeof makeFakeModelConfig>;
  let layered: ReturnType<typeof makeFakeLayered>;
  let axiosPostSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    modelConfig = makeFakeModelConfig();
    layered = makeFakeLayered();

    // Spy on axios.post so the main-brain reload notification doesn't actually fire.
    axiosPostSpy = vi.spyOn(axios, "post").mockResolvedValue({ data: {} } as any);

    app = Fastify();
    registerConfigRoutes(app, {
      modelConfig: modelConfig as unknown as ModelConfigManager,
      layeredConfig: layered as unknown as LayeredConfigManager,
      mainBrainUrl: "http://main-brain:18790",
      mainBrainAxiosConfig: () => ({ socketPath: "/tmp/test.sock" }),
    });
    await app.ready();
  });

  afterEach(async () => {
    axiosPostSpy.mockRestore();
    await app.close();
  });

  // ---- model ----

  it("GET /config/model returns current", async () => {
    const res = await app.inject({ method: "GET", url: "/config/model" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("endpoints");
  });

  it("POST /config/model with single endpoint normalizes shorthand", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/config/model",
      payload: { baseUrl: "http://x", modelId: "m", apiKey: "k" },
    });
    expect(res.json().ok).toBe(true);
    expect(modelConfig.save).toHaveBeenCalledWith({
      baseUrl: "http://x",
      modelId: "m",
      apiKey: "k",
      temperature: undefined,
      maxTokens: undefined,
    });
  });

  it("POST /config/model accepts snake_case endpoint fields", async () => {
    await app.inject({
      method: "POST",
      url: "/config/model",
      payload: {
        endpoints: [
          { name: "ep1", base_url: "http://a", model_id: "m1", api_key: "k1", priority: 5 },
        ],
      },
    });
    const arg = modelConfig.save.mock.calls[0][0];
    expect(arg.endpoints[0]).toEqual({
      name: "ep1",
      baseUrl: "http://a",
      modelId: "m1",
      apiKey: "k1",
      priority: 5,
      timeout: 120,
    });
  });

  it("POST /config/model applies defaults: priority=0, timeout=120, modelId=default", async () => {
    await app.inject({
      method: "POST",
      url: "/config/model",
      payload: { endpoints: [{ baseUrl: "http://only-url" }] },
    });
    const ep = modelConfig.save.mock.calls[0][0].endpoints[0];
    expect(ep.name).toBe("unnamed");
    expect(ep.modelId).toBe("default");
    expect(ep.priority).toBe(0);
    expect(ep.timeout).toBe(120);
  });

  it("POST /config/model notifies main-brain reload via axios.post", async () => {
    await app.inject({
      method: "POST",
      url: "/config/model",
      payload: { baseUrl: "http://x", modelId: "m" },
    });
    expect(axiosPostSpy).toHaveBeenCalledWith(
      "http://main-brain:18790/config/reload",
      {},
      expect.objectContaining({ timeout: 5000, socketPath: "/tmp/test.sock" }),
    );
  });

  it("POST /config/model swallows main-brain reload failure (non-fatal)", async () => {
    axiosPostSpy.mockRejectedValueOnce(new Error("main-brain down"));
    const res = await app.inject({
      method: "POST",
      url: "/config/model",
      payload: { baseUrl: "http://x", modelId: "m" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("POST /config/model/detect delegates", async () => {
    const res = await app.inject({ method: "POST", url: "/config/model/detect" });
    expect(res.json().ok).toBe(true);
    expect(modelConfig.detect).toHaveBeenCalled();
  });

  it("POST /config/model/reset returns reset config", async () => {
    const res = await app.inject({ method: "POST", url: "/config/model/reset" });
    expect(res.json().ok).toBe(true);
    expect(modelConfig.reset).toHaveBeenCalled();
  });

  // ---- layered ----

  it("GET /config/global returns global state", async () => {
    const res = await app.inject({ method: "GET", url: "/config/global" });
    expect(res.json()).toEqual({ theme: "dark" });
  });

  it("POST /config/global updates", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/config/global",
      payload: { theme: "light" },
    });
    expect(res.json().ok).toBe(true);
    expect(layered.updateGlobal).toHaveBeenCalledWith({ theme: "light" });
  });

  it("GET /config/workspaces returns list", async () => {
    const res = await app.inject({ method: "GET", url: "/config/workspaces" });
    expect(res.json()).toEqual({ ok: true, workspaces: [] });
  });

  it("POST /config/workspace creates one, then GET /config/workspace/:id fetches", async () => {
    await app.inject({
      method: "POST",
      url: "/config/workspace",
      payload: { id: "ws1", name: "Workspace 1" },
    });
    const res = await app.inject({ method: "GET", url: "/config/workspace/ws1" });
    expect(res.json().workspace.name).toBe("Workspace 1");
  });

  it("DELETE /config/workspace/:id removes", async () => {
    await app.inject({
      method: "POST",
      url: "/config/workspace",
      payload: { id: "ws1" },
    });
    const res = await app.inject({ method: "DELETE", url: "/config/workspace/ws1" });
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /config/workspace/:id/agents filters by workspace", async () => {
    const res = await app.inject({ method: "GET", url: "/config/workspace/ws1/agents" });
    expect(res.json()).toEqual({ ok: true, agents: [] });
    expect(layered.listAgents).toHaveBeenCalledWith("ws1");
  });

  it("POST /config/agent + GET /config/agent/:wid/:aid round-trip", async () => {
    await app.inject({
      method: "POST",
      url: "/config/agent",
      payload: { agent: { id: "a1" }, workspaceId: "ws1" },
    });
    const res = await app.inject({ method: "GET", url: "/config/agent/ws1/a1" });
    expect(res.json().agent.id).toBe("a1");
    expect(res.json().agent.workspaceId).toBe("ws1");
  });
});
