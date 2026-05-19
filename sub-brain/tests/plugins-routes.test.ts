import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { resolve as pathResolve } from "path";
import { homedir } from "os";

import { registerPluginsRoutes } from "../src/server/plugins-routes.js";
import type { PluginLoader } from "../src/plugins/plugin-loader.js";

interface FakePlugin {
  id: string;
  enabled: boolean;
  manifest: { id: string; version: string };
}

function makeFakePluginLoader() {
  const plugins = new Map<string, FakePlugin>();

  const ldr = {
    load: vi.fn(async (id: string, _config?: Record<string, unknown>) => {
      const p: FakePlugin = { id, enabled: true, manifest: { id, version: "1.0.0" } };
      plugins.set(id, p);
      return { ok: true, plugin_id: id };
    }),
    unload: vi.fn(async (id: string) => {
      const ok = plugins.delete(id);
      return ok ? { ok: true } : { ok: false, error: "not loaded" };
    }),
    enable: vi.fn(async (id: string) => {
      const p = plugins.get(id);
      if (p) p.enabled = true;
    }),
    disable: vi.fn(async (id: string) => {
      const p = plugins.get(id);
      if (p) p.enabled = false;
    }),
    listPlugins: vi.fn(() => Array.from(plugins.values())),
    deletePlugin: vi.fn(async (id: string) => {
      const ok = plugins.delete(id);
      return ok ? { ok: true } : { ok: false, error: "not found" };
    }),
    getPluginManifest: vi.fn((id: string) => plugins.get(id)?.manifest),
    loadFromDisk: vi.fn(async (path: string, pluginId?: string) => ({
      ok: true,
      plugin_id: pluginId ?? `from-${path}`,
    })),
  };

  return { ldr, plugins };
}

describe("plugins routes", () => {
  let app: FastifyInstance;
  let ldr: ReturnType<typeof makeFakePluginLoader>["ldr"];

  beforeEach(async () => {
    const fake = makeFakePluginLoader();
    ldr = fake.ldr;
    app = Fastify();
    registerPluginsRoutes(app, { pluginLoader: ldr as unknown as PluginLoader });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /plugins/load delegates to PluginLoader.load", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/plugins/load",
      payload: { plugin_id: "p1", config: { k: "v" } },
    });
    expect(res.json()).toEqual({ ok: true, plugin_id: "p1" });
    expect(ldr.load).toHaveBeenCalledWith("p1", { k: "v" });
  });

  it("POST /plugins/unload forwards id", async () => {
    await app.inject({ method: "POST", url: "/plugins/load", payload: { plugin_id: "p1" } });
    const res = await app.inject({
      method: "POST",
      url: "/plugins/unload",
      payload: { plugin_id: "p1" },
    });
    expect(res.json()).toEqual({ ok: true });
  });

  it("POST /plugins/enable returns ok:true", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/plugins/enable",
      payload: { plugin_id: "p1" },
    });
    expect(res.json()).toEqual({ ok: true });
    expect(ldr.enable).toHaveBeenCalledWith("p1");
  });

  it("POST /plugins/disable returns ok:true", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/plugins/disable",
      payload: { plugin_id: "p1" },
    });
    expect(res.json()).toEqual({ ok: true });
    expect(ldr.disable).toHaveBeenCalledWith("p1");
  });

  it("GET /plugins returns list", async () => {
    await app.inject({ method: "POST", url: "/plugins/load", payload: { plugin_id: "p1" } });
    const res = await app.inject({ method: "GET", url: "/plugins" });
    expect(res.json().plugins).toHaveLength(1);
  });

  it("GET /plugins/list is the same shape (compat)", async () => {
    const r1 = await app.inject({ method: "GET", url: "/plugins" });
    const r2 = await app.inject({ method: "GET", url: "/plugins/list" });
    expect(r1.json()).toEqual(r2.json());
  });

  it("DELETE /plugins/:id removes", async () => {
    await app.inject({ method: "POST", url: "/plugins/load", payload: { plugin_id: "p1" } });
    const res = await app.inject({ method: "DELETE", url: "/plugins/p1" });
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /plugins/:id/manifest returns the manifest", async () => {
    await app.inject({ method: "POST", url: "/plugins/load", payload: { plugin_id: "p1" } });
    const res = await app.inject({ method: "GET", url: "/plugins/p1/manifest" });
    expect(res.json().ok).toBe(true);
    expect(res.json().manifest.id).toBe("p1");
  });

  it("POST /plugins/load-from-disk allows paths under cwd", async () => {
    const cwdPath = pathResolve(process.cwd(), "fake-plugin.mjs");
    const res = await app.inject({
      method: "POST",
      url: "/plugins/load-from-disk",
      payload: { path: cwdPath, plugin_id: "from-disk" },
    });
    expect(res.json().ok).toBe(true);
    expect(ldr.loadFromDisk).toHaveBeenCalledWith(cwdPath, "from-disk");
  });

  it("POST /plugins/load-from-disk allows paths under home", async () => {
    const homePath = pathResolve(homedir(), "my-plugin");
    const res = await app.inject({
      method: "POST",
      url: "/plugins/load-from-disk",
      payload: { path: homePath },
    });
    expect(res.json().ok).toBe(true);
  });

  it("POST /plugins/load-from-disk allows */plugins/* anywhere", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/plugins/load-from-disk",
      payload: { path: "/tmp/foo/plugins/x" },
    });
    expect(res.json().ok).toBe(true);
  });

  it("POST /plugins/load-from-disk rejects paths outside allowed roots with 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/plugins/load-from-disk",
      payload: { path: "/etc/passwd" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("not allowed");
  });

  it("POST /plugins/load-from-disk rejects missing/non-string path with 400", async () => {
    const r1 = await app.inject({ method: "POST", url: "/plugins/load-from-disk", payload: {} });
    expect(r1.statusCode).toBe(400);

    const r2 = await app.inject({
      method: "POST",
      url: "/plugins/load-from-disk",
      payload: { path: 123 },
    });
    expect(r2.statusCode).toBe(400);
  });

  it("POST /plugins/load-from-disk maps loader throws to 500", async () => {
    ldr.loadFromDisk.mockRejectedValueOnce(new Error("entry not found"));
    const res = await app.inject({
      method: "POST",
      url: "/plugins/load-from-disk",
      payload: { path: pathResolve(process.cwd(), "x.mjs") },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("entry not found");
  });
});
