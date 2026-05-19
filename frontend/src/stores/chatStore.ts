import { create } from "zustand";
import { message } from "antd";
import { chatApi } from "../api/chat";
import { SSEClient } from "../api/sse-client";
import { StorageAdapter } from "../utils/storage";
import type { ChatMessage } from "../api/types";

const SESSION_KEY = "webrain-chat-session-id";

interface ChatState {
  messages: ChatMessage[];
  sessions: Array<{ id: string; title: string; updatedAt: string }>;
  currentSessionId: string;
  streaming: boolean;
  loading: boolean;
  toolEnabled: boolean;
  hasNewMessage: boolean;

  setMessages: (msgs: ChatMessage[]) => void;
  appendMessage: (msg: ChatMessage) => void;
  updateLastMessage: (updater: (msg: ChatMessage) => ChatMessage) => void;
  setStreaming: (v: boolean) => void;
  setToolEnabled: (v: boolean) => void;
  setHasNewMessage: (v: boolean) => void;
  sendMessage: (text: string, agentId?: string) => Promise<void>;
  sendStream: (text: string, agentId?: string) => Promise<void>;
  stopStream: () => void;
  fetchHistory: (sessionId: string) => Promise<void>;
  fetchSessions: () => Promise<void>;
  newSession: () => void;
  deleteSession: (sessionId: string) => Promise<void>;
  clearCurrentChat: () => void;
  init: () => Promise<void>;
}

let activeSseClient: SSEClient | null = null;

function getStoredSessionId(): string | null {
  return StorageAdapter.get<string | null>(SESSION_KEY, null);
}

function setStoredSessionId(id: string | null) {
  StorageAdapter.set(SESSION_KEY, id);
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  sessions: [],
  currentSessionId: getStoredSessionId() || `session-${Date.now()}`,
  streaming: false,
  loading: false,
  toolEnabled: true,
  hasNewMessage: false,

  setMessages: (msgs) => set({ messages: msgs }),
  appendMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateLastMessage: (updater) =>
    set((s) => {
      const msgs = [...s.messages];
      if (msgs.length > 0) msgs[msgs.length - 1] = updater(msgs[msgs.length - 1]);
      return { messages: msgs };
    }),
  setStreaming: (v) => set({ streaming: v }),
  setToolEnabled: (v) => set({ toolEnabled: v }),
  setHasNewMessage: (v) => set({ hasNewMessage: v }),

  sendMessage: async (text, agentId = "agent-default") => {
    const { currentSessionId, toolEnabled } = get();
    set({ loading: true });

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, userMsg] }));

    try {
      const res = await chatApi.send(text, currentSessionId, agentId, toolEnabled);
      const assistantMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: res.reply,
        toolCalls: res.toolCalls,
        ragSources: res.ragSources,
        plan: res.plan,
        timestamp: new Date().toISOString(),
      };
      set((s) => ({ messages: [...s.messages, assistantMsg], loading: false }));
    } catch (e: any) {
      message.error(e.message || "发送消息失败");
      set({ loading: false });
    }
  },

  sendStream: async (text, agentId = "agent-default") => {
    const { currentSessionId, toolEnabled } = get();
    set({ streaming: true, hasNewMessage: false });

    // Abort any previous stream
    if (activeSseClient) {
      activeSseClient.abort();
    }

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, userMsg] }));

    const assistantMsg: ChatMessage = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
      isStreaming: true,
      timestamp: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, assistantMsg] }));

    const sse = chatApi.stream(text, currentSessionId, agentId, toolEnabled);
    activeSseClient = sse.client;

    await sse.client.connect(
      sse.url,
      (chunk: any) => {
        if (chunk.type === "content") {
          set((s) => {
            const msgs = [...s.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, content: last.content + chunk.data };
            }
            return { messages: msgs };
          });
        } else if (chunk.type === "reasoning") {
          set((s) => {
            const msgs = [...s.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, reasoning: (last.reasoning || "") + chunk.data };
            }
            return { messages: msgs };
          });
        } else if (chunk.type === "rag_sources") {
          // Stream-side equivalent of res.ragSources for non-stream path —
          // backend yields this BEFORE first content chunk so the badge renders
          // immediately even while tokens are still streaming.
          set((s) => {
            const msgs = [...s.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, ragSources: chunk.data };
            }
            return { messages: msgs };
          });
        } else if (chunk.type === "plan") {
          // Backend emits the M2 plan before the first content chunk so the
          // task-list UI renders while tokens stream. See chat_engine.chat_stream.
          set((s) => {
            const msgs = [...s.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, plan: chunk.data };
            }
            return { messages: msgs };
          });
        }
      },
      () => {
        // onDone
        set((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant") {
            msgs[msgs.length - 1] = { ...last, isStreaming: false };
          }
          return { messages: msgs, streaming: false };
        });
        get().fetchSessions();
      },
      (err) => {
        // onError
        if (err.message.includes("aborted") || err.message.includes("AbortError")) {
          set((s) => {
            const msgs = [...s.messages];
            const last = msgs[msgs.length - 1];
            if (last?.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, isStreaming: false };
            }
            return { messages: msgs, streaming: false };
          });
        } else {
          message.error(err.message || "流式响应失败");
          set((s) => ({
            messages: s.messages.filter((m) => !(m.role === "assistant" && m.content === "" && m.isStreaming)),
            streaming: false,
          }));
        }
      }
    );

    activeSseClient = null;
  },

  stopStream: () => {
    if (activeSseClient) {
      activeSseClient.abort();
      activeSseClient = null;
    }
    set({ streaming: false });
  },

  fetchHistory: async (sessionId: string) => {
    try {
      const msgs = await chatApi.getHistory(sessionId);
      setStoredSessionId(sessionId);
      set({ messages: Array.isArray(msgs) ? msgs : [], currentSessionId: sessionId });
    } catch (e: any) {
      message.error(e.message || "加载历史失败");
    }
  },

  fetchSessions: async () => {
    try {
      const sessions = await chatApi.getSessions();
      set({ sessions: Array.isArray(sessions) ? sessions : [] });
    } catch (e: any) {
      console.error("[chatStore] fetchSessions failed:", e.message);
    }
  },

  newSession: () => {
    const newId = `session-${Date.now()}`;
    setStoredSessionId(newId);
    set({ currentSessionId: newId, messages: [] });
  },

  deleteSession: async (sessionId) => {
    try {
      await chatApi.deleteSession(sessionId);
      set((s) => ({
        sessions: s.sessions.filter((ses) => ses.id !== sessionId),
        messages: s.currentSessionId === sessionId ? [] : s.messages,
        currentSessionId: s.currentSessionId === sessionId ? `session-${Date.now()}` : s.currentSessionId,
      }));
    } catch (e: any) {
      message.error(e.message || "删除会话失败");
    }
  },

  clearCurrentChat: () => {
    set({ messages: [] });
  },

  init: async () => {
    await get().fetchSessions();
  },
}));
