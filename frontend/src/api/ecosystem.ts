import { api } from "./client";

export interface EcosystemResource {
  id: string;
  name: string;
  type: string;
  data?: Record<string, unknown>;
  owner: string;
  sharedWith?: string[];
  createdAt: string;
}

export const ecosystemApi = {
  list: () => api.get<{ resources: EcosystemResource[] }>("/api/ecosystem/resources").then((r) => r.resources),
  register: (data: { name: string; type: string; data?: Record<string, unknown>; owner?: string }) =>
    api.post("/api/ecosystem/register", data),
  share: (resourceId: string, target: string) => api.post("/api/ecosystem/share", { resource_id: resourceId, target }),
  revoke: (resourceId: string, target: string) =>
    api.post("/api/ecosystem/revoke", { resource_id: resourceId, target }),
  delete: (resourceId: string) => api.post("/api/ecosystem/delete", { resource_id: resourceId }),
};
