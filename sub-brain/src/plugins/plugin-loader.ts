/**
 * Plugin Loader — Manifest 验证 + 动态导入 + SQLite 持久化
 * Plugin loader and registry
 */

import { subBrainDB } from "../db/sub-brain-db.js";
import { existsSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { hookRegistry, type HookType } from "../plugin-sdk/hooks.js";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  entry?: string;
  permissions?: string[];
  dependencies?: string[];
  checksum?: string;
}

export interface LoadedPluginModule {
  initialize?: () => Promise<void>;
  destroy?: () => Promise<void>;
  manifest?: Partial<PluginManifest>;
  hooks?: Record<string, (...args: any[]) => Promise<any> | any>;
  tools?: Record<string, { description: string; parameters: Record<string, unknown>; execute: (...args: any[]) => Promise<any> }>;
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  manifest: PluginManifest;
  module?: LoadedPluginModule;
  initialize: () => Promise<void>;
  destroy: () => Promise<void>;
}

export class PluginLoader {
  private plugins = new Map<string, Plugin>();
  private db = subBrainDB.getDb();
  private pluginHookRegistrations = new Map<string, Array<{ type: HookType; handler: any }>>();

  private _registerHooks(pluginId: string, mod: LoadedPluginModule | undefined): void {
    if (!mod?.hooks) return;
    const tracked: Array<{ type: HookType; handler: any }> = [];
    for (const [type, handler] of Object.entries(mod.hooks)) {
      hookRegistry.register(type as HookType, handler);
      tracked.push({ type: type as HookType, handler });
    }
    if (tracked.length) this.pluginHookRegistrations.set(pluginId, tracked);
  }

  private _unregisterHooks(pluginId: string): void {
    const tracked = this.pluginHookRegistrations.get(pluginId);
    if (!tracked) return;
    for (const { type, handler } of tracked) {
      hookRegistry.unregister(type, handler);
    }
    this.pluginHookRegistrations.delete(pluginId);
  }

  async initialize(): Promise<void> {
    // Load persisted plugins and attempt to re-import their modules
    const rows = this.db.prepare("SELECT * FROM plugins").all() as any[];
    for (const row of rows) {
      const manifest = JSON.parse(row.manifest || "{}") as PluginManifest;
      let mod: LoadedPluginModule | undefined;

      // If plugin has an entry point, try to dynamically import it
      if (manifest.entry && existsSync(manifest.entry)) {
        try {
          mod = await this._importModule(manifest.entry);
          console.log(`[plugins] Re-imported module for ${row.id} from ${manifest.entry}`);
        } catch (err: any) {
          console.error(`[plugins] Failed to re-import ${row.id} from ${manifest.entry}:`, err.message);
        }
      }

      const plugin: Plugin = {
        id: row.id,
        name: row.name,
        version: row.version,
        enabled: !!row.enabled,
        manifest,
        module: mod,
        initialize: mod?.initialize || (async () => { console.log(`[plugin] ${row.id} initialized (no-op)`); }),
        destroy: mod?.destroy || (async () => { console.log(`[plugin] ${row.id} destroyed (no-op)`); }),
      };

      this.plugins.set(row.id, plugin);

      // Run initialize if enabled
      if (plugin.enabled) {
        try {
          await plugin.initialize();
          this._registerHooks(row.id, plugin.module);
        } catch (err: any) {
          console.error(`[plugins] Initialize failed for ${row.id}:`, err.message);
          plugin.enabled = false;
        }
      }
    }
    console.log(`[plugins] Loaded ${this.plugins.size} persisted plugins`);
  }

