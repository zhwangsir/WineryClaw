import { create } from "zustand";
import { message } from "antd";
import { channelsApi } from "../api/channels";
import type { ChannelInfo } from "../api/types";
import { createOptimisticDelete } from "./utils";

interface ChannelMessage {
  id: string;
  content: string;
  sender: string;
  timestamp: string;
}

interface ChannelState {
  channels: ChannelInfo[];
  messages: ChannelMessage[];
  loading: boolean;
  error: Error | null;

  fetchChannels: () => Promise<void>;
  fetchMessages: (channelId: string) => Promise<void>;
  connectChannel: (channel: string, config?: Record<string, unknown>) => Promise<void>;
  disconnectChannel: (channelId: string) => Promise<void>;
  toggleChannel: (id: string) => Promise<void>;
  deleteChannel: (id: string) => Promise<void>;
}

export const useChannelStore = create<ChannelState>((set, get) => ({
  channels: [],
  messages: [],
  loading: false,
  error: null,

  fetchChannels: async () => {
    if (get().loading) return;

    set({ loading: true, error: null });
    try {
      const list = await channelsApi.list();
      set({ channels: list, loading: false, error: null });
    } catch (e: any) {
      message.error(e.message || "获取通道列表失败");
      set({ loading: false, error: e });
    }
  },

  fetchMessages: async (channelId) => {
    try {
      const res = await channelsApi.messages(channelId);
      set({ messages: (res.messages || []) as ChannelMessage[] });
    } catch (e: any) {
      message.error(e.message || "获取消息失败");
    }
  },

  connectChannel: async (channel, config) => {
    try {
      await channelsApi.connect(channel, config);
      await get().fetchChannels();
    } catch (e: any) {
      message.error(e.message || "连接通道失败");
    }
  },

  disconnectChannel: async (channelId) => {
    const prev = get().channels;
    set((s) => ({
      channels: s.channels.map((c) => (c.id === channelId ? { ...c, connected: false } : c)),
    }));

    try {
      await channelsApi.disconnect(channelId);
      await get().fetchChannels();
    } catch (e: any) {
      message.error(e.message || "断开通道失败");
      set({ channels: prev });
    }
  },

  toggleChannel: async (id: string) => {
    const prev = get().channels;
    const ch = prev.find((c) => c.id === id);
    if (!ch) return;

    const nextConnected = !ch.connected;
    set((s) => ({
      channels: s.channels.map((c) => (c.id === id ? { ...c, connected: nextConnected } : c)),
    }));

    try {
      await channelsApi.toggle(id);
    } catch (e: any) {
      message.error(e.message || "切换通道状态失败");
      set({ channels: prev });
    }
  },

  deleteChannel: createOptimisticDelete<ChannelInfo>(
    get,
    set,
    "channels",
    channelsApi.delete,
    { successMsg: "通道已删除", errorMsg: "删除通道失败" }
  ),
}));
