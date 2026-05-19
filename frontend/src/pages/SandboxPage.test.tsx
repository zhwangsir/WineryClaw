/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import SandboxPage from "./SandboxPage";

const fetchStatus = vi.fn();
const fetchStats = vi.fn();
const fetchAudit = vi.fn();
const execute = vi.fn();
const executePython = vi.fn();

function createMockStore(overrides: Partial<Parameters<typeof useSandboxStore>[0]> = {}) {
  return {
    available: true,
    stats: { cpu: 12, memory: 256 },
    logs: [
      { agentId: "agent-1", action: "exec", timestamp: "2024-01-01T00:00:00Z" },
    ],
    fetchStatus,
    fetchStats,
    fetchAudit,
    execute,
    executePython,
    ...overrides,
  };
}

vi.mock("../stores/sandboxStore", () => ({
  useSandboxStore: vi.fn(() => createMockStore()),
}));

import { useSandboxStore } from "../stores/sandboxStore";

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Card: ({ children, title, extra, bodyStyle, ...rest }: any) => (
      <div data-testid="card" {...rest}>
        {title && <div data-testid="card-title">{title}</div>}
        {extra && <div data-testid="card-extra">{extra}</div>}
        <div style={bodyStyle}>{children}</div>
      </div>
    ),
  };
});

describe("SandboxPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSandboxStore).mockImplementation(() => createMockStore() as any);
  });

  it("renders page shell", () => {
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );
    expect(screen.getByText("沙箱")).toBeInTheDocument();
  });

  it("fetches status, stats and audit on mount", () => {
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );
    expect(fetchStatus).toHaveBeenCalled();
    expect(fetchStats).toHaveBeenCalled();
    expect(fetchAudit).toHaveBeenCalledWith(undefined, 50);
  });

  it("shows unavailable status when available is false", () => {
    vi.mocked(useSandboxStore).mockImplementation(() =>
      createMockStore({ available: false, stats: {}, logs: [] }) as any
    );
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );
    expect(screen.getByText("不可用")).toBeInTheDocument();
  });

  it("renders stats cards", () => {
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );
    expect(screen.getByText("cpu")).toBeInTheDocument();
    expect(screen.getByText("memory")).toBeInTheDocument();
  });

  it("renders audit logs table when logs exist", () => {
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );
    expect(screen.getByText("agent-1")).toBeInTheDocument();
    expect(screen.getByText("exec")).toBeInTheDocument();
  });

  it("shows empty when no audit logs", () => {
    vi.mocked(useSandboxStore).mockImplementation(() =>
      createMockStore({ logs: [] }) as any
    );
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );
    expect(screen.getByText("暂无审计日志")).toBeInTheDocument();
  });

  it("refreshes audit logs on click", () => {
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );
    const refreshBtn = screen.getByText("刷新");
    fireEvent.click(refreshBtn);
    expect(fetchAudit).toHaveBeenCalledTimes(2);
  });

  it("executes shell command and shows result", async () => {
    execute.mockResolvedValue({ stdout: "hello", stderr: "", exitCode: 0 });
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );

    const shellTextareas = screen.getAllByPlaceholderText("输入 shell 命令...");
    fireEvent.change(shellTextareas[0], { target: { value: "echo hello" } });

    const execButtons = screen.getAllByRole("button", { name: /执行/i });
    fireEvent.click(execButtons[0]);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith("echo hello");
    });
    await waitFor(() => {
      expect(screen.getByText("hello")).toBeInTheDocument();
    });
    expect(screen.getByText("Exit: 0")).toBeInTheDocument();
  });

  it("executes python code and shows result with stderr", async () => {
    executePython.mockResolvedValue({ stdout: "", stderr: "error", exitCode: 1 });
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );

    const pythonTextareas = screen.getAllByPlaceholderText("输入 Python 代码...");
    fireEvent.change(pythonTextareas[0], { target: { value: "raise Exception" } });

    const execButtons = screen.getAllByRole("button", { name: /执行/i });
    fireEvent.click(execButtons[1]);

    await waitFor(() => {
      expect(executePython).toHaveBeenCalledWith("raise Exception");
    });
    await waitFor(() => {
      expect(screen.getByText("error")).toBeInTheDocument();
    });
    expect(screen.getByText("Exit: 1")).toBeInTheDocument();
  });

  it("does not execute when command is empty", async () => {
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );
    const execButtons = screen.getAllByRole("button", { name: /执行/i });
    fireEvent.click(execButtons[0]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("hides result when exec returns null", async () => {
    execute.mockResolvedValue(null);
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );
    const shellTextareas = screen.getAllByPlaceholderText("输入 shell 命令...");
    fireEvent.change(shellTextareas[0], { target: { value: "ls" } });
    const execButtons = screen.getAllByRole("button", { name: /执行/i });
    fireEvent.click(execButtons[0]);

    await waitFor(() => {
      expect(execute).toHaveBeenCalled();
    });
    expect(screen.queryByText("执行结果")).not.toBeInTheDocument();
  });

  it("does not execute python when code is empty", () => {
    render(
      <BrowserRouter>
        <SandboxPage />
      </BrowserRouter>
    );
    const pythonTextareas = screen.getAllByPlaceholderText("输入 Python 代码...");
    fireEvent.change(pythonTextareas[0], { target: { value: "" } });
    const execButtons = screen.getAllByRole("button", { name: /执行/i });
    fireEvent.click(execButtons[1]);
    expect(executePython).not.toHaveBeenCalled();
  });
});
