import { api } from "./client";
import type { ChatMessage, ChatPlan, RagSource, ToolCall } from "./types";

export const chatApi = {
  send: (text: string, sessionId: string, agentId: string, toolsEnabled = true) =>
    api
      .post<{
        reply: string;
        tool_calls?: ToolCall[];
        rag_sources?: RagSource[];
        plan?: ChatPlan | null;
      }>("/brain/chat", {
        message: text,
        session_id: sessionId,
        agent_id: agentId,
        tools_enabled: toolsEnabled,
      })
      .then((r) => ({
        reply: r.reply,
        toolCalls: r.tool_calls,
        ragSources: r.rag_sources,
        plan: r.plan ?? undefined,
      })),
  stream: (text: string, sessionId: string, agentId: string, toolsEnabled = true) =>
    api.stream("/brain/chat/stream", { message: text, session_id: sessionId, agent_id: agentId, tools_enabled: toolsEnabled }),
  getHistory: (sessionId: string) =>
    api.get<{ messages: ChatMessage[] }>(`/brain/chat/history?session_id=${sessionId}`).then((r) => r.messages || []),
  getSessions: () =>
    api
      .get<{ sessions: { id: string; title: string; updatedAt: string }[] }>("/brain/chat/sessions")
      .then((r) => r.sessions || []),
  deleteSession: (sessionId: string) => api.delete(`/brain/chat/sessions/${sessionId}`),
  /** Round K4 — ask main-brain for 3 short follow-up questions based on
   *  the last turn. Silent failure (empty array) by design — these are
   *  decorative quick-fills, not the main response. */
  followups: (userMessage: string, assistantReply: string, max = 3) =>
    api
      .post<{ followups: string[] }>("/brain/chat/followups", {
        user_message: userMessage,
        assistant_reply: assistantReply,
        max,
      })
      .then((r) => r.followups || [])
      .catch(() => [] as string[]),
};
