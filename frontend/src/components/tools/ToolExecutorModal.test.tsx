/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ToolExecutorModal from "./ToolExecutorModal";

const executeTool = vi.fn();
const writeText = vi.fn();

vi.mock("../../stores/toolStore", () => ({
  useToolStore: () => ({ executeTool }),
}));

vi.mock("../../hooks/useTheme", () => ({
  useIsDark: () => false,
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual("antd");
  return {
    ...actual,
    message: {
      success: vi.fn(),
      error: vi.fn(),
    },
  };
});

import { message } from "antd";

describe("ToolExecutorModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: writeText } });
  });

  it("renders when open", () => {
    render(<ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />);
    expect(screen.getByText(/测试工具: shell/)).toBeInTheDocument();
    expect(screen.getByText("Run shell")).toBeInTheDocument();
  });

  it("loads preset params on open", () => {
    render(<ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("echo Hello WeBrain")).toBeInTheDocument();
  });

  it("shows empty params message when no preset", () => {
    render(<ToolExecutorModal toolName="unknown" toolDescription="Unknown" open={true} onClose={vi.fn()} />);
    expect(screen.getByText("此工具暂无参数")).toBeInTheDocument();
  });

  it("updates string param", () => {
    render(<ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />);
    const input = screen.getByDisplayValue("echo Hello WeBrain");
    fireEvent.change(input, { target: { value: "echo hi" } });
    expect(screen.getByDisplayValue("echo hi")).toBeInTheDocument();
  });

  it("updates number param", () => {
    render(<ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />);
    const numInput = screen.getByDisplayValue("30000");
    fireEvent.change(numInput, { target: { value: "60000" } });
    expect(screen.getByDisplayValue("60000")).toBeInTheDocument();
  });

  it("executes tool successfully", async () => {
    vi.mocked(executeTool).mockResolvedValue({ ok: true, result: { output: "hello" } });
    render(<ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("执行"));
    await waitFor(() => {
      expect(executeTool).toHaveBeenCalledWith("shell", expect.any(Object));
      expect(message.success).toHaveBeenCalledWith("执行成功");
    });
  });

  it("executes tool with error response", async () => {
    vi.mocked(executeTool).mockResolvedValue({ ok: false, error: "failed" });
    render(<ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("执行"));
    await waitFor(() => {
      expect(screen.getByText("failed")).toBeInTheDocument();
      expect(message.error).toHaveBeenCalledWith("failed");
    });
  });

  it("handles execution exception", async () => {
    vi.mocked(executeTool).mockRejectedValue(new Error("network"));
    render(<ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("执行"));
    await waitFor(() => {
      expect(screen.getByText("network")).toBeInTheDocument();
      expect(message.error).toHaveBeenCalledWith("network");
    });
  });

  it("adds custom param", () => {
    render(<ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />);
    const keyInput = screen.getByPlaceholderText("参数名");
    const valInput = screen.getByPlaceholderText("值（支持 JSON）");
    fireEvent.change(keyInput, { target: { value: "custom" } });
    fireEvent.change(valInput, { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: /plus/i }) || screen.getAllByRole("button").find(b => b.querySelector("[data-icon='plus']"))!);
    expect(screen.getByText("custom")).toBeInTheDocument();
  });

  it("removes a param", () => {
    render(<ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />);
    const deleteBtns = screen.getAllByRole("button").filter(b => b.querySelector("[data-icon='delete']"));
    if (deleteBtns.length > 0) {
      fireEvent.click(deleteBtns[0]);
      // After deletion, the param should be gone
      expect(screen.queryByDisplayValue("echo Hello WeBrain")).not.toBeInTheDocument();
    }
  });

  it("copies result to clipboard", async () => {
    vi.mocked(executeTool).mockResolvedValue({ ok: true, result: { output: "hello" } });
    render(<ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("执行"));
    await waitFor(() => {
      expect(screen.getByText("复制")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("复制"));
    expect(writeText).toHaveBeenCalled();
    expect(message.success).toHaveBeenCalledWith("已复制");
  });

  it("resets state when reopened with different tool", () => {
    const { rerender } = render(
      <ToolExecutorModal toolName="shell" toolDescription="Run shell" open={true} onClose={vi.fn()} />
    );
    expect(screen.getByDisplayValue("echo Hello WeBrain")).toBeInTheDocument();
    rerender(<ToolExecutorModal toolName="file_read" toolDescription="Read file" open={true} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("./README.md")).toBeInTheDocument();
  });
});
