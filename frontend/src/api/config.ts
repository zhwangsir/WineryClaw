import { api } from "./client";
import type { ModelConfig, GlobalConfig } from "./types";

// Q14.8 (2026-05-21) — types realigned to what sub-brain actually returns
// from /api/config/workspaces (see sub-brain/src/config/layered-config.ts:
// WorkspaceConfig.workspaceId / AgentConfig.agentId). The previous shape
// (`id`, `createdAt`) was aspirational and never matched runtime, which
// caused ConfigPage's `v.slice(0, 12)` to crash on undefined.
export interface Workspace {
  workspaceId: string;
  name: string;
  description?: string;
  createdAt?: string; // optional — sub-brain doesn't currently populate it
}

export interface AgentConfig {
  agentId: string;
  name: string;
  workspaceId: string;
  modelConfig?: Record<string, unknown>;
}

export const configApi = {
  // Model config
  getModel: () => api.get<ModelConfig>("/api/config/model"),
  setModel: (config: Partial<ModelConfig>) => api.post("/api/config/model", config),
  detectModel: () => api.post<{ ok: boolean; message: string; details?: any }>("/api/config/model/detect"),
  resetModel: () => api.post<{ ok: boolean; config: ModelConfig }>("/api/config/model/reset"),
  // Global config
  getGlobal: () => api.get<GlobalConfig>("/api/config/global"),
  setGlobal: (config: Partial<GlobalConfig>) => api.post("/api/config/global", config),
  // Health
  health: () => api.get<{ endpoints: any[] }>("/api/health/models"),
  // Workspace / Agent config
  workspaces: () => api.get<{ workspaces: Workspace[] }>("/api/config/workspaces").then((r) => r.workspaces),
  workspace: (id: string) => api.get<{ workspace: Workspace }>(`/api/config/workspace/${id}`).then((r) => r.workspace),
  createWorkspace: (data: Partial<Workspace>) => api.post<{ workspace: Workspace }>("/api/config/workspace", data).then((r) => r.workspace),
  workspaceAgents: (id: string) => api.get<{ agents: AgentConfig[] }>(`/api/config/workspace/${id}/agents`).then((r) => r.agents),
  agent: (wid: string, aid: string) => api.get<{ agent: AgentConfig }>(`/api/config/agent/${wid}/${aid}`).then((r) => r.agent),
  createAgent: (data: { agent: Partial<AgentConfig>; workspaceId: string }) =>
    api.post<{ agent: AgentConfig }>("/api/config/agent", data).then((r) => r.agent),
  deleteWorkspace: (id: string) => api.delete(`/api/config/workspace/${id}`).then((r: any) => r.ok),
};
