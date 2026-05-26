import { api } from "./client";
import type { ChannelInfo } from "./types";

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
  // M5.1 — per-channel agent
  setAgentId: (id: string, agent_id: string) =>
    api.post<{ ok: boolean }>(`/api/channels/${id}/agent`, { agent_id }),
  // M5.1 — per-channel reply delay
  setReplyDelay: (id: string, delay_ms: number) =>
    api.post<{ ok: boolean }>(`/api/channels/${id}/reply-delay`, { delay_ms }),
};
