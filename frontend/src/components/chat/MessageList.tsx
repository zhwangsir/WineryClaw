import { Button, Empty } from "antd";
import { DownOutlined } from "@ant-design/icons";
import { useIsDark } from "../../hooks/useTheme";
import type { ChatMessage } from "../../api/types";
import MessageBubble from "./MessageBubble";

interface MessageListProps {
  messages: ChatMessage[];
  highlight: string;
  streaming: boolean;
  showScrollBtn: boolean;
  onScroll: () => void;
  onScrollToBottom: () => void;
  containerRef: React.Ref<HTMLDivElement>;
}

export default function MessageList({
  messages,
  highlight,
  showScrollBtn,
  onScroll,
  onScrollToBottom,
  containerRef,
}: MessageListProps) {
  const isDark = useIsDark();

  const C = {
    pageBg: "var(--c-page)",
    text: "var(--c-text)",
    text3: "var(--c-text-3)",
    textInv: "var(--c-text-inv)",
    accent: "var(--c-accent)",
  };

  return (
    <>
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="chat-scroll-container"
        style={{ flex: 1, overflow: "auto", padding: "24px 32px", display: "flex", flexDirection: "column", gap: 20, minHeight: 0 }}
      >
        {messages.length === 0 ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ color: C.text3, fontSize: 14, fontWeight: 300 }}>
                  输入消息开始对话，或拖拽文件到此处
                </span>
              }
            />
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} isDark={isDark} highlight={highlight} />
          ))
        )}
      </div>

      {/* Scroll-to-bottom button */}
      <Button
        type="primary"
        shape="circle"
        size="small"
        icon={<DownOutlined />}
        onClick={onScrollToBottom}
        className="chat-scroll-btn"
        style={{
          position: "absolute",
          right: 32,
          bottom: 120,
          zIndex: 10,
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          background: C.accent,
          borderColor: C.accent,
          color: C.textInv,
          opacity: showScrollBtn ? 1 : 0,
          transform: showScrollBtn ? "translateY(0)" : "translateY(8px)",
          pointerEvents: showScrollBtn ? "auto" : "none",
          transition: "opacity 250ms ease, transform 250ms ease",
        }}
      />
    </>
  );
}
