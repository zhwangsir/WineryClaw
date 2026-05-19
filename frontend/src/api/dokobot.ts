import { api } from "./client";

export const dokobotApi = {
  status: () => api.get<{ available: boolean }>("/api/dokobot/status"),
  browse: (url: string, action?: string) => api.post("/api/dokobot/browse", { url, action }),
  search: (query: string) => api.post("/api/dokobot/search", { query }),
  screenshot: (url: string) => api.post<{ dataUrl?: string }>("/api/dokobot/screenshot", { url }),
};
