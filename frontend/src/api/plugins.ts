import { api } from "./client";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  entry?: string;
  permissions?: string[];
  dependencies?: string[];
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  manifest: PluginManifest;
}

export const pluginsApi = {
  list: () => api.get<{ plugins: Plugin[] }>("/api/plugins/list").then((r) => r.plugins),
  enable: (plugin_id: string) => api.post("/api/plugins/enable", { plugin_id }),
  disable: (plugin_id: string) => api.post("/api/plugins/disable", { plugin_id }),
  unload: (plugin_id: string) => api.post("/api/plugins/unload", { plugin_id }),
  load: (plugin_id: string, config?: Record<string, unknown>) => api.post("/api/plugins/load", { plugin_id, config }),
  manifest: (id: string) => api.get<{ manifest: PluginManifest }>(`/api/plugins/${id}/manifest`).then((r) => r.manifest),
  delete: (id: string) => api.delete(`/api/plugins/${id}`).then((r: any) => r.ok),
};
