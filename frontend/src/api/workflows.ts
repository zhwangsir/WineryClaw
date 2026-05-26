import { api } from "./client";
import type { WorkflowDef, WorkflowRun } from "./types";

export const workflowsApi = {
  list: (workspaceId?: string) =>
    api
      .get<{ workflows: WorkflowDef[] }>(`/api/workflows${workspaceId ? `?workspaceId=${workspaceId}` : ""}`)
      .then((r) => r.workflows),
  get: (id: string) => api.get<{ workflow: WorkflowDef }>(`/api/workflows/${id}`).then((r) => r.workflow),
  create: (data: Partial<WorkflowDef>) => api.post<WorkflowDef>("/api/workflows", data).then((r) => r),
  update: (id: string, data: Partial<WorkflowDef>) => api.put<WorkflowDef>(`/api/workflows/${id}`, data).then((r) => r),
  delete: (id: string) => api.delete(`/api/workflows/${id}`),
  validate: (id: string) =>
    api.get<{ valid: boolean; errors?: string[] }>(`/api/workflows/${id}/validate`).then((r) => r),
  run: (id: string, inputs?: Record<string, unknown>) =>
    api.post<{ run: WorkflowRun }>(`/api/workflows/${id}/run`, { inputs }).then((r) => r.run),
  runs: (id: string, status?: string) =>
    api
      .get<{ runs: WorkflowRun[] }>(`/api/workflows/${id}/runs${status ? `?status=${status}` : ""}`)
      .then((r) => r.runs),
};