  async load(pluginId: string, config?: Record<string, unknown>): Promise<{ ok: boolean; plugin_id?: string; error?: string }> {
    if (this.plugins.has(pluginId)) {
      return { ok: false, error: `Plugin already loaded: ${pluginId}` };
    }

    // In production: dynamically import from plugins/ directory
    const manifest: PluginManifest = {
      id: pluginId,
      name: (config?.name as string) || pluginId,
      version: (config?.version as string) || "1.0.0",
      description: config?.description as string,
      entry: config?.entry as string,
      permissions: config?.permissions as string[],
      dependencies: config?.dependencies as string[],
      checksum: config?.checksum as string,
    };

    // Validate manifest
    const validation = this.validateManifest(manifest);
    if (!validation.valid) {
      return { ok: false, error: `Manifest validation failed: ${validation.errors.join(", ")}` };
    }

    // Check dependencies
    if (manifest.dependencies) {
      for (const dep of manifest.dependencies) {
        if (!this.plugins.has(dep)) {
          return { ok: false, error: `Missing dependency: ${dep}` };
        }
      }
    }

    // Try to dynamically import if entry is provided
    let mod: LoadedPluginModule | undefined;
    if (manifest.entry) {
      const resolvedPath = resolve(manifest.entry);
      if (!existsSync(resolvedPath)) {
        return { ok: false, error: `Plugin entry not found: ${resolvedPath}` };
      }
      try {
        mod = await this._importModule(resolvedPath);
        // Merge manifest from module if provided
        if (mod.manifest) {
          Object.assign(manifest, mod.manifest);
        }
      } catch (err: any) {
        return { ok: false, error: `Failed to import plugin module: ${err.message}` };
      }
    }

    const plugin: Plugin = {
      id: pluginId,
      name: manifest.name,
      version: manifest.version,
      enabled: true,
      manifest,
      module: mod,
      initialize: mod?.initialize || (async () => { console.log(`[plugin] ${pluginId} initialized`); }),
      destroy: mod?.destroy || (async () => { console.log(`[plugin] ${pluginId} destroyed`); }),
    };

    try {
      await plugin.initialize();
    } catch (err: any) {
      return { ok: false, error: `Plugin initialize failed: ${err.message}` };
    }

    this.plugins.set(pluginId, plugin);
    this._registerHooks(pluginId, plugin.module);

    // Persist
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO plugins (id, name, version, enabled, manifest, config, loaded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    stmt.run(pluginId, manifest.name, manifest.version, 1, JSON.stringify(manifest), JSON.stringify(config || {}), new Date().toISOString(), new Date().toISOString());

    return { ok: true, plugin_id: pluginId };
  }

  /**
   * Load a plugin directly from a file path on disk.
   * Creates the plugin ID from the directory name or manifest.
   */
  async loadFromDisk(pluginPath: string, pluginId?: string): Promise<{ ok: boolean; plugin_id?: string; error?: string }> {
    const resolvedPath = resolve(pluginPath);
    if (!existsSync(resolvedPath)) {
      return { ok: false, error: `Plugin path not found: ${resolvedPath}` };
    }

    let mod: LoadedPluginModule;
    try {
      mod = await this._importModule(resolvedPath);
    } catch (err: any) {
      return { ok: false, error: `Failed to import plugin from ${resolvedPath}: ${err.message}` };
    }

    const id = pluginId || mod.manifest?.id || `plugin-${Date.now()}`;

    if (this.plugins.has(id)) {
      return { ok: false, error: `Plugin already loaded: ${id}` };
    }

    const manifest: PluginManifest = {
      id,
      name: mod.manifest?.name || id,
      version: mod.manifest?.version || "1.0.0",
      description: mod.manifest?.description,
      entry: resolvedPath,
      permissions: mod.manifest?.permissions,
      dependencies: mod.manifest?.dependencies,
      checksum: mod.manifest?.checksum,
    };

    const validation = this.validateManifest(manifest);
    if (!validation.valid) {
      return { ok: false, error: `Manifest validation failed: ${validation.errors.join(", ")}` };
    }

    if (manifest.dependencies) {
      for (const dep of manifest.dependencies) {
        if (!this.plugins.has(dep)) {
          return { ok: false, error: `Missing dependency: ${dep}` };
        }
      }
    }

    const plugin: Plugin = {
      id,
      name: manifest.name,
      version: manifest.version,
      enabled: true,
      manifest,
      module: mod,
      initialize: mod.initialize || (async () => { console.log(`[plugin] ${id} initialized`); }),
      destroy: mod.destroy || (async () => { console.log(`[plugin] ${id} destroyed`); }),
    };

    try {
      await plugin.initialize();
    } catch (err: any) {
      return { ok: false, error: `Plugin initialize failed: ${err.message}` };
    }

    this.plugins.set(id, plugin);
    this._registerHooks(id, plugin.module);

    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO plugins (id, name, version, enabled, manifest, config, loaded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    stmt.run(id, manifest.name, manifest.version, 1, JSON.stringify(manifest), JSON.stringify({ entry: resolvedPath }), new Date().toISOString(), new Date().toISOString());

    return { ok: true, plugin_id: id };
  }

  private async _importModule(pluginPath: string): Promise<LoadedPluginModule> {
    const fileUrl = pathToFileURL(resolve(pluginPath)).href;
    // Force re-import by appending query param (busts import cache)
    const mod = await import(`${fileUrl}?t=${Date.now()}`);
    const exports = mod.default || mod;

    // Validate required exports
    if (typeof exports !== "object" && typeof exports !== "function") {
      throw new Error("Plugin must export an object or function");
    }

    const loaded: LoadedPluginModule = {};
    if (typeof exports.initialize === "function") loaded.initialize = exports.initialize;
    if (typeof exports.destroy === "function") loaded.destroy = exports.destroy;
    if (typeof exports.manifest === "object") loaded.manifest = exports.manifest;
    if (typeof exports.hooks === "object") loaded.hooks = exports.hooks;
    if (typeof exports.tools === "object") loaded.tools = exports.tools;

    return loaded;
  }

  validateManifest(manifest: PluginManifest): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!manifest.id) errors.push("missing id");
    if (!manifest.name) errors.push("missing name");
    if (!manifest.version) errors.push("missing version");
    if (!/^\d+\.\d+\.\d+/.test(manifest.version || "")) errors.push("invalid version format");
    return { valid: errors.length === 0, errors };
  }

