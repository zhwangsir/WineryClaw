import { api } from "./client";
import type { Memory } from "./types";

export const memoryApi = {
  list: () => api.get<{ memories: Memory[] }>("/brain/memory/recent").then((r) => r.memories),
  store: (data: Partial<Memory>) => api.post<Memory>("/brain/memory/store", data),
  search: (query: string, levels?: string[]) =>
    api.post<{ results: Memory[] }>("/brain/memory/query", { query, levels }).then((r) => r.results),
  query: (query: string) =>
    api.post<{ results: Memory[] }>("/brain/memory/query", { query }).then((r) => ({ memories: r.results, entities: [] as any[], facts: [] as any[] })),
  delete: (id: string) => api.delete(`/brain/memory/${id}`).then((r: any) => r.ok),
};
