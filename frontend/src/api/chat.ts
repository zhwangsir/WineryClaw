import { api } from "./client";
import type { ChatMessage, RagSource, ToolCall } from "./types";

export const chatApi = {
  send: (text: string, sessionId: string, agentId: string, toolsEnabled = true) =>
    api
      .post<{ reply: string; tool_calls?: ToolCall[]; rag_sources?: RagSource[] }>("/brain/chat", {
        message: text,
        session_id: sessionId,
        agent_id: agentId,
        tools_enabled: toolsEnabled,
      })
      .then((r) => ({ reply: r.reply, toolCalls: r.tool_calls, ragSources: r.rag_sources })),
  stream: (text: string, sessionId: string, agentId: string, toolsEnabled = true) =>
    api.stream("/brain/chat/stream", { message: text, session_id: sessionId, agent_id: agentId, tools_enabled: toolsEnabled }),
  getHistory: (sessionId: string) =>
    api.get<{ messages: ChatMessage[] }>(`/brain/chat/history?session_id=${sessionId}`).then((r) => r.messages || []),
  getSessions: () =>
    api
      .get<{ sessions: { id: string; title: string; updatedAt: string }[] }>("/brain/chat/sessions")
      .then((r) => r.sessions || []),
  deleteSession: (sessionId: string) => api.delete(`/brain/chat/sessions/${sessionId}`),
};
