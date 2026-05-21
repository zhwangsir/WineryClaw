import { useState } from "react";
import { Tooltip, message } from "antd";
import {
  UserOutlined,
  RobotOutlined,
  ToolOutlined,
  CopyOutlined,
  CheckOutlined,
  ThunderboltOutlined,
  DownOutlined,
  FileSearchOutlined,
  OrderedListOutlined,
  PlayCircleOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from "@ant-design/icons";
import type { ChatMessage } from "../../api/types";
import { planApi, type PlanExecutionResult } from "../../api/plan";
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
  // Plan execution state — purely local; no need for global state since
  // each message owns its own run.
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<PlanExecutionResult | null>(null);

  const handleExecutePlan = async () => {
    if (!msg.plan || executing) return;
    setExecuting(true);
    setExecResult(null);
    try {
      const res = await planApi.execute({ plan: msg.plan, verify: "presence" });
      setExecResult(res);
      if (res.ok && res.overall_success) {
        message.success(`计划执行完成 · ${res.results?.length ?? 0} 个任务全部通过`);
      } else if (res.ok) {
        message.warning(`计划执行完成 · ${res.failed_task_ids?.length ?? 0} 个任务失败`);
      } else {
        message.error(res.error || "计划执行失败");
      }
    } catch (e: unknown) {
      const msgText = e instanceof Error ? e.message : "计划执行失败";
      message.error(msgText);
    } finally {
      setExecuting(false);
    }
  };

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
                  {/* Execute plan button (M3) */}
                  <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      onClick={handleExecutePlan}
                      disabled={executing}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "3px 10px",
                        borderRadius: 4,
                        border: `1px solid ${isDark ? "#22c55e" : "#16a34a"}`,
                        background: executing
                          ? (isDark ? "rgba(34,197,94,0.10)" : "rgba(34,197,94,0.08)")
                          : (isDark ? "rgba(34,197,94,0.15)" : "rgba(34,197,94,0.12)"),
                        color: isDark ? "#86efac" : "#15803d",
                        fontSize: 11,
                        cursor: executing ? "wait" : "pointer",
                        transition: "all 150ms",
                      }}
                    >
                      {executing ? <LoadingOutlined /> : <PlayCircleOutlined />}
                      {executing ? "执行中..." : "执行计划"}
                    </button>
                    {execResult && execResult.ok && (
                      <span style={{ fontSize: 11, color: isDark ? "#a1a1aa" : "#737373" }}>
                        {execResult.overall_success ? (
                          <span style={{ color: isDark ? "#86efac" : "#15803d" }}>
                            <CheckCircleOutlined /> 全部通过 · {execResult.total_attempts ?? 0} 次尝试
                          </span>
                        ) : (
                          <span style={{ color: isDark ? "#fca5a5" : "#b91c1c" }}>
                            <CloseCircleOutlined /> {execResult.failed_task_ids?.length ?? 0} 个失败
                          </span>
                        )}
                      </span>
                    )}
                  </div>

                  {/* Per-task result list (after execution) */}
                  {execResult && execResult.ok && execResult.results && execResult.results.length > 0 && (
                    <div
                      style={{
                        marginTop: 8,
                        paddingTop: 6,
                        borderTop: `1px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)"}`,
                        fontSize: 12,
                      }}
                    >
                      {execResult.results.map((r) => (
                        <div key={r.task_id} style={{ marginBottom: 6 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            {r.succeeded ? (
                              <CheckCircleOutlined style={{ color: isDark ? "#86efac" : "#15803d" }} />
                            ) : (
                              <CloseCircleOutlined style={{ color: isDark ? "#fca5a5" : "#b91c1c" }} />
                            )}
                            <span style={{ fontWeight: 500 }}>{r.description}</span>
                            <span style={{ fontSize: 10, opacity: 0.6 }}>
                              · {r.attempts.length} 次尝试
                              {r.attempts.length > 0 && r.attempts.some((a) => a.strategy === "augmented") && " · 已换策略"}
                            </span>
                          </div>
                          {r.final_output && (
                            <div
                              style={{
                                marginLeft: 18,
                                marginTop: 2,
                                fontSize: 11,
                                color: isDark ? "#a1a1aa" : "#525252",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                maxHeight: 80,
                                overflow: "auto",
                              }}
                            >
                              {r.final_output.length > 240 ? r.final_output.slice(0, 240) + "..." : r.final_output}
                            </div>
                          )}
                        </div>
                      ))}
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
            // Round K2 — tighter, accent-color cursor with a smoother
            // 1.2s blink (was chatPulse green at 1s). Sits inline at the
            // tail of the streamed content.
            <span
              style={{
                display: "inline-block",
                width: 2,
                height: 14,
                background: "var(--c-accent)",
                marginLeft: 3,
                verticalAlign: "text-bottom",
                animation: "chatCursorBlink 1.2s steps(2) infinite",
                borderRadius: 1,
              }}
              aria-hidden="true"
            />
          )}

          {/* RAG document sources — Round K3 upgraded to per-chunk numbered
              footnote pills. Each pill is independently hover-able, showing
              the specific file + chunk + score for that citation. */}
          {msg.ragSources && msg.ragSources.length > 0 && (
            <div
              style={{
                marginTop: 12,
                paddingTop: 10,
                borderTop: isDark ? "1px dashed rgba(255,255,255,0.08)" : "1px dashed rgba(0,0,0,0.06)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: isDark ? "#a1a1aa" : "var(--c-text-3)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <FileSearchOutlined style={{ fontSize: 11 }} />
                来源
              </span>
              {msg.ragSources.map((s, i) => {
                const name = s.doc_path.split("/").pop() || s.doc_path;
                return (
                  <Tooltip
                    key={`${s.doc_path}-${s.chunk_idx}-${i}`}
                    title={
                      <div style={{ maxWidth: 320 }}>
                        <div style={{ fontFamily: "monospace", fontSize: 12, marginBottom: 4, wordBreak: "break-all" }}>
                          {name}
                        </div>
                        <div style={{ fontSize: 11, opacity: 0.8 }}>
                          片段 #{s.chunk_idx} · 相关度 {s.score.toFixed(3)}
                        </div>
                      </div>
                    }
                  >
                    <span
                      // Q13.1 (2026-05-21) — previously rendered as <a
                      // href="/wiki?file=…">, but /wiki has no concept of
                      // an absolute file path on the RAG corpus, so the
                      // click navigated away from the chat to a generic
                      // wiki page that ignored the query. The Tooltip
                      // already shows filename + chunk # + similarity
                      // score on hover, which is the complete citation
                      // context — no navigation needed.
                      role="button"
                      tabIndex={0}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        fontSize: 11,
                        fontFamily: '"SF Mono", Menlo, Consolas, monospace',
                        color: isDark ? "#93c5fd" : "#1d4ed8",
                        background: isDark ? "rgba(59,130,246,0.10)" : "rgba(59,130,226,0.08)",
                        border: isDark ? "1px solid rgba(59,130,246,0.30)" : "1px solid rgba(35,131,226,0.25)",
                        borderRadius: 10,
                        padding: "1px 8px",
                        textDecoration: "none",
                        lineHeight: "16px",
                        display: "inline-block",
                        minWidth: 18,
                        textAlign: "center",
                        cursor: "help",
                        transition: "background 120ms, border-color 120ms",
                        userSelect: "none",
                      }}
                    >
                      [{i + 1}]
                    </span>
                  </Tooltip>
                );
              })}
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
