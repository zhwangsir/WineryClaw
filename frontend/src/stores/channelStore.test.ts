import { describe, it, expect, vi, beforeEach } from "vitest";
import { useChannelStore } from "./channelStore";

vi.mock("../api/channels", () => ({
  channelsApi: {
    list: vi.fn(),
    messages: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    toggle: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { channelsApi } from "../api/channels";
import { message } from "antd";

describe("channelStore", () => {
  beforeEach(() => {
    useChannelStore.setState({
      channels: [],
      messages: [],
      loading: false,
      error: null,
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useChannelStore.getState();
    expect(state.channels).toEqual([]);
    expect(state.messages).toEqual([]);
  });

  it("fetchChannels succeeds", async () => {
    const list = [{ id: "c1", name: "Ch1" }];
    vi.mocked(channelsApi.list).mockResolvedValue(list);
    await useChannelStore.getState().fetchChannels();
    expect(useChannelStore.getState().channels).toEqual(list);
  });

  it("fetchChannels skips when loading", async () => {
    useChannelStore.setState({ loading: true });
    await useChannelStore.getState().fetchChannels();
    expect(channelsApi.list).not.toHaveBeenCalled();
  });

  it("fetchChannels handles errors", async () => {
    vi.mocked(channelsApi.list).mockRejectedValue(new Error("fail"));
    await useChannelStore.getState().fetchChannels();
    expect(useChannelStore.getState().loading).toBe(false);
  });

  it("fetchChannels handles error without message", async () => {
    vi.mocked(channelsApi.list).mockRejectedValue(new Error(""));
    await useChannelStore.getState().fetchChannels();
    expect(message.error).toHaveBeenCalledWith("获取通道列表失败");
  });

  it("fetchMessages sets messages", async () => {
    vi.mocked(channelsApi.messages).mockResolvedValue({ messages: [{ id: "m1", content: "hi" }] });
    await useChannelStore.getState().fetchMessages("c1");
    expect(useChannelStore.getState().messages).toHaveLength(1);
  });

  it("fetchMessages falls back to empty array", async () => {
    vi.mocked(channelsApi.messages).mockResolvedValue({});
    await useChannelStore.getState().fetchMessages("c1");
    expect(useChannelStore.getState().messages).toEqual([]);
  });

  it("fetchMessages handles errors", async () => {
    vi.mocked(channelsApi.messages).mockRejectedValue(new Error("fail"));
    await useChannelStore.getState().fetchMessages("c1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("fetchMessages handles error without message", async () => {
    vi.mocked(channelsApi.messages).mockRejectedValue(new Error(""));
    await useChannelStore.getState().fetchMessages("c1");
    expect(message.error).toHaveBeenCalledWith("获取消息失败");
  });

  it("connectChannel succeeds and refetches", async () => {
    vi.mocked(channelsApi.connect).mockResolvedValue(undefined);
    vi.mocked(channelsApi.list).mockResolvedValue([{ id: "c1", connected: true }]);
    await useChannelStore.getState().connectChannel("discord", { token: "x" });
    expect(channelsApi.connect).toHaveBeenCalledWith("discord", { token: "x" });
  });

  it("connectChannel handles errors", async () => {
    vi.mocked(channelsApi.connect).mockRejectedValue(new Error("fail"));
    await useChannelStore.getState().connectChannel("discord");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("connectChannel handles error without message", async () => {
    vi.mocked(channelsApi.connect).mockRejectedValue(new Error(""));
    await useChannelStore.getState().connectChannel("discord");
    expect(message.error).toHaveBeenCalledWith("连接通道失败");
  });

  it("disconnectChannel optimistically updates then refetches", async () => {
    useChannelStore.setState({ channels: [{ id: "c1", connected: true }, { id: "c2", connected: true }] });
    vi.mocked(channelsApi.disconnect).mockResolvedValue(undefined);
    vi.mocked(channelsApi.list).mockResolvedValue([{ id: "c1", connected: false }, { id: "c2", connected: true }]);
    await useChannelStore.getState().disconnectChannel("c1");
    expect(channelsApi.disconnect).toHaveBeenCalledWith("c1");
    expect(useChannelStore.getState().channels[1].connected).toBe(true);
  });

  it("disconnectChannel rolls back on error", async () => {
    useChannelStore.setState({ channels: [{ id: "c1", connected: true }] });
    vi.mocked(channelsApi.disconnect).mockRejectedValue(new Error("fail"));
    await useChannelStore.getState().disconnectChannel("c1");
    expect(useChannelStore.getState().channels[0].connected).toBe(true);
  });

  it("disconnectChannel rolls back on error without message", async () => {
    useChannelStore.setState({ channels: [{ id: "c1", connected: true }] });
    vi.mocked(channelsApi.disconnect).mockRejectedValue(new Error(""));
    await useChannelStore.getState().disconnectChannel("c1");
    expect(message.error).toHaveBeenCalledWith("断开通道失败");
  });

  it("toggleChannel toggles optimistically", async () => {
    useChannelStore.setState({ channels: [{ id: "c1", connected: false }, { id: "c2", connected: false }] });
    vi.mocked(channelsApi.toggle).mockResolvedValue(undefined);
    await useChannelStore.getState().toggleChannel("c1");
    expect(useChannelStore.getState().channels[0].connected).toBe(true);
    expect(useChannelStore.getState().channels[1].connected).toBe(false);
  });

  it("toggleChannel does nothing if channel not found", async () => {
    await useChannelStore.getState().toggleChannel("missing");
    expect(channelsApi.toggle).not.toHaveBeenCalled();
  });

  it("toggleChannel rolls back on error", async () => {
    useChannelStore.setState({ channels: [{ id: "c1", connected: false }] });
    vi.mocked(channelsApi.toggle).mockRejectedValue(new Error("fail"));
    await useChannelStore.getState().toggleChannel("c1");
    expect(useChannelStore.getState().channels[0].connected).toBe(false);
  });

  it("toggleChannel rolls back on error without message", async () => {
    useChannelStore.setState({ channels: [{ id: "c1", connected: false }] });
    vi.mocked(channelsApi.toggle).mockRejectedValue(new Error(""));
    await useChannelStore.getState().toggleChannel("c1");
    expect(message.error).toHaveBeenCalledWith("切换通道状态失败");
  });

  it("deleteChannel removes item optimistically", async () => {
    useChannelStore.setState({ channels: [{ id: "c1" }, { id: "c2" }] });
    vi.mocked(channelsApi.delete).mockResolvedValue(undefined);
    await useChannelStore.getState().deleteChannel("c1");
    expect(useChannelStore.getState().channels).toHaveLength(1);
    expect(message.success).toHaveBeenCalledWith("通道已删除");
  });

  it("deleteChannel rolls back on error", async () => {
    useChannelStore.setState({ channels: [{ id: "c1" }] });
    vi.mocked(channelsApi.delete).mockRejectedValue(new Error("fail"));
    await useChannelStore.getState().deleteChannel("c1");
    expect(useChannelStore.getState().channels).toHaveLength(1);
  });

  it("deleteChannel rolls back on error without message", async () => {
    useChannelStore.setState({ channels: [{ id: "c1" }] });
    vi.mocked(channelsApi.delete).mockRejectedValue(new Error(""));
    await useChannelStore.getState().deleteChannel("c1");
    expect(message.error).toHaveBeenCalledWith("删除通道失败");
  });
});
