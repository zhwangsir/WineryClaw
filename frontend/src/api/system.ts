import { api } from "./client";
import type { SystemHealth } from "./types";

export interface ProactiveInsight {
  id: string;
  title: string;
  content: string;
  category: string;
  type: "info" | "success" | "warning" | "error";
  read: boolean;
  createdAt: string;
}

export const systemApi = {
  health: () => api.get<SystemHealth>("/api/health"),
  metrics: () => api.get<Record<string, any>>("/brain/metrics"),
  proactiveInsights: () => api.get<{ insights: ProactiveInsight[] }>("/brain/proactive/insights"),
  markInsightRead: (id: string) => api.delete<{ ok: boolean }>(`/brain/proactive/insights/${id}`),
};
