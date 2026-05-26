import { api } from "./client";
import type { Agent, AgentToolConfig } from "./types";

export const agentsApi = {
  list: () => api.get<{ agents: Agent[] }>("/api/agents").then((r) => r.agents),
  get: (id: string) => api.get<{ agent: Agent }>(`/api/agents/${id}`).then((r) => r.agent),
  create: (data: Partial<Agent>) => api.post<{ agent: Agent }>("/api/agents", data).then((r) => r.agent),
  update: (id: string, data: Partial<Agent>) =>
    api.put<{ agent: Agent }>(`/api/agents/${id}`, data).then((r) => r.agent),
  delete: (id: string) => api.delete(`/api/agents/${id}`),
  run: (id: string, input: string) => api.post<{ result: string }>(`/api/agents/${id}/run`, { input }),

  // Agent file system
  getSystemPrompt: (id: string) =>
    api.get<{ ok: boolean; content: string }>(`/api/agents/${id}/system-prompt`).then((r) => r.content),
  updateSystemPrompt: (id: string, content: string) =>
    api.put<{ ok: boolean }>(`/api/agents/${id}/system-prompt`, { content }),
  getTools: (id: string) =>
    api.get<{ ok: boolean; tools: AgentToolConfig[] }>(`/api/agents/${id}/tools`).then((r) => r.tools),
  updateTools: (id: string, tools: AgentToolConfig[]) => api.put<{ ok: boolean }>(`/api/agents/${id}/tools`, { tools }),
};
