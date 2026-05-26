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
    message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  };
});

// Plan execution API mocked for the "execute plan" button tests
vi.mock("../../api/plan", () => ({
  planApi: {
    execute: vi.fn(),
    executeStream: vi.fn().mockImplementation((_params, onEvent, onDone) => {
      // Default mock: immediately complete with empty result
      onEvent?.({ event: "plan_complete", result: { ok: true, overall_success: true, results: [] } });
      onDone?.();
      return { connect: vi.fn(), abort: vi.fn() };
    }),
  },
}));
import { planApi } from "../../api/plan";

describe("MessageBubble", () => {
  it("renders user message", () => {
    render(<MessageBubble msg={{ id: "1", role: "user", content: "Hello", timestamp: Date.now() }} isDark={false} />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("renders assistant message with markdown", () => {
    render(
      <MessageBubble msg={{ id: "1", role: "assistant", content: "**bold**", timestamp: Date.now() }} isDark={false} />
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
      <MessageBubble msg={{ id: "1", role: "assistant", content: "Copy me", timestamp: Date.now() }} isDark={false} />
    );
    const copyBtn = screen.getByRole("button");
    await fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Copy me");
  });

  it("renders timestamp when provided", () => {
    const ts = new Date("2024-01-15T10:30:00").getTime();
    render(<MessageBubble msg={{ id: "1", role: "assistant", content: "Hi", timestamp: ts }} isDark={false} />);
    expect(screen.getByText(/1月15日/i)).toBeInTheDocument();
  });

  // Round K3: badge format changed from a single "参考 N 篇文档" pill
  // to numbered footnote pills `[1] [2]` next to a "来源" label, each
  // pill independently hover-able and linking into the wiki.
  it("renders RAG sources as numbered footnote pills when ragSources is present", () => {
    render(
      <MessageBubble
        msg={{
          id: "1",
          role: "assistant",
          content: "Per notes, the answer is X.",
          ragSources: [
            { doc_path: "/notes/topic-a.md", chunk_idx: 0, score: 0.91 },
            { doc_path: "/notes/topic-b.md", chunk_idx: 2, score: 0.74 },
          ],
          timestamp: Date.now(),
        }}
        isDark={false}
      />
    );
    expect(screen.getByText("来源")).toBeInTheDocument();
    expect(screen.getByText("[1]")).toBeInTheDocument();
    expect(screen.getByText("[2]")).toBeInTheDocument();
  });

  it("omits RAG label when no ragSources present", () => {
    render(<MessageBubble msg={{ id: "1", role: "assistant", content: "Hi", timestamp: Date.now() }} isDark={false} />);
    expect(screen.queryByText("来源")).not.toBeInTheDocument();
    expect(screen.queryByText(/^\[\d+\]$/)).not.toBeInTheDocument();
  });

  it("renders plan task list when plan is present", () => {
    render(
      <MessageBubble
        msg={{
          id: "1",
          role: "assistant",
          content: "Working on it.",
          plan: {
            plan_id: "plan-1",
            user_input: "complex multi-step",
            confidence: 0.8,
            reasoning: "two atomic steps",
            tasks: [
              { id: "task-1", description: "读取 notes.md", requires_tool: true, tool_hint: "read_file" },
              { id: "task-2", description: "总结要点", requires_tool: false },
            ],
          },
          timestamp: Date.now(),
        }}
        isDark={false}
      />
    );
    expect(screen.getByText("读取 notes.md")).toBeInTheDocument();
    expect(screen.getByText("总结要点")).toBeInTheDocument();
    expect(screen.getByText(/规划 2 步任务/)).toBeInTheDocument();
    expect(screen.getByText("read_file")).toBeInTheDocument();
    expect(screen.getByText("two atomic steps")).toBeInTheDocument();
  });

  it("omits plan block when plan is absent or empty", () => {
    const { rerender } = render(
      <MessageBubble msg={{ id: "1", role: "assistant", content: "Hi", timestamp: Date.now() }} isDark={false} />
    );
    expect(screen.queryByText(/规划 \d+ 步任务/)).not.toBeInTheDocument();

    // Empty tasks → still no rendering
    rerender(
      <MessageBubble
        msg={{
          id: "1",
          role: "assistant",
          content: "Hi",
          plan: {
            plan_id: "plan-empty",
            user_input: "x",
            confidence: 0,
            reasoning: "",
            tasks: [],
          },
          timestamp: Date.now(),
        }}
        isDark={false}
      />
    );
    expect(screen.queryByText(/规划 \d+ 步任务/)).not.toBeInTheDocument();
  });

  it("renders the execute-plan button when plan is present", () => {
    render(
      <MessageBubble
        msg={{
          id: "1",
          role: "assistant",
          content: "Working",
          plan: {
            plan_id: "p1",
            user_input: "x",
            confidence: 0.5,
            reasoning: "",
            tasks: [{ id: "task-1", description: "step one" }],
          },
          timestamp: Date.now(),
        }}
        isDark={false}
      />
    );
    expect(screen.getByText("执行计划")).toBeInTheDocument();
  });

  it("calls planApi.execute when the execute button is clicked", async () => {
    vi.mocked(planApi.execute).mockResolvedValue({
      ok: true,
      overall_success: true,
      total_attempts: 1,
      failed_task_ids: [],
      results: [
        {
          task_id: "task-1",
          description: "step one",
          final_output: "done",
          succeeded: true,
          attempts: [
            {
              attempt_idx: 1,
              output: "done",
              verification_passed: true,
              verification_reason: "ok",
              strategy: "default",
              duration_ms: 50,
            },
          ],
        },
      ],
    });

    const plan = {
      plan_id: "p1",
      user_input: "x",
      confidence: 0.5,
      reasoning: "",
      tasks: [{ id: "task-1", description: "step one" }],
    };

    vi.mocked(planApi.executeStream).mockImplementation((_params, onEvent, onDone) => {
      onEvent?.({
        event: "plan_complete",
        result: {
          ok: true,
          overall_success: true,
          total_attempts: 1,
          results: [
            {
              task_id: "task-1",
              description: "step one",
              final_output: "done",
              succeeded: true,
              attempts: [{ attempt_idx: 1, output: "done", verification_passed: true, verification_reason: "ok", strategy: "default", duration_ms: 50 }],
            },
          ],
        },
      });
      onDone?.();
      return { connect: vi.fn(), abort: vi.fn() };
    });

    render(
      <MessageBubble msg={{ id: "1", role: "assistant", content: "Hi", plan, timestamp: Date.now() }} isDark={false} />
    );

    const button = screen.getByText("执行计划");
    fireEvent.click(button);

    await screen.findByText(/全部通过/);
    expect(planApi.executeStream).toHaveBeenCalledWith({ plan, verify: "presence" }, expect.any(Function), expect.any(Function), expect.any(Function));
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("surfaces failed task summary when execution partially fails", async () => {
    vi.mocked(planApi.executeStream).mockImplementation((_params, onEvent, onDone) => {
      onEvent?.({
        event: "plan_complete",
        result: {
          ok: true,
          overall_success: false,
          total_attempts: 6,
          failed_task_ids: ["task-2"],
          results: [
            {
              task_id: "task-1",
              description: "step one",
              final_output: "ok",
              succeeded: true,
              attempts: [
                {
                  attempt_idx: 1,
                  output: "ok",
                  verification_passed: true,
                  verification_reason: "ok",
                  strategy: "default",
                  duration_ms: 10,
                },
              ],
            },
            {
              task_id: "task-2",
              description: "broken step",
              final_output: "",
              succeeded: false,
              attempts: [
                {
                  attempt_idx: 1,
                  output: "",
                  verification_passed: false,
                  verification_reason: "empty",
                  strategy: "default",
                  duration_ms: 5,
                },
              ],
            },
          ],
        },
      });
      onDone?.();
      return { connect: vi.fn(), abort: vi.fn() };
    });

    render(
      <MessageBubble
        msg={{
          id: "1",
          role: "assistant",
          content: "Hi",
          plan: {
            plan_id: "p1",
            user_input: "x",
            confidence: 0.5,
            reasoning: "",
            tasks: [
              { id: "task-1", description: "step one" },
              { id: "task-2", description: "broken step" },
            ],
          },
          timestamp: Date.now(),
        }}
        isDark={false}
      />
    );

    fireEvent.click(screen.getByText("执行计划"));
    await screen.findByText(/1 个失败/);
  });

  it("collapses plan content when toggle is clicked", () => {
    render(
      <MessageBubble
        msg={{
          id: "1",
          role: "assistant",
          content: "Hi",
          plan: {
            plan_id: "plan-1",
            user_input: "x",
            confidence: 0.5,
            reasoning: "",
            tasks: [{ id: "task-1", description: "step one" }],
          },
          timestamp: Date.now(),
        }}
        isDark={false}
      />
    );
    expect(screen.getByText("step one")).toBeInTheDocument();
    const toggle = screen.getByText(/规划 1 步任务/);
    fireEvent.click(toggle);
    expect(screen.queryByText("step one")).not.toBeInTheDocument();
  });
  it("renders skill draft created hint when skillDraftCreated is present", () => {
    render(
      <MessageBubble
        msg={{
          id: "1",
          role: "assistant",
          content: "Hi",
          skillDraftCreated: { skillId: "draft-1", name: "AutoSkill" },
          timestamp: Date.now(),
        }}
        isDark={false}
      />
    );
    expect(screen.getByText(/系统已为你自动创建了一个新 skill: AutoSkill/)).toBeInTheDocument();
    expect(screen.getByText(/前往 Skillhub → Drafts 查看/)).toBeInTheDocument();
  });

  it("omits skill draft hint when skillDraftCreated is absent", () => {
    render(<MessageBubble msg={{ id: "1", role: "assistant", content: "Hi", timestamp: Date.now() }} isDark={false} />);
    expect(screen.queryByText(/系统已为你自动创建了一个新 skill/)).not.toBeInTheDocument();
  });
});