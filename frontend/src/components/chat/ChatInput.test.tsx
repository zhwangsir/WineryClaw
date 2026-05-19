/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ChatInput from "./ChatInput";

describe("ChatInput", () => {
  const defaultProps = {
    value: "",
    onChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    streaming: false,
    isRecording: false,
    onToggleVoice: vi.fn(),
    dragOver: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders textarea with placeholder", () => {
    render(<ChatInput {...defaultProps} />);
    expect(screen.getByPlaceholderText("输入消息…")).toBeInTheDocument();
  });

  it("calls onChange when typing", () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText("输入消息…");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    expect(defaultProps.onChange).toHaveBeenCalledWith("Hello");
  });

  it("calls onSend when Enter is pressed without Shift", () => {
    render(<ChatInput {...defaultProps} value="Hello" />);
    const textarea = screen.getByPlaceholderText("输入消息…");
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter", shiftKey: false });
    expect(defaultProps.onSend).toHaveBeenCalledTimes(1);
  });

  it("does not call onSend when Shift+Enter is pressed", () => {
    render(<ChatInput {...defaultProps} value="Hello" />);
    const textarea = screen.getByPlaceholderText("输入消息…");
    // Simulate Shift+Enter by creating the event with shiftKey
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true });
    textarea.dispatchEvent(event);
    expect(defaultProps.onSend).not.toHaveBeenCalled();
  });

  it("calls onSend when send button is clicked", () => {
    render(<ChatInput {...defaultProps} value="Hello" />);
    const buttons = screen.getAllByRole("button");
    // send button is the last one when not streaming
    fireEvent.click(buttons[buttons.length - 1]);
    expect(defaultProps.onSend).toHaveBeenCalledTimes(1);
  });

  it("disables send button when value is empty", () => {
    render(<ChatInput {...defaultProps} value="" />);
    const buttons = screen.getAllByRole("button");
    const sendBtn = buttons[buttons.length - 1];
    expect(sendBtn).toBeDisabled();
  });

  it("shows stop button when streaming and calls onStop", () => {
    render(<ChatInput {...defaultProps} streaming />);
    const buttons = screen.getAllByRole("button");
    // when streaming, stop button replaces send button (still last)
    fireEvent.click(buttons[buttons.length - 1]);
    expect(defaultProps.onStop).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleVoice when voice button is clicked", () => {
    render(<ChatInput {...defaultProps} />);
    const buttons = screen.getAllByRole("button");
    const voiceBtn = buttons[0];
    fireEvent.click(voiceBtn);
    expect(defaultProps.onToggleVoice).toHaveBeenCalledTimes(1);
  });

  it("disables textarea when streaming", () => {
    render(<ChatInput {...defaultProps} streaming />);
    const textarea = screen.getByPlaceholderText("输入消息…");
    expect(textarea).toBeDisabled();
  });

  it("shows recording icon when isRecording", () => {
    const { container } = render(<ChatInput {...defaultProps} isRecording />);
    // AudioOutlined has data-icon="audio"
    expect(container.querySelector("[data-icon='audio']")).toBeTruthy();
  });

  it("applies focus and blur styles", () => {
    render(<ChatInput {...defaultProps} />);
    const textarea = screen.getByPlaceholderText("输入消息…") as HTMLElement;
    fireEvent.focus(textarea);
    expect(textarea.style.borderColor).toBe("var(--c-accent)");
    fireEvent.blur(textarea);
    expect(textarea.style.borderColor).toBe("var(--c-border)");
  });
});
