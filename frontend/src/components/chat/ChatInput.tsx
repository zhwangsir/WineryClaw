import { useRef } from "react";
import { Button, Input, Tooltip } from "antd";
import { SendOutlined, StopOutlined, AudioOutlined, AudioMutedOutlined } from "@ant-design/icons";

interface ChatInputProps {
  value: string;
  onChange: (val: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  isRecording: boolean;
  onToggleVoice: () => void;
  dragOver: boolean;
}

export default function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  isRecording,
  onToggleVoice,
}: ChatInputProps) {
  const textareaRef = useRef<any>(null);

  const C = {
    pageBg: "var(--c-page)",
    hoverBg: "var(--c-hover)",
    border: "var(--c-border)",
    text: "var(--c-text)",
    text3: "var(--c-text-3)",
    textInv: "var(--c-text-inv)",
    error: "var(--c-error)",
    accent: "var(--c-accent)",
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div style={{ borderTop: `1px solid ${C.border}`, padding: "16px 32px 24px", flexShrink: 0, background: C.pageBg }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, maxWidth: 800, margin: "0 auto" }}>
        {/* Voice input button */}
        <Tooltip title={isRecording ? "停止录音" : "语音输入"}>
          <Button
            type="text"
            onClick={onToggleVoice}
            style={{
              height: 44,
              width: 36,
              borderRadius: 8,
              color: isRecording ? C.error : C.text3,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              flexShrink: 0,
              animation: isRecording ? "pulse 1.5s infinite" : undefined,
            }}
            icon={
              isRecording ? <AudioOutlined style={{ fontSize: 16 }} /> : <AudioMutedOutlined style={{ fontSize: 16 }} />
            }
          />
        </Tooltip>

        <div style={{ flex: 1, position: "relative" }}>
          <Input.TextArea
            ref={textareaRef}
            placeholder="输入消息…"
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={streaming}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              borderRadius: 8,
              padding: "12px 16px",
              paddingRight: 44,
              background: C.hoverBg,
              border: `1px solid ${C.border}`,
              color: C.text,
              fontSize: 14,
              lineHeight: 1.6,
              resize: "none",
              transition: "border-color 150ms ease, background 150ms ease",
            }}
            onFocus={(e) => {
              e.target.style.borderColor = C.accent;
              e.target.style.background = C.pageBg;
            }}
            onBlur={(e) => {
              e.target.style.borderColor = C.border;
              e.target.style.background = C.hoverBg;
            }}
          />
          <div
            style={{
              position: "absolute",
              right: 8,
              bottom: 8,
              fontSize: 11,
              color: C.text3,
              pointerEvents: "none",
            }}
          >
            ↵
          </div>
        </div>
        {streaming ? (
          <Button
            onClick={onStop}
            style={{
              height: 44,
              width: 44,
              borderRadius: 8,
              background: C.error,
              border: "none",
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              flexShrink: 0,
            }}
            icon={<StopOutlined style={{ fontSize: 16 }} />}
          />
        ) : (
          <Button
            type="primary"
            style={{
              height: 44,
              width: 44,
              borderRadius: 8,
              background: value.trim() ? C.accent : C.hoverBg,
              border: value.trim() ? "none" : `1px solid ${C.border}`,
              color: value.trim() ? C.textInv : C.text3,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              flexShrink: 0,
              transition: "background 150ms ease, color 150ms ease",
            }}
            icon={<SendOutlined style={{ fontSize: 16 }} />}
            onClick={onSend}
            disabled={!value.trim()}
          />
        )}
      </div>
      <div
        style={{
          textAlign: "center",
          marginTop: 6,
          fontSize: 11,
          color: C.text3,
          maxWidth: 800,
          margin: "6px auto 0",
        }}
      >
        Shift + Enter 换行 · Enter 发送 · 拖拽文件上传
      </div>
    </div>
  );
}
