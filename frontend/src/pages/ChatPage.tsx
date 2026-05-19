import { useEffect, useRef, useState, useCallback } from "react";
import { Input, message } from "antd";
import { InboxOutlined, SearchOutlined } from "@ant-design/icons";
import { useChatStore } from "../stores/chatStore";
import { useSystemStore } from "../stores/systemStore";
import { useConfigStore } from "../stores/configStore";
import { useAgentStore } from "../stores/agentStore";
import { useIsDark } from "../hooks/useTheme";
import ChatSidebar from "../components/chat/ChatSidebar";
import ChatHeader from "../components/chat/ChatHeader";
import MessageList from "../components/chat/MessageList";
import ChatInput from "../components/chat/ChatInput";
import { uploadApi } from "../api/upload";

export default function ChatPage() {
  const isDark = useIsDark();
  const {
    messages,
    sessions,
    currentSessionId,
    streaming,
    toolEnabled,
    setToolEnabled,
    sendStream,
    stopStream,
    newSession,
    fetchHistory,
    deleteSession,
    clearCurrentChat,
    init,
  } = useChatStore();

  const [inputValue, setInputValue] = useState("");
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [msgSearch, setMsgSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const prevMessagesLengthRef = useRef(0);
  const scrollRafRef = useRef<number>(0);
  const isUserScrollRef = useRef(false);

  useEffect(() => {
    init();
  }, [init]);

  // Fetch model health, config, and agents on mount
  useEffect(() => {
    const { fetchModelHealth } = useSystemStore.getState();
    const { fetchModelConfig } = useConfigStore.getState();
    const { fetchAgents } = useAgentStore.getState();
    fetchModelHealth();
    fetchModelConfig();
    fetchAgents();
  }, []);

  // Smart auto-scroll with separated strategies
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const prevLen = prevMessagesLengthRef.current;
    const currLen = messages.length;
    const grew = currLen > prevLen;
    prevMessagesLengthRef.current = currLen;

    // Calculate distance to bottom
    const distToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distToBottom < 80;

    // Strategy 1: user just sent a message (message count increased while not streaming yet,
    // or the newest message is from user) -> always scroll to bottom
    const lastMsg = messages[messages.length - 1];
    const isUserMessage = lastMsg?.role === "user";

    if (grew && isUserMessage) {
      isUserScrollRef.current = true;
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      setShowScrollBtn(false);
      return;
    }

    // Strategy 2: AI streaming response -> scroll only if user was already near bottom
    if (streaming && nearBottom) {
      container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      setShowScrollBtn(false);
      return;
    }

    // Strategy 3: non-streaming updates (e.g. history load, message complete)
    // Keep position unless user is near bottom
    if (nearBottom) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      setShowScrollBtn(false);
    } else if (grew) {
      setShowScrollBtn(true);
    }
  }, [messages, streaming]);

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const container = messagesContainerRef.current;
      if (!container) return;
      const threshold = 80;
      const distToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const nearBottom = distToBottom < threshold;
      setShowScrollBtn(!nearBottom);
    });
  }, []);

  const scrollToBottom = () => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
    setShowScrollBtn(false);
  };

  const { currentAgentId } = useAgentStore();

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text || streaming) return;
    setInputValue("");
    sendStream(text, currentAgentId);
  }, [inputValue, streaming, sendStream, currentAgentId]);

  // Voice input
  const toggleVoiceInput = useCallback(() => {
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      message.error("您的浏览器不支持语音输入");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognitionRef.current = recognition;

    recognition.onresult = (event: any) => {
      let finalTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        }
      }
      if (finalTranscript) {
        setInputValue((prev) => prev + finalTranscript);
      }
    };

    recognition.onerror = () => {
      setIsRecording(false);
      message.error("语音识别失败");
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognition.start();
    setIsRecording(true);
  }, [isRecording]);

  // Drag and drop file upload
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    for (const file of files) {
      if (file.type.startsWith("text/") || file.name.endsWith(".md") || file.name.endsWith(".json") || file.name.endsWith(".txt")) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const content = ev.target?.result as string;
          setInputValue((prev) => prev + (prev ? "\n\n" : "") + `\`\`\`${file.name}\n${content}\n\`\`\``);
        };
        reader.readAsText(file);
      } else {
        // Upload binary files to server
        message.loading({ content: `Uploading "${file.name}"...`, key: `upload-${file.name}` });
        try {
          const result = await uploadApi.upload(file);
          if (result.ok && result.url) {
            message.success({ content: `"${file.name}" uploaded (${(result.size! / 1024).toFixed(1)} KB)`, key: `upload-${file.name}` });
            setInputValue((prev) => prev + (prev ? "\n\n" : "") + `[📎 ${file.name}](${result.url})`);
          } else {
            message.error({ content: `Upload failed: ${result.error}`, key: `upload-${file.name}` });
          }
        } catch (err: any) {
          message.error({ content: `Upload error: ${err.message}`, key: `upload-${file.name}` });
        }
      }
    }
  };

  const activeSession = sessions.find((s) => s.id === currentSessionId);

  const filteredMessages = msgSearch.trim()
    ? messages.filter((m) => m.content.toLowerCase().includes(msgSearch.toLowerCase()))
    : messages;

  const handleExport = () => {
    const title = activeSession?.title || "chat";
    const md = messages
      .map((m) => {
        const role = m.role === "user" ? "👤 User" : "🤖 Assistant";
        const time = m.timestamp ? new Date(m.timestamp).toLocaleString("zh-CN") : "";
        return `## ${role} · ${time}\n\n${m.content}\n`;
      })
      .join("\n---\n\n");
    const blob = new Blob([`# ${title}\n\n${md}`], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9\u4e00-\u9fa5]/gi, "_")}_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    message.success("对话已导出");
  };

  const C = {
    pageBg: "var(--c-page)",
    cardBg: "var(--c-card)",
    hoverBg: "var(--c-hover)",
    border: "var(--c-border)",
    text: "var(--c-text)",
    text2: "var(--c-text-2)",
    text3: "var(--c-text-3)",
    textInv: "var(--c-text-inv)",
    success: "var(--c-success)",
    error: "var(--c-error)",
    accent: "var(--c-accent)",
    userBubbleBg: isDark ? "#f5f5f5" : "#000000",
    userBubbleText: isDark ? "#0a0a0a" : "#ffffff",
    assistantBubbleBg: isDark ? "#1f1f1f" : "#f5f5f5",
    assistantBubbleText: isDark ? "#f5f5f5" : "#000000",
    assistantBubbleBorder: isDark ? "#27272a" : "#e5e5e5",
  };

  return (
    <div
      className="chat-page-root"
      style={{
        display: "flex",
        height: "calc(100vh - 64px)",
        background: C.pageBg,
        fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <ChatSidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={(id) => {
          fetchHistory(id);
          setInputValue("");
        }}
        onNewSession={() => {
          newSession();
          setInputValue("");
        }}
        onDeleteSession={(id) => deleteSession(id)}
      />

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          background: C.pageBg,
          minWidth: 0,
          overflow: "hidden",
          position: "relative",
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {dragOver && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 20,
              background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
              border: `2px dashed ${C.accent}`,
              borderRadius: 8,
              margin: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 12,
              backdropFilter: "blur(4px)",
            }}
          >
            <InboxOutlined style={{ fontSize: 48, color: C.accent }} />
            <span style={{ fontSize: 16, fontWeight: 500, color: C.text }}>松开以上传文件</span>
            <span style={{ fontSize: 13, color: C.text3 }}>支持 .txt, .md, .json 等文本文件</span>
          </div>
        )}

        <ChatHeader
          title={activeSession?.title || "新对话"}
          streaming={streaming}
          toolEnabled={toolEnabled}
          onToggleTool={() => setToolEnabled(!toolEnabled)}
          showSearch={showSearch}
          onToggleSearch={() => setShowSearch((v) => !v)}
          onExport={handleExport}
          onClear={() => clearCurrentChat()}
          messagesCount={messages.length}
        />

        {/* Message search bar */}
        {showSearch && (
          <div style={{ padding: "12px 32px 0", flexShrink: 0 }}>
            <Input
              placeholder="搜索消息内容..."
              value={msgSearch}
              onChange={(e) => setMsgSearch(e.target.value)}
              prefix={<SearchOutlined style={{ color: "var(--c-text-3)" }} />}
              allowClear
              autoFocus
              style={{ maxWidth: 400 }}
            />
            {msgSearch && (
              <span style={{ fontSize: 12, color: "var(--c-text-3)", marginLeft: 8 }}>
                {filteredMessages.length} / {messages.length} 条消息
              </span>
            )}
          </div>
        )}

        <MessageList
          messages={filteredMessages}
          highlight={msgSearch}
          streaming={streaming}
          showScrollBtn={showScrollBtn}
          onScroll={handleScroll}
          onScrollToBottom={scrollToBottom}
          containerRef={messagesContainerRef}
        />

        <ChatInput
          value={inputValue}
          onChange={setInputValue}
          onSend={handleSend}
          onStop={stopStream}
          streaming={streaming}
          isRecording={isRecording}
          onToggleVoice={toggleVoiceInput}
          dragOver={dragOver}
        />
      </div>

      <style>{`
        @keyframes chatPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.85); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .chat-page-root {
          margin: -48px;
          width: calc(100% + 96px);
        }
        @media (max-width: 768px) {
          .chat-page-root {
            margin: -24px;
            width: calc(100% + 48px);
          }
        }
        .chat-scroll-container::-webkit-scrollbar {
          width: 5px;
        }
        .chat-scroll-container::-webkit-scrollbar-track {
          background: transparent;
        }
        .chat-scroll-container::-webkit-scrollbar-thumb {
          background: ${isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)"};
          border-radius: 10px;
        }
        .chat-scroll-container::-webkit-scrollbar-thumb:hover {
          background: ${isDark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.22)"};
        }
        .chat-scroll-container {
          scrollbar-width: thin;
          scrollbar-color: ${isDark ? "rgba(255,255,255,0.12) transparent" : "rgba(0,0,0,0.12) transparent"};
        }
        .chat-markdown pre, .chat-markdown code, .chat-markdown table {
          max-width: 100%;
        }
        .chat-markdown pre > div {
          overflow-x: auto !important;
        }
      `}</style>
    </div>
  );
}
