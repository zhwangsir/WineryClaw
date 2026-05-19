import { api } from "./client";

export const sandboxApi = {
  status: () => api.get<{ available: boolean }>("/api/sandbox/status"),
  stats: () => api.get<Record<string, number>>("/api/sandbox/stats"),
  audit: (agentId?: string, limit?: number) =>
    api.get<{ logs: Array<{ agentId: string; action: string; timestamp: string; details?: Record<string, unknown> }> }>(
      `/api/sandbox/audit?${agentId ? `agentId=${agentId}&` : ""}${limit ? `limit=${limit}` : ""}`
    ).then((r) => r.logs),
  execute: (command: string, inputFiles?: Record<string, string>) =>
    api.post<{ stdout: string; stderr: string; exitCode: number }>("/api/sandbox/execute", { command, inputFiles }),
  executePython: (code: string) =>
    api.post<{ stdout: string; stderr: string; exitCode: number }>("/api/sandbox/python", { code }),
};
