import { api } from "./client";
import type { ChannelInfo } from "./types";

/** v2.30 — per-channel policy (M5.1). Optional fields, undefined = no constraint. */
export interface ChannelPolicy {
  agentId?: string;
  senderBlock?: string[];
  senderAllow?: string[];
  keywordBlock?: string[];
  keywordAllow?: string[];
  timeWindows?: { start: string; end: string; tz?: string }[];
  maxRepliesPerHour?: number;
  replyDelay?: { minMs: number; maxMs: number };
}

export interface PolicyAuditEntry {
  ts: string;
  channelId: string;
  sender: string;
  contentPreview: string;
  allowed: boolean;
  reason: string;
  delayMs: number;
}

export const channelsApi = {
  list: () => api.get<{ channels: ChannelInfo[] }>("/api/channels").then((r) => r.channels),
  connect: (channel: string, config: unknown) => api.post("/api/channels/connect", { channel, config }),
  disconnect: (channel_id: string) => api.post("/api/channels/disconnect", { channel_id }),
  toggle: (id: string) => api.post(`/api/channels/${id}/toggle`),
  health: (id: string) => api.get<{ ok: boolean; healthy: boolean }>(`/api/channels/${id}/health`),
  messages: (id: string) => api.get<{ messages: any[] }>(`/api/channels/${id}/messages`),
  startReceiving: (id: string) => api.post(`/api/channels/${id}/receive/start`),
  stopReceiving: (id: string) => api.post(`/api/channels/${id}/receive/stop`),
  delete: (id: string) => api.delete(`/api/channels/${id}`).then((r: any) => r.ok),
  // M5 — per-channel auto-reply toggle
  setAutoReply: (id: string, enabled: boolean) =>
    api.post<{ ok: boolean; auto_reply: boolean }>(`/api/channels/${id}/auto-reply`, { enabled }),
  // M5.1 (v2.30) — per-channel policy
  getPolicy: (id: string) => api.get<{ ok: boolean; policy: ChannelPolicy | null }>(`/api/channels/${id}/policy`),
  setPolicy: (id: string, policy: ChannelPolicy) =>
    api.put<{ ok: boolean; policy: ChannelPolicy; error?: string }>(`/api/channels/${id}/policy`, { policy }),
  clearPolicy: (id: string) => api.delete<{ ok: boolean; policy: null }>(`/api/channels/${id}/policy`),
  policyAudit: (id: string, limit = 50) =>
    api.get<{ ok: boolean; count: number; entries: PolicyAuditEntry[] }>(
      `/api/channels/${id}/policy/audit?limit=${limit}`
    ),
};
