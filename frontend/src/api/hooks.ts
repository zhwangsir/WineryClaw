import { api } from "./client";

export const hooksApi = {
  registry: () => api.get<{ hooks: string[] }>("/api/hooks/registry").then((r) => r.hooks),
};
