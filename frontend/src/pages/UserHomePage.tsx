import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { message, Upload, Tag, Tooltip, Empty, Button, Modal, Drawer, Input } from "antd";
import {
  SettingOutlined,
  InboxOutlined,
  FileTextOutlined,
  DeleteOutlined,
  ReloadOutlined,
  BulbOutlined,
  ReadOutlined,
  CodeOutlined,
  RocketOutlined,
  HistoryOutlined,
  PlusOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type { UploadProps } from "antd";
import { useNavigate } from "react-router-dom";
import { useChatStore } from "../stores/chatStore";
import { useSystemStore } from "../stores/systemStore";
import { useConfigStore } from "../stores/configStore";
import MessageList from "../components/chat/MessageList";
import ChatInput from "../components/chat/ChatInput";
import { ragApi } from "../api/rag";
import { uploadApi } from "../api/upload";
import { chatApi } from "../api/chat";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import "./UserHomePage.css";

const { Dragger } = Upload;

/**
 * Brand mark — small SVG "brain wave" glyph rendered on the Notion-blue→
 * violet gradient defined in CSS. Replaces the Unicode `●` placeholder.
 */
function BrandMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8c0-2.5 2-4.5 4.5-4.5S12 5.5 12 8c0 1-.3 1.9-.9 2.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M2.5 10.5c1.2.6 2.6.6 3.8 0 1.2-.6 2.6-.6 3.8 0 1.2.6 2.6.6 3.8 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Round K1 — compact LLM model indicator. Shown in the user-mode topbar.
 * Reads from useConfigStore.modelConfig. Clicking jumps to admin /config
 * for the user to swap models. Falls back gracefully if the model is
 * not yet loaded.
 */
function ModelIndicator() {
  const navigate = useNavigate();
  const { modelConfig } = useConfigStore();
  const label = modelConfig?.modelId?.trim() || "default";
  // Hide the indicator entirely until config is loaded so we don't
  // flash a "default" label first.
  if (!modelConfig) return null;

  // Trim long model ids (e.g. "moonshotai/Kimi-K2.6") to keep the topbar
  // compact. Hover shows the full id.
  const shortLabel = label.length > 18 ? label.slice(0, 16) + "…" : label;

  return (
    <Tooltip title={`当前模型 · ${label}  — 点击进入模型配置`}>
      <Button
        type="text"
        size="small"
        onClick={() => navigate("/config")}
        aria-label="切换模型"
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: "var(--c-text-2)",
          height: 28,
          padding: "0 10px",
          borderRadius: 14,
          background: "var(--c-card)",
          border: "1px solid var(--c-border-light)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#22c55e",
            display: "inline-block",
          }}
          aria-hidden="true"
        />
        {shortLabel}
      </Button>
    </Tooltip>
  );
}

/**
 * Quick-start suggestion cards rendered on the empty state. Clicking a
 * card pre-fills the input but does not auto-send — keeps the user in
 * control of phrasing.
 */
const SUGGESTIONS = [
  {
    icon: <BulbOutlined />,
    title: "解释一个概念",
    prompt: "用通俗的语言解释什么是 RAG (检索增强生成),包含一个生活化的比喻。",
  },
  {
    icon: <ReadOutlined />,
    title: "总结知识库",
    prompt: "根据我上传的知识库,总结关键要点,并按主题分组。",
  },
  {
    icon: <CodeOutlined />,
    title: "写一段代码",
    prompt: "用 Python 写一个函数,接收一段文本,返回出现频率最高的 10 个词。",
  },
  {
    icon: <RocketOutlined />,
    title: "头脑风暴",
    prompt: "我想做一款 AI 助手产品,帮我列出 5 个差异化的市场切入点。",
  },
];

/**
 * UserHomePage — clean Notion-styled user mode.
 *
 * Layout: chat in the main column, knowledge-base panel on the right.
 * Top bar: minimal title + gear icon → admin mode.
 *
 * RAG flow:
 *   1. drag file in → POST /api/upload  → server-side path
 *   2. POST /brain/rag/index_file with that path
 *   3. surface progress + add to indexed list
 *
 * No sidebar nav. No admin pages. Click the gear (top-right) to switch.
 */

interface IndexedDoc {
  path: string;
  filename: string;
  chunks: number;
  indexed_at: string;
  status: "indexing" | "ready" | "error";
  error?: string;
}

