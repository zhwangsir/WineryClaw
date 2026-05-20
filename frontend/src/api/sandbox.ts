import { api } from "./client";

/** Round J1 — workspace shape (mirrors WorkspaceConfig in sub-brain). */
export interface SandboxWorkspace {
  workspaceId: string;
  image: string;
  memory: string;
  cpus: number;
  network: boolean;
  lastActiveAt: string;
  hostPath: string;
}

export interface WorkspaceExecResult {
  ok: boolean;
  output: string;
  exitCode: number;
  error?: string;
}

export const sandboxApi = {
  status: () => api.get<{ available: boolean }>("/api/sandbox/status"),
  stats: () => api.get<Record<string, number>>("/api/sandbox/stats"),
  audit: (agentId?: string, limit?: number) =>
    api
      .get<{
        logs: Array<{ agentId: string; action: string; timestamp: string; details?: Record<string, unknown> }>;
      }>(`/api/sandbox/audit?${agentId ? `agentId=${agentId}&` : ""}${limit ? `limit=${limit}` : ""}`)
      .then((r) => r.logs),
  execute: (command: string, inputFiles?: Record<string, string>) =>
    api.post<{ stdout: string; stderr: string; exitCode: number }>("/api/sandbox/execute", { command, inputFiles }),
  executePython: (code: string) =>
    api.post<{ stdout: string; stderr: string; exitCode: number }>("/api/sandbox/python", { code }),

  // ── Round J1 — stateful workspaces ────────────────────────────────
  /** Includes the resolved defaultImage (J2) so the UI can tell user
   *  whether they'll get ubuntu or the alpine fallback. */
  listWorkspaces: () => api.get<{ workspaces: SandboxWorkspace[]; defaultImage: string }>("/api/sandbox/workspaces"),
  createWorkspace: (opts: { workspaceId: string; image?: string; memory?: string; cpus?: number; network?: boolean }) =>
    api.post<{ ok: boolean; workspace?: SandboxWorkspace; error?: string }>("/api/sandbox/workspaces", opts),
  execInWorkspace: (workspaceId: string, command: string, timeoutMs?: number) =>
    api.post<WorkspaceExecResult>(`/api/sandbox/workspaces/${encodeURIComponent(workspaceId)}/exec`, {
      command,
      timeoutMs,
    }),
  removeWorkspace: (workspaceId: string) =>
    api.delete<{ ok: boolean; error?: string }>(`/api/sandbox/workspaces/${encodeURIComponent(workspaceId)}`),
};
