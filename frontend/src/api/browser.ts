import { api } from "./client";

export interface BrowserSession {
  id: string;
  url?: string;
  title?: string;
  createdAt: string;
}

export const browserApi = {
  launch: (headless?: boolean) => api.post<{ ok: boolean; error?: string }>("/api/browser/launch", { headless }),
  newPage: (url?: string) => api.post<{ ok: boolean; session?: BrowserSession; error?: string }>("/api/browser/page", { url }),
  navigate: (id: string, url: string) => api.post<{ ok: boolean; error?: string }>(`/api/browser/${id}/navigate`, { url }),
  click: (id: string, selector: string) => api.post<{ ok: boolean; error?: string }>(`/api/browser/${id}/click`, { selector }),
  type: (id: string, selector: string, text: string) => api.post<{ ok: boolean; error?: string }>(`/api/browser/${id}/type`, { selector, text }),
  screenshot: (id: string, fullPage?: boolean) => api.post<{ ok: boolean; dataUrl?: string; error?: string }>(`/api/browser/${id}/screenshot`, { fullPage }),
  sessions: () => api.get<{ sessions: BrowserSession[] }>("/api/browser/sessions").then((r) => r.sessions),
};