export default function UserHomePage(): JSX.Element {
  const navigate = useNavigate();
  const {
    messages,
    streaming,
    sendStream,
    stopStream,
    newSession,
    currentSessionId,
    sessions,
    fetchSessions,
    fetchHistory,
    deleteSession,
  } = useChatStore();
  const { fetchHealth } = useSystemStore();
  const { fetchModelConfig } = useConfigStore();

  const [docs, setDocs] = useState<IndexedDoc[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Round K5 — session-switcher drawer state
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");

  // Round K6 — voice input (Web Speech API)
  const voice = useSpeechRecognition();

  // Round K4 — suggested follow-up questions for the last AI reply.
  const [followups, setFollowups] = useState<string[]>([]);
  const [followupsLoading, setFollowupsLoading] = useState(false);

  // Round K7 — first-run onboarding tour. Gated by a localStorage flag
  // so it shows once per browser. Users can skip + never see it again.
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);

  useEffect(() => {
    try {
      const seen = localStorage.getItem("webrain.onboarding.seen");
      if (!seen) setTourOpen(true);
    } catch {
      /* localStorage disabled — never show */
    }
  }, []);

  const finishTour = (alsoSkipSimilar = true) => {
    setTourOpen(false);
    setTourStep(0);
    if (alsoSkipSimilar) {
      try {
        localStorage.setItem("webrain.onboarding.seen", new Date().toISOString());
      } catch {
        /* ignore */
      }
    }
  };

  const TOUR_STEPS = [
    {
      title: "欢迎来到 WeBrain 👋",
      body: (
        <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--c-text-2)" }}>
          <p style={{ marginTop: 0 }}>
            WeBrain 是你的本地 AI 伴侣 — 聊天 + 知识库 + 长期记忆 + Agent 工作区,全部跑在你这台机器上。
          </p>
          <p>
            最简单的开始方式:在底部输入框直接对话,或点击空白页上的建议卡片快速试一个。
          </p>
        </div>
      ),
    },
    {
      title: "上传知识库给 AI 当上下文",
      body: (
        <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--c-text-2)" }}>
          <p style={{ marginTop: 0 }}>
            右侧的「知识库」栏可以拖拽 <code>.txt / .md / .pdf / .docx / .json</code> 文件上传。
          </p>
          <p>
            上传后会自动切片 + embedding 索引。之后你和 AI 对话时,相关片段会自动作为 RAG context 注入,AI 回答下面会显示参考 [1] [2] 标注。
          </p>
        </div>
      ),
    },
    {
      title: "进入管理端 (Power user)",
      body: (
        <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--c-text-2)" }}>
          <p style={{ marginTop: 0 }}>
            点击右上角齿轮 ⚙️ 进入管理端,可以管理 Agent / 工具 / 插件 / 沙箱工作区 / 通道 / 定时任务 等等。
          </p>
          <p>
            左上角时钟图标随时打开历史会话列表,继续之前的对话。
          </p>
          <p style={{ color: "var(--c-text-3)", fontSize: 12 }}>下次也想看到这个引导?清掉浏览器的 webrain.onboarding.seen localStorage 即可。</p>
        </div>
      ),
    },
  ];

  // When the recognizer finalizes a chunk, append to the textbox so the
  // user can keep dictating across pauses. Interim text is shown as a
  // hint via the ChatInput.value (we don't commit interim to inputValue
  // until it finalizes — keeps it deletable).
  useEffect(() => {
    if (voice.transcript) {
      setInputValue((prev) => (prev ? `${prev} ${voice.transcript}` : voice.transcript));
      voice.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.transcript]);

  // Surface recognizer errors as toasts (e.g. mic permission denied).
  useEffect(() => {
    if (voice.error) {
      const friendly =
        voice.error === "not-allowed"
          ? "麦克风权限被拒绝,请到浏览器设置允许"
          : voice.error === "no-speech"
          ? "没听到声音,请重试"
          : `语音识别错误:${voice.error}`;
      message.error(friendly);
    }
  }, [voice.error]);

  const handleToggleVoice = () => {
    if (!voice.supported) {
      message.warning("当前浏览器不支持语音输入 (建议 Chrome/Edge/Safari)");
      return;
    }
    if (voice.isRecording) {
      voice.stop();
    } else {
      voice.start("zh-CN");
    }
  };

  // Ensure we have a session on mount so chat history doesn't get lost
  // when the user types their first message.
  useEffect(() => {
    if (!currentSessionId) {
      newSession();
    }
    fetchHealth();
    fetchModelConfig();
    fetchSessions();
  }, []);

  // Filter sessions by free-text query against id or title.
  const filteredSessions = useMemo(() => {
    const q = sessionQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) => s.title?.toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
    );
  }, [sessions, sessionQuery]);

  const handleSwitchSession = async (sessionId: string) => {
    if (sessionId === currentSessionId) {
      setSessionDrawerOpen(false);
      return;
    }
    await fetchHistory(sessionId);
    setSessionDrawerOpen(false);
  };

  const handleNewSession = () => {
    newSession();
    setSessionDrawerOpen(false);
  };

  // Hydrate the indexed-doc list from RAG stats.
  const reloadDocs = useCallback(async () => {
    setLoadingDocs(true);
    try {
      const stats = await ragApi.stats();
      // stats.documents is [[path, chunks], ...]
      const next: IndexedDoc[] = (stats.documents || []).map(([path, chunks]) => ({
        path,
        filename: path.split("/").pop() || path,
        chunks: chunks as number,
        indexed_at: "",
        status: "ready" as const,
      }));
      setDocs(next);
    } catch (err) {
      console.error("[home] failed to load RAG stats", err);
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  useEffect(() => {
    reloadDocs();
  }, [reloadDocs]);

  // Scroll chat to bottom on new messages.
  // Round K2: also depend on the streaming flag so we keep nudging the
  // viewport down as tokens arrive (the `messages` reference changes on
  // each chunk via updateLastMessage, but the dep array uses reference
  // equality — adding streaming guarantees we react when streaming
  // transitions on/off too).
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  // Round K4 — after streaming completes, fetch 3 follow-up questions.
  // Triggers on the transition `streaming: true → false` so we don't
  // refetch while tokens are still arriving.
  useEffect(() => {
    if (streaming) {
      // Clear stale follow-ups as soon as a new turn starts.
      setFollowups([]);
      return;
    }
    if (messages.length < 2) return;
    const last = messages[messages.length - 1];
    const prev = messages[messages.length - 2];
    if (last?.role !== "assistant" || prev?.role !== "user") return;
    if (!last.content.trim()) return;
    let cancelled = false;
    setFollowupsLoading(true);
    chatApi
      .followups(prev.content, last.content, 3)
      .then((list) => {
        if (!cancelled) setFollowups(list);
      })
      .finally(() => {
        if (!cancelled) setFollowupsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [streaming, messages.length]);

  const handleClickFollowup = async (q: string) => {
    setFollowups([]);
    if (streaming) return;
    try {
      await sendStream(q);
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : "发送失败");
    }
  };

  const handleSend = async () => {
    const text = inputValue.trim();
    if (!text || streaming) return;
    setInputValue("");
    try {
      await sendStream(text);
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : "发送失败");
    }
  };

  const handleStop = () => {
    stopStream();
  };

  // RAG upload — wired to /api/upload + /brain/rag/index_file
  const uploadProps: UploadProps = {
    name: "file",
    multiple: true,
    showUploadList: false,
    accept: ".txt,.md,.pdf,.docx,.json",
    beforeUpload: async (file) => {
      // optimistic UI entry
      const tempEntry: IndexedDoc = {
        path: "",
        filename: file.name,
        chunks: 0,
        indexed_at: "",
        status: "indexing",
      };
      setDocs((prev) => [tempEntry, ...prev]);
      try {
        // Step 1: upload file → server-side path. uploadApi.upload takes
        // a File and handles base64 conversion internally.
        const up = await uploadApi.upload(file as File);
        if (!up.ok || !up.url) {
          throw new Error(up.error || "上传失败");
        }
        // up.url is a relative path like /uploads/xxx.pdf
        // Need the absolute server-side path for index_file
        const serverPath = up.url.startsWith("/") ? `.${up.url}` : up.url;

        // Step 2: index it
        const idx = await ragApi.indexFile(serverPath);
        const ready: IndexedDoc = {
          path: serverPath,
          filename: file.name,
          chunks: idx.chunks_count ?? 0,
          indexed_at: new Date().toISOString(),
          status: "ready",
        };
        setDocs((prev) => prev.map((d) => (d.filename === file.name && d.status === "indexing" ? ready : d)));
        message.success(`${file.name} 已索引 (${ready.chunks} 片段)`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : "索引失败";
        setDocs((prev) =>
          prev.map((d) =>
            d.filename === file.name && d.status === "indexing" ? { ...d, status: "error" as const, error: errMsg } : d
          )
        );
        message.error(`${file.name}: ${errMsg}`);
      }
      return false; // prevent antd's default upload
    },
  };

  const handleRemoveDoc = async (path: string, filename: string) => {
    Modal.confirm({
      title: "删除知识库文档",
      content: `确认删除 ${filename}? 该文件的所有索引片段将一并移除。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await ragApi.removeFile(path);
          setDocs((prev) => prev.filter((d) => d.path !== path));
          message.success("已删除");
        } catch (err) {
          message.error(err instanceof Error ? err.message : "删除失败");
        }
      },
    });
  };

  return (
    <div className="user-home">
      <header className="user-home__topbar">
        <div className="user-home__brand">
          {/* Round K5 — session-switcher trigger. Lives left of the brand so
              it's reachable without crossing the page for keyboard users. */}
          <Tooltip title="会话历史">
            <Button
              type="text"
              icon={<HistoryOutlined />}
              size="large"
              onClick={() => {
                fetchSessions();
                setSessionDrawerOpen(true);
              }}
              aria-label="会话历史"
            />
          </Tooltip>
          <span className="user-home__logo">
            <BrandMark />
          </span>
          <span className="user-home__title">WeBrain</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* Round K1 — current LLM model indicator. Click → admin /config */}
          <ModelIndicator />
          <Tooltip title="进入管理端">
            <Button
              type="text"
              icon={<SettingOutlined />}
              size="large"
              onClick={() => navigate("/dashboard")}
              aria-label="管理端"
            />
          </Tooltip>
        </div>
      </header>

      <div className="user-home__body">
        <main className="user-home__chat">
          <div className="user-home__messages">
            {messages.length === 0 ? (
              <div className="user-home__empty">
                <h1>有什么可以帮你的?</h1>
                <p>直接对话,或先在右边上传知识库给我作为上下文。</p>
                <div className="user-home__suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.title}
                      type="button"
                      className="user-home__suggestion"
                      onClick={() => setInputValue(s.prompt)}
                    >
                      <span className="user-home__suggestion-icon">{s.icon}</span>
                      <span className="user-home__suggestion-body">
                        <span className="user-home__suggestion-title">{s.title}</span>
                        <span className="user-home__suggestion-preview">{s.prompt}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <MessageList
                messages={messages}
                streaming={streaming}
                highlight=""
                showScrollBtn={false}
                onScroll={() => {}}
                onScrollToBottom={() => {}}
                containerRef={messagesContainerRef}
              />
            )}
            <div ref={messagesEndRef} />
          </div>
          {/* Round K4 — suggested follow-ups (shown after a complete AI turn) */}
          {!streaming && (followups.length > 0 || followupsLoading) && (
            <div
              style={{
                margin: "8px 0",
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              {followupsLoading ? (
                <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>正在准备追问建议…</span>
              ) : (
                <>
                  <span style={{ fontSize: 12, color: "var(--c-text-3)" }}>接着问:</span>
                  {followups.map((q, i) => (
                    <button
                      key={`${q}-${i}`}
                      type="button"
                      onClick={() => handleClickFollowup(q)}
                      style={{
                        padding: "4px 12px",
                        borderRadius: 16,
                        fontSize: 12,
                        background: "var(--c-card)",
                        border: "1px solid var(--c-border-light)",
                        color: "var(--c-text-2)",
                        cursor: "pointer",
                        transition: "border-color 150ms, color 150ms",
                        fontFamily: "inherit",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "var(--c-accent)";
                        e.currentTarget.style.color = "var(--c-accent)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "var(--c-border-light)";
                        e.currentTarget.style.color = "var(--c-text-2)";
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
          <div className="user-home__input">
            <ChatInput
              value={voice.interim ? `${inputValue}${inputValue ? " " : ""}${voice.interim}` : inputValue}
              onChange={setInputValue}
              onSend={handleSend}
              onStop={handleStop}
              streaming={streaming}
              isRecording={voice.isRecording}
              onToggleVoice={handleToggleVoice}
              dragOver={false}
            />
          </div>
        </main>

        <aside className="user-home__sidebar">
          <div className="user-home__sidebar-header">
            <h3>知识库</h3>
            <Tooltip title="刷新">
              <Button type="text" size="small" icon={<ReloadOutlined spin={loadingDocs} />} onClick={reloadDocs} />
            </Tooltip>
          </div>

          <Dragger {...uploadProps} className="user-home__dragger">
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">拖拽文件到这里上传</p>
            <p className="ant-upload-hint">支持 .txt .md .pdf .docx .json — 上传后自动索引</p>
          </Dragger>

          <div className="user-home__doc-list">
            {docs.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有索引文档" />
            ) : (
              docs.map((doc) => (
                <div key={doc.path || doc.filename} className={`user-home__doc user-home__doc--${doc.status}`}>
                  <FileTextOutlined className="user-home__doc-icon" />
                  <div className="user-home__doc-meta">
                    <div className="user-home__doc-name" title={doc.filename}>
                      {doc.filename}
                    </div>
                    <div className="user-home__doc-detail">
                      {doc.status === "indexing" && <Tag color="processing">索引中</Tag>}
                      {doc.status === "ready" && <Tag color="success">{doc.chunks} 片段</Tag>}
                      {doc.status === "error" && (
                        <Tooltip title={doc.error}>
                          <Tag color="error">失败</Tag>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                  {doc.status !== "indexing" && (
                    <Button
                      type="text"
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={() => handleRemoveDoc(doc.path, doc.filename)}
                      aria-label="删除"
                    />
                  )}
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      {/* Round K5 — session-switcher drawer */}
      <Drawer
        title={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>会话历史</span>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleNewSession}>
              新对话
            </Button>
          </div>
        }
        placement="left"
        width={320}
        open={sessionDrawerOpen}
        onClose={() => setSessionDrawerOpen(false)}
      >
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: "var(--c-text-3)" }} />}
          placeholder="搜索会话标题或 ID"
          value={sessionQuery}
          onChange={(e) => setSessionQuery(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        {filteredSessions.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={sessionQuery ? "无匹配会话" : "暂无历史会话"} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {filteredSessions.map((s) => {
              const active = s.id === currentSessionId;
              return (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSwitchSession(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleSwitchSession(s.id);
                    }
                  }}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: active ? "var(--c-accent-soft)" : "transparent",
                    border: active ? "1px solid var(--c-accent)" : "1px solid transparent",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    transition: "background 150ms, border-color 150ms",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = "var(--c-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: active ? 600 : 500,
                        color: "var(--c-text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.title || "未命名会话"}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--c-text-3)",
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.updatedAt ? new Date(s.updatedAt).toLocaleString("zh-CN") : s.id}
                    </div>
                  </div>
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    danger
                    onClick={(e) => {
                      e.stopPropagation();
                      Modal.confirm({
                        title: "删除该会话?",
                        content: s.title || s.id,
                        okText: "删除",
                        okType: "danger",
                        cancelText: "取消",
                        onOk: () => deleteSession(s.id),
                      });
                    }}
                    aria-label="删除会话"
                  />
                </div>
              );
            })}
          </div>
        )}
      </Drawer>

      {/* Round K7 — first-run onboarding tour (3 steps) */}
      <Modal
        title={TOUR_STEPS[tourStep]?.title}
        open={tourOpen}
        onCancel={() => finishTour(true)}
        width={520}
        maskClosable={false}
        footer={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Button type="text" onClick={() => finishTour(true)}>
              跳过
            </Button>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--c-text-3)", marginRight: 6 }}>
                {tourStep + 1} / {TOUR_STEPS.length}
              </span>
              {tourStep > 0 && (
                <Button onClick={() => setTourStep((s) => s - 1)}>上一步</Button>
              )}
              {tourStep < TOUR_STEPS.length - 1 ? (
                <Button type="primary" onClick={() => setTourStep((s) => s + 1)}>
                  下一步
                </Button>
              ) : (
                <Button type="primary" onClick={() => finishTour(true)}>
                  开始使用
                </Button>
              )}
            </div>
          </div>
        }
      >
        {TOUR_STEPS[tourStep]?.body}
      </Modal>
    </div>
  );
}
