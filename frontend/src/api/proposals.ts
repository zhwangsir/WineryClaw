import { api } from "./client";

export interface Proposal {
  id: string;
  topic: string;
  description: string;
  proposerId: string;
  status: "open" | "closed" | "expired";
  quorum: number;
  votes: Array<{ agentId: string; vote: boolean; reason?: string }>;
  createdAt: string;
  closedAt?: string;
  result?: boolean;
}

export const proposalsApi = {
  list: (status?: string) =>
    api.get<{ proposals: Proposal[] }>(`/api/proposals${status ? `?status=${status}` : ""}`).then((r) => r.proposals),
  get: (id: string) => api.get<{ proposal: Proposal }>(`/api/proposals/${id}`).then((r) => r.proposal),
  create: (data: { proposerId: string; topic: string; description: string; quorum?: number; timeoutSec?: number }) =>
    api.post<{ proposal: Proposal }>("/api/proposals", data).then((r) => r.proposal),
  vote: (id: string, agentId: string, vote: boolean, reason?: string) =>
    api.post(`/api/proposals/${id}/vote`, { agentId, vote, reason }),
  close: (id: string) => api.post(`/api/proposals/${id}/close`, {}),
};
