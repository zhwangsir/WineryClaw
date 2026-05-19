import { api } from "./client";

export interface A2ATask {
  taskId: string;
  agentId: string;
  type: string;
  payload: Record<string, unknown>;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  result?: unknown;
  error?: string;
  createdAt: string;
}

export const a2aApi = {
  listTasks: () => api.get<{ tasks: A2ATask[] }>("/api/a2a/tasks").then((r) => r.tasks),
  sendTask: (senderId: string, receiverId: string, type: string, payload?: Record<string, unknown>) =>
    api.post<{ taskId: string; status: string }>("/api/a2a/task/send", { senderId, receiverId, type, payload }).then((r) => r),
  getTask: (taskId: string) => api.get<{ task: A2ATask }>(`/api/a2a/task/${taskId}`).then((r) => r.task),
};
