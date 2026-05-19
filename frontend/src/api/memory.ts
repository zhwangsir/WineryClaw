import { api } from "./client";
import type { ConflictGroup, Memory, MemoryLineage } from "./types";

export const memoryApi = {
  list: (level?: string, limit = 50) =>
    api
      .get<{ memories: Memory[] }>(
        `/brain/memory/recent${level || limit !== 50 ? `?${new URLSearchParams({ ...(level ? { level } : {}), limit: String(limit) }).toString()}` : ""}`,
      )
      .then((r) => r.memories),
  store: (data: Partial<Memory>) => api.post<Memory>("/brain/memory/store", data),
  search: (query: string, levels?: string[]) =>
    api.post<{ results: Memory[] }>("/brain/memory/query", { query, levels }).then((r) => r.results),
  query: (query: string) =>
    api
      .post<{ results: Memory[] }>("/brain/memory/query", { query })
      .then((r) => ({ memories: r.results, entities: [] as unknown[], facts: [] as unknown[] })),
  delete: (id: string) =>
    api.delete<{ ok: boolean }>(`/brain/memory/${id}`).then((r) => r.ok),

  // M-Memory-1 endpoints
  /** List all L3 conflict groups (rows sharing a conflict_group UUID). */
  conflicts: () => api.get<{ groups: ConflictGroup[]; count: number }>("/brain/memory/conflicts"),
  /** User overrides which memory in a conflict group is "current". */
  markCurrent: (id: string) =>
    api.post<{ ok: boolean; current_id?: string; conflict_group?: string; error?: string }>(
      `/brain/memory/conflicts/${id}/mark-current`,
      {},
    ),
  /** Fetch a memory with one-level provenance lineage. */
  lineage: (id: string) => api.get<MemoryLineage>(`/brain/memory/${id}`),
  /** Manually trigger the dreaming consolidation cycle. */
  runDreaming: () => api.post<{ phases: unknown; timestamp: string }>("/brain/dreaming/run", {}),
};
