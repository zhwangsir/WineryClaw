import { describe, it, expect, vi, beforeEach } from "vitest";
import { useChatStore } from "./chatStore";

vi.mock("../api/chat", () => ({
  chatApi: {
    send: vi.fn(),
    stream: vi.fn(),
    getHistory: vi.fn(),
    getSessions: vi.fn(),
    deleteSession: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import { chatApi } from "../api/chat";
import { message } from "antd";

describe("chatStore", () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      sessions: [],
      currentSessionId: "test-session",
      streaming: false,
      loading: false,
      toolEnabled: true,
      hasNewMessage: false,
    });
    vi.mocked(chatApi.getSessions).mockResolvedValue([]);
    vi.mocked(chatApi.getHistory).mockResolvedValue([]);
    vi.mocked(chatApi.send).mockResolvedValue({ reply: "" });
    const mockSseClient = { connect: vi.fn(), abort: vi.fn(), close: vi.fn() };
    vi.mocked(chatApi.stream).mockReturnValue({ client: mockSseClient, url: "/api/chat/stream" });
  });

  it("has correct initial state", () => {
    const state = useChatStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.streaming).toBe(false);
    expect(state.toolEnabled).toBe(true);
  });

  it("newSession clears messages and generates new session id", () => {
    useChatStore.setState({ messages: [{ id: "1", role: "user", content: "hi", timestamp: "2024-01-01" }] });
    useChatStore.getState().newSession();
    const state = useChatStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.currentSessionId).toMatch(/^session-/);
  });

  it("setToolEnabled toggles tool state", () => {
    useChatStore.getState().setToolEnabled(false);
    expect(useChatStore.getState().toolEnabled).toBe(false);
  });

  it("fetchSessions fetches and stores sessions", async () => {
    const mockSessions = [{ id: "s1", title: "Hello", updatedAt: "2024-01-01" }];
    vi.mocked(chatApi.getSessions).mockResolvedValue(mockSessions);
    await useChatStore.getState().fetchSessions();
    expect(useChatStore.getState().sessions).toEqual(mockSessions);
  });

  it("fetchHistory fetches messages and sets current session", async () => {
    const mockMessages = [{ id: "m1", role: "user", content: "hi", timestamp: "2024-01-01" }];
    vi.mocked(chatApi.getHistory).mockResolvedValue(mockMessages);
    await useChatStore.getState().fetchHistory("session-abc");
    expect(useChatStore.getState().messages).toEqual(mockMessages);
    expect(useChatStore.getState().currentSessionId).toBe("session-abc");
  });

  it("deleteSession removes session from state", async () => {
    useChatStore.setState({
      sessions: [{ id: "s1", title: "T", updatedAt: "2024-01-01" }],
      currentSessionId: "other",
    });
    vi.mocked(chatApi.deleteSession).mockResolvedValue(undefined);
    await useChatStore.getState().deleteSession("s1");
    expect(useChatStore.getState().sessions).toEqual([]);
  });

  it("clearCurrentChat empties messages and removes stored session", () => {
    useChatStore.setState({ messages: [{ id: "1", role: "user", content: "hi", timestamp: "2024-01-01" }] });
    useChatStore.getState().clearCurrentChat();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("newSession generates new id and stores it", () => {
    const prevId = useChatStore.getState().currentSessionId;
    useChatStore.getState().newSession();
    const newId = useChatStore.getState().currentSessionId;
    expect(newId).not.toBe(prevId);
    expect(newId).toMatch(/^session-/);
  });

  it("init loads stored session history if session exists", async () => {
    // Pre-populate store with a known session
    const mockMessages = [{ id: "m1", role: "user", content: "hi", timestamp: "2024-01-01" }];
    vi.mocked(chatApi.getHistory).mockResolvedValue(mockMessages);

    useChatStore.setState({
      currentSessionId: "stored-session",
      sessions: [{ id: "stored-session", title: "Stored", updatedAt: "2024-01-01" }],
    });

    await useChatStore.getState().fetchHistory("stored-session");

    expect(useChatStore.getState().messages).toEqual(mockMessages);
    expect(useChatStore.getState().currentSessionId).toBe("stored-session");
  });

  it("sendMessage adds user and assistant messages", async () => {
    vi.mocked(chatApi.send).mockResolvedValue({ reply: "Hello back", toolCalls: [] });
    await useChatStore.getState().sendMessage("hi");
    const state = useChatStore.getState();
    expect(state.messages.length).toBe(2);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].content).toBe("hi");
    expect(state.messages[1].role).toBe("assistant");
    expect(state.messages[1].content).toBe("Hello back");
  });

  it("sendMessage handles errors gracefully", async () => {
    vi.mocked(chatApi.send).mockRejectedValue(new Error("Network error"));
    await useChatStore.getState().sendMessage("hi");
    const state = useChatStore.getState();
    expect(state.loading).toBe(false);
    expect(state.messages.length).toBe(1); // user msg remains
  });

  it("sendMessage handles error without message", async () => {
    vi.mocked(chatApi.send).mockRejectedValue(new Error(""));
    await useChatStore.getState().sendMessage("hi");
    expect(message.error).toHaveBeenCalledWith("发送消息失败");
  });

  it("sendStream sets streaming state and adds messages", async () => {
    const mockConnect = vi
      .fn()
      .mockImplementation((_url: string, onChunk: (chunk: any) => void, onDone: () => void) => {
        onChunk({ type: "content", data: "Hello" });
        onDone();
        return Promise.resolve();
      });
    const mockSseClient = { connect: mockConnect, abort: vi.fn(), close: vi.fn() };
    vi.mocked(chatApi.stream).mockReturnValue({ client: mockSseClient, url: "/api/chat/stream" });

    await useChatStore.getState().sendStream("hi");
    const state = useChatStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.messages.length).toBe(2);
    expect(state.messages[1].role).toBe("assistant");
  });

  it("stopStream aborts active stream", () => {
    useChatStore.setState({ streaming: true });
    useChatStore.getState().stopStream();
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it("sendStream aborts previous activeSseClient", async () => {
    const firstAbort = vi.fn();
    const firstConnect = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const firstClient = { connect: firstConnect, abort: firstAbort, close: vi.fn() };
    vi.mocked(chatApi.stream).mockReturnValueOnce({ client: firstClient, url: "/stream" });

    // Start first stream (hangs)
    const firstPromise = useChatStore.getState().sendStream("first");

    const secondConnect = vi.fn().mockImplementation((_url: string, _onChunk: any, onDone: () => void) => {
      onDone();
      return Promise.resolve();
    });
    const secondClient = { connect: secondConnect, abort: vi.fn(), close: vi.fn() };
    vi.mocked(chatApi.stream).mockReturnValueOnce({ client: secondClient, url: "/stream" });

    // Start second stream — should abort first
    await useChatStore.getState().sendStream("second");
    expect(firstAbort).toHaveBeenCalled();
    // Clean up hanging promise
    firstClient.connect.mockClear();
  });

  it("stopStream aborts activeSseClient when present", async () => {
    const abortFn = vi.fn();
    const connectFn = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const client = { connect: connectFn, abort: abortFn, close: vi.fn() };
    vi.mocked(chatApi.stream).mockReturnValue({ client, url: "/stream" });

    useChatStore.getState().sendStream("hi"); // start but don't await
    useChatStore.getState().stopStream();
    expect(abortFn).toHaveBeenCalled();
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it("appendMessage adds message", () => {
    useChatStore.getState().appendMessage({ id: "m1", role: "user", content: "hi", timestamp: "2024-01-01" });
    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it("updateLastMessage updates last message", () => {
    useChatStore.setState({ messages: [{ id: "m1", role: "assistant", content: "h", timestamp: "2024-01-01" }] });
    useChatStore.getState().updateLastMessage((msg) => ({ ...msg, content: msg.content + "i" }));
    expect(useChatStore.getState().messages[0].content).toBe("hi");
  });

  it("setMessages replaces messages", () => {
    useChatStore.getState().setMessages([{ id: "m1", role: "user", content: "hi", timestamp: "2024-01-01" }]);
    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it("setStreaming updates state", () => {
    useChatStore.getState().setStreaming(true);
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it("setHasNewMessage updates state", () => {
    useChatStore.getState().setHasNewMessage(true);
    expect(useChatStore.getState().hasNewMessage).toBe(true);
  });

  it("sendStream handles reasoning chunks", async () => {
    const mockConnect = vi
      .fn()
      .mockImplementation((_url: string, onChunk: (chunk: any) => void, onDone: () => void) => {
        onChunk({ type: "reasoning", data: "thinking..." });
        onDone();
        return Promise.resolve();
      });
    const mockSseClient = { connect: mockConnect, abort: vi.fn() };
    vi.mocked(chatApi.stream).mockReturnValue({ client: mockSseClient, url: "/stream" });
    await useChatStore.getState().sendStream("hi");
    expect(useChatStore.getState().messages[1].reasoning).toBe("thinking...");
  });

  it("sendStream handles abort error", async () => {
    const mockConnect = vi
      .fn()
      .mockImplementation((_url: string, _onChunk: any, _onDone: any, onError: (err: Error) => void) => {
        onError(new Error("Connection aborted"));
        return Promise.resolve();
      });
    const mockSseClient = { connect: mockConnect, abort: vi.fn() };
    vi.mocked(chatApi.stream).mockReturnValue({ client: mockSseClient, url: "/stream" });
    await useChatStore.getState().sendStream("hi");
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it("sendStream aborts previous stream", async () => {
    const abortSpy = vi.fn();
    const mockConnect = vi.fn().mockImplementation(() => new Promise(() => {}));
    const mockSseClient = { connect: mockConnect, abort: abortSpy };
    vi.mocked(chatApi.stream).mockReturnValue({ client: mockSseClient, url: "/stream" });
    useChatStore.getState().sendStream("hi");
    const mockSseClient2 = { connect: vi.fn().mockImplementation(() => new Promise(() => {})), abort: vi.fn() };
    vi.mocked(chatApi.stream).mockReturnValue({ client: mockSseClient2, url: "/stream2" });
    useChatStore.getState().sendStream("hello");
    expect(abortSpy).toHaveBeenCalled();
  });

  it("sendStream handles non-abort error", async () => {
    const mockConnect = vi
      .fn()
      .mockImplementation((_url: string, _onChunk: any, _onDone: any, onError: (err: Error) => void) => {
        onError(new Error("network fail"));
        return Promise.resolve();
      });
    const mockSseClient = { connect: mockConnect, abort: vi.fn() };
    vi.mocked(chatApi.stream).mockReturnValue({ client: mockSseClient, url: "/stream" });
    await useChatStore.getState().sendStream("hi");
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it("fetchHistory handles errors", async () => {
    vi.mocked(chatApi.getHistory).mockRejectedValue(new Error("fail"));
    await useChatStore.getState().fetchHistory("s1");
    expect(useChatStore.getState().loading).toBe(false);
  });

  it("fetchHistory handles non-array response", async () => {
    vi.mocked(chatApi.getHistory).mockResolvedValue(null as any);
    await useChatStore.getState().fetchHistory("s1");
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("fetchHistory handles error without message", async () => {
    vi.mocked(chatApi.getHistory).mockRejectedValue(new Error(""));
    await useChatStore.getState().fetchHistory("s1");
    expect(message.error).toHaveBeenCalledWith("加载历史失败");
  });

  it("fetchSessions handles errors", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(chatApi.getSessions).mockRejectedValue(new Error("fail"));
    await useChatStore.getState().fetchSessions();
    expect(useChatStore.getState().sessions).toEqual([]);
    consoleSpy.mockRestore();
  });

  it("fetchSessions handles non-array response", async () => {
    vi.mocked(chatApi.getSessions).mockResolvedValue(null as any);
    await useChatStore.getState().fetchSessions();
    expect(useChatStore.getState().sessions).toEqual([]);
  });

  it("deleteSession handles errors", async () => {
    vi.mocked(chatApi.deleteSession).mockRejectedValue(new Error("fail"));
    await useChatStore.getState().deleteSession("s1");
    expect(useChatStore.getState().loading).toBe(false);
  });

  it("deleteSession handles error without message", async () => {
    vi.mocked(chatApi.deleteSession).mockRejectedValue(new Error(""));
    await useChatStore.getState().deleteSession("s1");
    expect(message.error).toHaveBeenCalledWith("删除会话失败");
  });

  it("deleteSession keeps messages when different session", async () => {
    useChatStore.setState({
      sessions: [{ id: "s1" }, { id: "s2" }] as any,
      currentSessionId: "s2",
      messages: [{ id: "m1" }] as any,
    });
    vi.mocked(chatApi.deleteSession).mockResolvedValue(undefined);
    await useChatStore.getState().deleteSession("s1");
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().currentSessionId).toBe("s2");
  });

  it("deleteSession clears messages and changes session when current", async () => {
    useChatStore.setState({ sessions: [{ id: "s1" }] as any, currentSessionId: "s1", messages: [{ id: "m1" }] as any });
    vi.mocked(chatApi.deleteSession).mockResolvedValue(undefined);
    await useChatStore.getState().deleteSession("s1");
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().currentSessionId).not.toBe("s1");
  });

  it("init fetches sessions", async () => {
    vi.mocked(chatApi.getSessions).mockResolvedValue([{ id: "s1", title: "T", updatedAt: "2024-01-01" }]);
    await useChatStore.getState().init();
    expect(useChatStore.getState().sessions).toHaveLength(1);
  });
});
