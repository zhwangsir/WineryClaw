import { Button } from "antd";
import { DownOutlined, MessageOutlined } from "@ant-design/icons";
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
        style={{
          flex: 1,
          overflow: "auto",
          padding: "24px 32px",
          display: "flex",
          flexDirection: "column",
          gap: 20,
          minHeight: 0,
        }}
      >
        {messages.length === 0 ? (
          // v2.44 — chat-themed icon instead of antd Empty's inbox SVG.
          // Inbox is wrong for "start a chat" (which is the opposite of
          // "your mailbox is empty"). Use a message bubble + softer
          // hierarchy. The composition mirrors ChatSidebar's empty state
          // so the two empty zones feel from the same product family.
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 12,
              opacity: 0.85,
            }}
          >
            <MessageOutlined
              style={{
                fontSize: 36,
                color: C.text3,
                background: "var(--c-hover)",
                padding: 16,
                borderRadius: "50%",
              }}
            />
            <div
              style={{
                color: C.text3,
                fontSize: 14,
                fontWeight: 300,
                textAlign: "center",
                lineHeight: 1.6,
              }}
            >
              <div>输入消息开始对话</div>
              <div style={{ fontSize: 12, marginTop: 2 }}>或拖拽文件到此处</div>
            </div>
          </div>
        ) : (
          messages.map((msg) => <MessageBubble key={msg.id} msg={msg} isDark={isDark} highlight={highlight} />)
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
