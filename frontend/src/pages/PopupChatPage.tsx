/**
 * PopupChatPage — compact chat surface for the macOS menu-bar tray popup.
 *
 * Mounted at /popup-chat. Loaded by the Tauri popup window (400×580, no
 * decorations, alwaysOnTop). Reuses the global chatStore so:
 *   - conversations stay in sync with the main window
 *   - sessionId / agentId / streaming all work the same
 *
 * Differences from UserHomePage:
 *   - no admin chrome / knowledge sidebar / onboarding modal
 *   - no AppInitializer (popup boots its own minimal state via initChat)
 *   - tight padding + 14px base font for the small viewport
 *   - top drag region so the frameless window is movable
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../stores/chatStore";

const HEADER_HEIGHT = 36;
const INPUT_HEIGHT = 88;

interface MessageRowProps {
  role: "user" | "assistant" | "system" | string;
  content: string;
  streaming?: boolean;
}

function MessageRow({ role, content, streaming }: MessageRowProps) {
  const isUser = role === "user";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        marginBottom: 10,
      }}
    >
      <div
        style={{
          maxWidth: "85%",
          padding: "8px 12px",
          borderRadius: 10,
          background: isUser ? "#2383e2" : "rgba(255,255,255,0.06)",
          color: isUser ? "white" : "#e6e6e6",
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          border: isUser ? "none" : "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {content}
        {streaming && (
          <span style={{ opacity: 0.5, marginLeft: 4 }} aria-hidden>
            ▌
          </span>
        )}
      </div>
    </div>
  );
}

export default function PopupChatPage() {
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const sendStream = useChatStore((s) => s.sendStream);
  const init = useChatStore((s) => s.init);
  // `streaming` is store-level; messages also carry their own `streaming` flag
  // (set/cleared inside sendStream during/after streaming).
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Boot minimal state (session + history) once.
  useEffect(() => {
    init().catch(() => {
      /* init is non-fatal; chat input still works */
    });
  }, [init]);

  // Auto-scroll to bottom on new messages / streaming chunks.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const canSend = useMemo(() => draft.trim().length > 0 && !streaming, [draft, streaming]);

  const onSubmit = async () => {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    try {
      await sendStream(text);
    } catch {
      // sendStream surfaces errors as assistant messages; nothing to do here.
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        background: "#1a1a1a",
        color: "#e6e6e6",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif",
        overflow: "hidden",
      }}
    >
      {/* Drag region: makes the frameless popup window movable from the top */}
      <div
        {...({ "data-tauri-drag-region": true } as Record<string, boolean>)}
        style={{
          height: HEADER_HEIGHT,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          fontSize: 12,
          opacity: 0.7,
          userSelect: "none",
          cursor: "grab",
          flexShrink: 0,
        }}
      >
        💬 WeBrain Quick Chat
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 12,
          fontSize: 13,
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              opacity: 0.5,
              fontSize: 12,
              textAlign: "center",
              marginTop: 80,
              padding: "0 20px",
            }}
          >
            从状态栏直接对话 — 输入消息后回车发送。
            <br />
            Shift+Enter 换行。
          </div>
        )}
        {messages.map((msg, idx) => {
          const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
          const isLast = idx === messages.length - 1;
          return (
            <MessageRow
              key={msg.id ?? idx}
              role={msg.role}
              content={content}
              streaming={streaming && isLast && msg.role === "assistant"}
            />
          );
        })}
      </div>

      {/* Input bar */}
      <div
        style={{
          height: INPUT_HEIGHT,
          padding: "8px 10px 10px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          background: "#181818",
          flexShrink: 0,
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={streaming ? "生成中..." : "输入消息..."}
          disabled={streaming}
          rows={2}
          style={{
            width: "100%",
            height: 48,
            padding: "8px 10px",
            background: "#222",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            color: "#e6e6e6",
            fontSize: 13,
            fontFamily: "inherit",
            resize: "none",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 4,
            fontSize: 11,
            opacity: 0.5,
          }}
        >
          <span>Enter 发送 · Shift+Enter 换行</span>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSend}
            style={{
              padding: "4px 14px",
              background: canSend ? "#2383e2" : "#333",
              border: "none",
              borderRadius: 6,
              color: "white",
              cursor: canSend ? "pointer" : "not-allowed",
              fontSize: 12,
              opacity: canSend ? 1 : 0.5,
            }}
          >
            {streaming ? "..." : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