  async unload(pluginId: string): Promise<{ ok: boolean; error?: string }> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return { ok: false, error: `Plugin not found: ${pluginId}` };
    }
    this._unregisterHooks(pluginId);
    try {
      await plugin.destroy();
    } catch (err: any) {
      console.error(`[plugins] Destroy failed for ${pluginId}:`, err.message);
    }
    this.plugins.delete(pluginId);

    const stmt = this.db.prepare("DELETE FROM plugins WHERE id = ?");
    stmt.run(pluginId);

    return { ok: true };
  }

  async deletePlugin(pluginId: string): Promise<{ ok: boolean; error?: string }> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return { ok: false, error: `Plugin not found: ${pluginId}` };
    }
    // Unload first
    const unloadResult = await this.unload(pluginId);
    if (!unloadResult.ok) {
      return { ok: false, error: unloadResult.error };
    }
    return { ok: true };
  }

  async enable(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      plugin.enabled = true;
      try {
        await plugin.initialize();
        this._registerHooks(pluginId, plugin.module);
      } catch (err: any) {
        console.error(`[plugins] Re-initialize failed for ${pluginId}:`, err.message);
        plugin.enabled = false;
      }
      const stmt = this.db.prepare("UPDATE plugins SET enabled = 1, updated_at = ? WHERE id = ?");
      stmt.run(new Date().toISOString(), pluginId);
    }
  }

  async disable(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      plugin.enabled = false;
      this._unregisterHooks(pluginId);
      try {
        await plugin.destroy();
      } catch (err: any) {
        console.error(`[plugins] Destroy failed for ${pluginId}:`, err.message);
      }
      const stmt = this.db.prepare("UPDATE plugins SET enabled = 0, updated_at = ? WHERE id = ?");
      stmt.run(new Date().toISOString(), pluginId);
    }
  }

  listPlugins(): Array<{ id: string; name: string; version: string; enabled: boolean; entry?: string; manifest?: any }> {
    return Array.from(this.plugins.values()).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      enabled: p.enabled,
      entry: p.manifest.entry,
      manifest: p.manifest,
    }));
  }

  getPluginManifest(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)?.manifest;
  }

  getPluginModule(pluginId: string): LoadedPluginModule | undefined {
    return this.plugins.get(pluginId)?.module;
  }
}
