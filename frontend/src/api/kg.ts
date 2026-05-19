import { api } from "./client";
import type { KgEntity, KgRelation } from "./types";

export const kgApi = {
  listEntities: (entityType?: string, limit = 100) =>
    api
      .get<{ entities: KgEntity[] }>("/brain/kg/entities", { params: { entity_type: entityType, limit } })
      .then((r) => r.entities),
  getEntity: (eid: string) => api.get<{ entity: KgEntity; relations: KgRelation[] }>(`/brain/kg/entities/${eid}`),
  addEntity: (data: {
    name: string;
    type?: string;
    description?: string;
    properties?: Record<string, unknown>;
    source?: string;
    confidence?: number;
  }) => api.post<{ ok: boolean; entity_id: string }>("/brain/kg/entities", data),
  addRelation: (data: {
    source_id: string;
    target_id: string;
    type: string;
    properties?: Record<string, unknown>;
    confidence?: number;
  }) => api.post<{ ok: boolean; relation_id: string }>("/brain/kg/relations", data),
  search: (q: string, limit = 10) =>
    api.get<{ results: any[] }>("/brain/kg/search", { params: { q, limit } }).then((r) => r.results),
  subgraph: (centerId: string, depth = 2) =>
    api.get<any>("/brain/kg/subgraph", { params: { center_id: centerId, depth } }),
  extract: (text: string) => api.post<any>("/brain/kg/extract", { text }),
  stats: () => api.get<any>("/brain/kg/stats"),
  deleteEntity: (id: string) => api.delete(`/brain/kg/entities/${id}`).then((r: any) => r.ok),
  deleteRelation: (id: string) => api.delete(`/brain/kg/relations/${id}`).then((r: any) => r.ok),
};
