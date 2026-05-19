import { api } from "./client";
import type { SystemHealth } from "./types";

export const systemApi = {
  health: () => api.get<SystemHealth>("/api/health"),
  metrics: () => api.get<Record<string, any>>("/brain/metrics"),
};
