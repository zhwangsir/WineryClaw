import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MessageList from "./MessageList";

vi.mock("../../hooks/useTheme", () => ({
  useIsDark: () => false,
}));

describe("MessageList", () => {
  const baseProps = {
    messages: [],
    highlight: "",
    streaming: false,
    showScrollBtn: false,
    onScroll: vi.fn(),
    onScrollToBottom: vi.fn(),
    containerRef: vi.fn(),
  };

  it("renders empty state when no messages", () => {
    render(<MessageList {...baseProps} />);
    expect(screen.getByText(/输入消息开始对话/)).toBeInTheDocument();
  });

  it("renders message bubbles", () => {
    const messages = [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "hi" },
    ];
    render(<MessageList {...baseProps} messages={messages} />);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
  });

  it("shows scroll button when showScrollBtn is true", () => {
    render(<MessageList {...baseProps} showScrollBtn={true} />);
    const btn = screen.getByRole("button");
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(baseProps.onScrollToBottom).toHaveBeenCalled();
  });

  it("calls onScroll when scrolling", () => {
    render(<MessageList {...baseProps} />);
    const container = screen.getByText(/输入消息开始对话/).closest(".chat-scroll-container");
    if (container) {
      fireEvent.scroll(container);
      expect(baseProps.onScroll).toHaveBeenCalled();
    }
  });
});
