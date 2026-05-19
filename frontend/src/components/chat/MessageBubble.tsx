import { useState } from "react";
import { Tooltip, message } from "antd";
import { UserOutlined, RobotOutlined, ToolOutlined, CopyOutlined, CheckOutlined, ThunderboltOutlined, DownOutlined, FileSearchOutlined, OrderedListOutlined } from "@ant-design/icons";
import type { ChatMessage } from "../../api/types";
import MarkdownRenderer from "../common/MarkdownRenderer";
import StreamingText from "./StreamingText";
import HighlightedText from "./HighlightedText";

interface MessageBubbleProps {
  msg: ChatMessage;
  isDark: boolean;
  highlight?: string;
}

export default function MessageBubble({ msg, isDark, highlight }: MessageBubbleProps) {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";
  const [copied, setCopied] = useState(false);
  const [showReasoning, setShowReasoning] = useState(true);
  const [showPlan, setShowPlan] = useState(true);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error("复制失败");
    }
  };

  const bubbleBg = isUser
    ? isDark
      ? "#f5f5f5"
      : "#000000"
    : isSystem
      ? isDark
        ? "#27272a"
        : "#f0f0f0"
      : isDark
        ? "#1f1f1f"
        : "#f5f5f5";

  const bubbleText = isUser ? (isDark ? "#0a0a0a" : "#ffffff") : isDark ? "#f5f5f5" : "#000000";

  const bubbleBorder = isUser
    ? "none"
    : isSystem
      ? isDark
        ? "1px dashed #3f3f46"
        : "1px dashed #cccccc"
      : isDark
        ? "1px solid #27272a"
        : "1px solid #e5e5e5";

  const avatarBg = isUser ? (isDark ? "#f5f5f5" : "#000000") : isSystem ? "#666666" : isDark ? "#27272a" : "#f5f5f5";

  const avatarIconColor = isUser
    ? isDark
      ? "#0a0a0a"
      : "#ffffff"
    : isSystem
      ? "#ffffff"
      : isDark
        ? "#a1a1aa"
        : "#666666";

  const timeStr = msg.timestamp
    ? new Date(msg.timestamp).toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  return (
    <div style={{ display: "flex", gap: 12, flexDirection: isUser ? "row-reverse" : "row", alignItems: "flex-start", minWidth: 0, maxWidth: "100%" }}>
      {/* Avatar */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          background: avatarBg,
          border: isUser ? "none" : isDark ? "1px solid #27272a" : "1px solid #e5e5e5",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        {isUser ? (
          <UserOutlined style={{ fontSize: 12, color: avatarIconColor }} />
        ) : isSystem ? (
          <RobotOutlined style={{ fontSize: 12, color: avatarIconColor }} />
        ) : (
          <RobotOutlined style={{ fontSize: 12, color: avatarIconColor }} />
        )}
      </div>

      {/* Bubble */}
      <div style={{ maxWidth: "min(720px, 85%)", display: "flex", flexDirection: "column", gap: 4 }}>
        <div
          style={{
            padding: "12px 16px",
            borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
            background: bubbleBg,
            border: bubbleBorder,
            color: bubbleText,
            fontSize: 14,
            lineHeight: 1.7,
            wordBreak: "break-word",
            position: "relative",
          }}
        >
          {/* Plan (M2 — task decomposition) — shown above reasoning so users
              see "what the assistant intends to do" before "how it's thinking". */}
          {msg.plan && msg.plan.tasks && msg.plan.tasks.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <button
                onClick={() => setShowPlan(!showPlan)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 0",
                  fontSize: 12,
                  color: isDark ? "#86efac" : "#15803d",
                  fontWeight: 500,
                }}
              >
                <OrderedListOutlined style={{ fontSize: 10 }} />
                <span>规划 {msg.plan.tasks.length} 步任务</span>
                {msg.plan.confidence > 0 && (
                  <span style={{ opacity: 0.7, fontWeight: 400 }}>
                    · 置信度 {(msg.plan.confidence * 100).toFixed(0)}%
                  </span>
                )}
                <DownOutlined
                  style={{
                    fontSize: 10,
                    transition: "transform 200ms",
                    transform: showPlan ? "rotate(180deg)" : "rotate(0deg)",
                  }}
                />
              </button>
              {showPlan && (
                <div
                  style={{
                    marginTop: 4,
                    padding: "8px 12px",
                    background: isDark ? "rgba(34,197,94,0.06)" : "rgba(34,197,94,0.04)",
                    borderRadius: 8,
                    borderLeft: `2px solid ${isDark ? "#22c55e" : "#16a34a"}`,
                    fontSize: 13,
                    color: isDark ? "#d4d4d8" : "#3f3f46",
                    lineHeight: 1.6,
                  }}
                >
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    {msg.plan.tasks.map((t) => (
                      <li key={t.id} style={{ marginBottom: 4 }}>
                        <span>{t.description}</span>
                        {t.requires_tool && t.tool_hint && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 11,
                              padding: "1px 5px",
                              borderRadius: 3,
                              background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)",
                              fontFamily: "monospace",
                              color: isDark ? "#a1a1aa" : "#525252",
                            }}
                          >
                            {t.tool_hint}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                  {msg.plan.reasoning && (
                    <div style={{ marginTop: 6, fontSize: 11, color: isDark ? "#71717a" : "#737373", fontStyle: "italic" }}>
                      {msg.plan.reasoning}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Reasoning / thinking process */}
          {msg.reasoning && (
            <div style={{ marginBottom: 8 }}>
              <button
                onClick={() => setShowReasoning(!showReasoning)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 0",
                  fontSize: 12,
                  color: isDark ? "#71717a" : "#a1a1aa",
                  fontWeight: 500,
                }}
              >
                <ThunderboltOutlined style={{ fontSize: 10 }} />
                <span>思考过程</span>
                <DownOutlined
                  style={{
                    fontSize: 10,
                    transition: "transform 200ms",
                    transform: showReasoning ? "rotate(180deg)" : "rotate(0deg)",
                  }}
                />
              </button>
              {showReasoning && (
                <div
                  style={{
                    marginTop: 4,
                    padding: "8px 12px",
                    background: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
                    borderRadius: 8,
                    borderLeft: `2px solid ${isDark ? "#52525b" : "#d4d4d8"}`,
                    fontSize: 13,
                    color: isDark ? "#a1a1aa" : "#71717a",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {msg.reasoning}
                </div>
              )}
            </div>
          )}

          {/* User messages: plain text with optional highlight; Assistant: Markdown or streaming text */}
          {isUser ? (
            <div style={{ whiteSpace: "pre-wrap" }}>
              {highlight ? <HighlightedText text={msg.content} highlight={highlight} /> : msg.content}
            </div>
          ) : msg.isStreaming ? (
            <StreamingText content={msg.content || ""} isDark={isDark} />
          ) : (
            <div className="chat-markdown">
              <MarkdownRenderer content={msg.content || ""} />
            </div>
          )}

          {msg.isStreaming && (
            <span
              style={{
                display: "inline-block",
                width: 2,
                height: 16,
                background: "var(--c-success)",
                marginLeft: 4,
                verticalAlign: "middle",
                animation: "chatPulse 1s infinite",
              }}
            />
          )}

          {/* RAG document sources — shown when the reply consulted indexed docs */}
          {msg.ragSources && msg.ragSources.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Tooltip
                title={
                  <div style={{ maxWidth: 360 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>引用文档</div>
                    {msg.ragSources.map((s, i) => {
                      const name = s.doc_path.split("/").pop() || s.doc_path;
                      return (
                        <div key={i} style={{ fontSize: 12, marginBottom: 2 }}>
                          <span style={{ fontFamily: "monospace" }}>{name}</span>
                          <span style={{ opacity: 0.7 }}>
                            {" "}
                            #{s.chunk_idx} · {s.score.toFixed(2)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                }
              >
                <span
                  style={{
                    fontSize: 11,
                    color: isDark ? "#93c5fd" : "#1d4ed8",
                    background: isDark ? "rgba(59,130,246,0.10)" : "rgba(59,130,246,0.08)",
                    border: isDark ? "1px solid rgba(59,130,246,0.30)" : "1px solid rgba(59,130,246,0.25)",
                    borderRadius: 4,
                    padding: "2px 8px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    cursor: "help",
                  }}
                >
                  <FileSearchOutlined style={{ fontSize: 10 }} />
                  参考 {msg.ragSources.length} 篇文档
                </span>
              </Tooltip>
            </div>
          )}

          {/* Tool calls */}
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {msg.toolCalls.map((tc, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: 11,
                    color: isDark ? "#a1a1aa" : "#666666",
                    background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
                    border: isDark ? "1px solid #27272a" : "1px solid #e5e5e5",
                    borderRadius: 4,
                    padding: "2px 8px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <ToolOutlined style={{ fontSize: 10 }} />
                  {tc.function?.name}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Meta row: timestamp + copy */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            justifyContent: isUser ? "flex-end" : "flex-start",
            padding: "0 4px",
          }}
        >
          {timeStr && (
            <span style={{ fontSize: 11, color: isDark ? "#52525b" : "#a3a3a3", fontWeight: 300 }}>{timeStr}</span>
          )}
          {!msg.isStreaming && msg.content && (
            <Tooltip title={copied ? "已复制" : "复制"}>
              <button
                onClick={handleCopy}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 2,
                  display: "flex",
                  alignItems: "center",
                  color: copied ? "var(--c-success)" : isDark ? "#52525b" : "#a3a3a3",
                  fontSize: 12,
                  transition: "color 150ms",
                }}
              >
                {copied ? <CheckOutlined /> : <CopyOutlined />}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
