import { api } from "./client";
import type { AgentTemplate } from "./types";

export const templatesApi = {
  list: (category?: string, tag?: string) => {
    const qs = new URLSearchParams();
    if (category) qs.set("category", category);
    if (tag) qs.set("tag", tag);
    return api.get<{ templates: AgentTemplate[] }>(`/api/templates?${qs}`).then((r) => r.templates);
  },
  get: (id: string) => api.get<{ template: AgentTemplate }>(`/api/templates/${id}`).then((r) => r.template),
  create: (data: Partial<AgentTemplate>) =>
    api.post<{ template: AgentTemplate }>("/api/templates", data).then((r) => r.template),
  delete: (id: string) => api.delete(`/api/templates/${id}`),
  categories: () => api.get<{ categories: string[] }>("/api/templates/categories").then((r) => r.categories),
  tags: () => api.get<{ tags: string[] }>("/api/templates/tags").then((r) => r.tags),
  instantiate: (id: string, data: { name: string; workspaceId?: string; owner?: string; variables?: Record<string, string> }) =>
    api.post<{ agent: { id: string; name: string } }>(`/api/templates/${id}/instantiate`, data).then((r) => r.agent),
};
