import { useState, useEffect, useRef } from "react";
import { Button, Input, Card, Empty } from "antd";
import { CodeOutlined, SendOutlined } from "@ant-design/icons";
import { PageShell } from "../components/common/PageShell";
import { useCliStore } from "../stores/cliStore";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export default function CliPage() {
  const { status, loading, fetchStatus, chat } = useCliStore();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userMsg: ChatMessage = { role: "user", content: input, timestamp: new Date().toISOString() };
    setMessages((m) => [...m, userMsg]);
    const text = input;
    setInput("");
    const reply = await chat(text);
    const assistantMsg: ChatMessage = { role: "assistant", content: reply || "(无响应)", timestamp: new Date().toISOString() };
    setMessages((m) => [...m, assistantMsg]);
  };

  return (
    <PageShell
      title="CLI"
      subtitle={`命令行交互 — ${status || "Loading..."}`}
      icon={<CodeOutlined />}
    >
      <Card
        style={{ borderRadius: 12, border: "1px solid var(--c-border)", height: "calc(100vh - 240px)", display: "flex", flexDirection: "column" }}
        bodyStyle={{ padding: 0, display: "flex", flexDirection: "column", height: "100%" }}
      >
        {/* Messages */}
        <div
          ref={scrollRef}
          style={{ flex: 1, overflow: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 12 }}
        >
          {messages.length === 0 ? (
            <Empty description="开始与 CLI 交互" style={{ marginTop: 80 }} />
          ) : (
            messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "80%",
                  padding: "12px 16px",
                  borderRadius: 12,
                  background: m.role === "user" ? "var(--c-primary-soft)" : "var(--c-hover)",
                  color: "var(--c-text)",
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                <div style={{ fontSize: 10, color: "var(--c-text-3)", marginBottom: 4, fontWeight: 300 }}>
                  {m.role === "user" ? "You" : "CLI"} · {new Date(m.timestamp).toLocaleTimeString("zh-CN")}
                </div>
                {m.content}
              </div>
            ))
          )}
        </div>

        {/* Input */}
        <div style={{ padding: "16px 24px", borderTop: "1px solid var(--c-border)", display: "flex", gap: 12 }}>
          <Input
            placeholder="输入命令或消息..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={handleSend}
            disabled={loading}
            style={{ flex: 1 }}
          />
          <Button type="primary" icon={<SendOutlined />} onClick={handleSend} loading={loading}>
            发送
          </Button>
        </div>
      </Card>
    </PageShell>
  );
}
