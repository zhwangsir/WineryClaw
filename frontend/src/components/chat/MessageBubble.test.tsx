/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MessageBubble from "./MessageBubble";

Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

vi.mock("../common/MarkdownRenderer", () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

vi.mock("./StreamingText", () => ({
  default: ({ content }: { content: string }) => <div data-testid="streaming">{content}</div>,
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    message: { error: vi.fn(), success: vi.fn() },
  };
});

describe("MessageBubble", () => {
  it("renders user message", () => {
    render(
      <MessageBubble
        msg={{ id: "1", role: "user", content: "Hello", timestamp: Date.now() }}
        isDark={false}
      />
    );
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("renders assistant message with markdown", () => {
    render(
      <MessageBubble
        msg={{ id: "1", role: "assistant", content: "**bold**", timestamp: Date.now() }}
        isDark={false}
      />
    );
    expect(screen.getByTestId("markdown")).toBeInTheDocument();
  });

  it("renders streaming message with StreamingText", () => {
    render(
      <MessageBubble
        msg={{ id: "1", role: "assistant", content: "Stream", isStreaming: true, timestamp: Date.now() }}
        isDark={false}
      />
    );
    expect(screen.getByTestId("streaming")).toBeInTheDocument();
  });

  it("renders reasoning section when reasoning is present", () => {
    render(
      <MessageBubble
        msg={{ id: "1", role: "assistant", content: "Hi", reasoning: "I think...", timestamp: Date.now() }}
        isDark={false}
      />
    );
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("I think...")).toBeInTheDocument();
  });

  it("toggles reasoning visibility on click", () => {
    render(
      <MessageBubble
        msg={{ id: "1", role: "assistant", content: "Hi", reasoning: "I think...", timestamp: Date.now() }}
        isDark={false}
      />
    );
    const toggleBtn = screen.getByText("思考过程");
    fireEvent.click(toggleBtn);
    expect(screen.queryByText("I think...")).not.toBeInTheDocument();
    fireEvent.click(toggleBtn);
    expect(screen.getByText("I think...")).toBeInTheDocument();
  });

  it("renders tool calls when present", () => {
    render(
      <MessageBubble
        msg={{
          id: "1",
          role: "assistant",
          content: "Hi",
          toolCalls: [{ function: { name: "search" }, id: "tc1", type: "function" }],
          timestamp: Date.now(),
        }}
        isDark={false}
      />
    );
    expect(screen.getByText("search")).toBeInTheDocument();
  });

  it("copies message content when copy button is clicked", async () => {
    render(
      <MessageBubble
        msg={{ id: "1", role: "assistant", content: "Copy me", timestamp: Date.now() }}
        isDark={false}
      />
    );
    const copyBtn = screen.getByRole("button");
    await fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Copy me");
  });

  it("renders timestamp when provided", () => {
    const ts = new Date("2024-01-15T10:30:00").getTime();
    render(
      <MessageBubble
        msg={{ id: "1", role: "assistant", content: "Hi", timestamp: ts }}
        isDark={false}
      />
    );
    expect(screen.getByText(/1月15日/i)).toBeInTheDocument();
  });
});
