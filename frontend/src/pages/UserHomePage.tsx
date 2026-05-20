import { useEffect, useRef, useState, useCallback } from "react";
import { message, Upload, Tag, Tooltip, Empty, Button, Modal } from "antd";
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
  const { messages, streaming, sendStream, stopStream, newSession, currentSessionId } = useChatStore();
  const { fetchHealth } = useSystemStore();
  const { fetchModelConfig } = useConfigStore();

  const [docs, setDocs] = useState<IndexedDoc[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Ensure we have a session on mount so chat history doesn't get lost
  // when the user types their first message.
  useEffect(() => {
    if (!currentSessionId) {
      newSession();
    }
    fetchHealth();
    fetchModelConfig();
  }, []);

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

  // Scroll chat to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
          <span className="user-home__logo">
            <BrandMark />
          </span>
          <span className="user-home__title">WeBrain</span>
        </div>
        <Tooltip title="进入管理端">
          <Button
            type="text"
            icon={<SettingOutlined />}
            size="large"
            onClick={() => navigate("/dashboard")}
            aria-label="管理端"
          />
        </Tooltip>
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
          <div className="user-home__input">
            <ChatInput
              value={inputValue}
              onChange={setInputValue}
              onSend={handleSend}
              onStop={handleStop}
              streaming={streaming}
              isRecording={false}
              onToggleVoice={() => {}}
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
    </div>
  );
}
