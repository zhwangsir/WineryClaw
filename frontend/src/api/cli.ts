import { api } from "./client";

export const cliApi = {
  status: () => api.get<{ text: string }>("/api/cli/status"),
  chat: (message: string, session_id?: string) =>
    api.post<{ reply: string }>("/api/cli/chat", { message, session_id }).then((r) => r.reply),
  exec: (tool: string, params?: Record<string, unknown>) =>
    api.post<{ result: unknown }>("/api/cli/exec", { tool, params }).then((r) => r.result),
};
