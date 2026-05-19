/**
 * Plugin lifecycle + manifest routes.
 *
 *   POST   /plugins/load               — load by id + config
 *   POST   /plugins/unload             — unload (in-memory only)
 *   POST   /plugins/enable             — enable previously-disabled plugin
 *   POST   /plugins/disable            — disable but keep registered
 *   GET    /plugins                    — list all loaded plugins
 *   GET    /plugins/list               — compat alias for /plugins
 *   DELETE /plugins/:id                — remove plugin
 *   GET    /plugins/:id/manifest       — fetch manifest of one plugin
 *   POST   /plugins/load-from-disk     — load from filesystem path (with path guard)
 *
 * load-from-disk restricts paths: must be under cwd or home, or contain
 * "/plugins/" or "/extensions/" in the path. Prevents loading arbitrary
 * files via a network-reachable endpoint.
 */

import type { FastifyInstance } from "fastify";
import { resolve as pathResolve } from "path";
import { homedir } from "os";
import type { PluginLoader } from "../plugins/plugin-loader.js";

export interface PluginsRouteDeps {
  pluginLoader: PluginLoader;
}

interface LoadBody {
  plugin_id?: string;
  config?: Record<string, unknown>;
}

interface UnloadEnableDisableBody {
  plugin_id?: string;
}

interface LoadFromDiskBody {
  path?: string;
  plugin_id?: string;
}

export function registerPluginsRoutes(app: FastifyInstance, deps: PluginsRouteDeps): void {
  app.post("/plugins/load", async (request) => {
    const body = (request.body as LoadBody) ?? {};
    return deps.pluginLoader.load(String(body.plugin_id ?? ""), body.config);
  });

  app.post("/plugins/unload", async (request) => {
    const body = (request.body as UnloadEnableDisableBody) ?? {};
    return deps.pluginLoader.unload(String(body.plugin_id ?? ""));
  });

  app.post("/plugins/enable", async (request) => {
    const body = (request.body as UnloadEnableDisableBody) ?? {};
    await deps.pluginLoader.enable(String(body.plugin_id ?? ""));
    return { ok: true };
  });

  app.post("/plugins/disable", async (request) => {
    const body = (request.body as UnloadEnableDisableBody) ?? {};
    await deps.pluginLoader.disable(String(body.plugin_id ?? ""));
    return { ok: true };
  });

  const listHandler = async () => ({ plugins: deps.pluginLoader.listPlugins() });
  app.get("/plugins", listHandler);
  app.get("/plugins/list", listHandler); // compat

  // load-from-disk before /:id so the literal beats the param route.
  app.post("/plugins/load-from-disk", async (request, reply) => {
    try {
      const body = (request.body as LoadFromDiskBody) ?? {};
      const path = body.path;
      if (!path || typeof path !== "string") {
        return reply.code(400).send({ ok: false, error: "Invalid path" });
      }
      const resolved = pathResolve(path);
      const cwd = pathResolve(process.cwd());
      const home = pathResolve(homedir());
      // Allow paths under cwd, home, or explicit plugin directories only
      if (
        !resolved.startsWith(cwd) &&
        !resolved.startsWith(home) &&
        !resolved.includes("/plugins/") &&
        !resolved.includes("/extensions/")
      ) {
        return reply.code(403).send({ ok: false, error: "Path not allowed" });
      }
      return await deps.pluginLoader.loadFromDisk(path, body.plugin_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Plugin load failed";
      return reply.code(500).send({ ok: false, error: msg });
    }
  });

  app.delete("/plugins/:id", async (request) => {
    const { id } = request.params as { id: string };
    return deps.pluginLoader.deletePlugin(id);
  });

  app.get("/plugins/:id/manifest", async (request) => {
    const { id } = request.params as { id: string };
    return { ok: true, manifest: deps.pluginLoader.getPluginManifest(id) };
  });
}
