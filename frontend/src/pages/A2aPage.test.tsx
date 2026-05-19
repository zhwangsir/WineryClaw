import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import A2aPage from "./A2aPage";
import { useA2aStore } from "../stores/a2aStore";

const fetchTasks = vi.fn();
const sendTask = vi.fn().mockResolvedValue(undefined);

const defaultMock = {
  tasks: [
    { taskId: "t1", agentId: "a1", type: "delegate", status: "completed", createdAt: new Date().toISOString() },
    { taskId: "t2", agentId: "a2", type: "request", status: "unknown", createdAt: new Date().toISOString() },
  ],
  loading: false,
  fetchTasks,
  sendTask,
};

vi.mock("../stores/a2aStore", () => ({
  useA2aStore: vi.fn(() => defaultMock),
}));

describe("A2aPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useA2aStore).mockReturnValue({ ...defaultMock, tasks: [...defaultMock.tasks] });
  });

  it("renders tasks", () => {
    render(<A2aPage />);
    expect(screen.getByText("A2A")).toBeInTheDocument();
    expect(screen.getByText("delegate")).toBeInTheDocument();
    expect(screen.getByText("request")).toBeInTheDocument();
  });

  it("calls fetchTasks on mount", () => {
    render(<A2aPage />);
    expect(fetchTasks).toHaveBeenCalled();
  });

  it("shows empty state when no tasks", () => {
    vi.mocked(useA2aStore).mockReturnValue({ ...defaultMock, tasks: [] });
    render(<A2aPage />);
    expect(screen.getByText("暂无 A2A 任务")).toBeInTheDocument();
  });

  it("opens send drawer", () => {
    render(<A2aPage />);
    fireEvent.click(screen.getByText("发送任务"));
    expect(screen.getByText("发送 A2A 任务")).toBeInTheDocument();
  });

  it("closes send drawer", async () => {
    render(<A2aPage />);
    fireEvent.click(screen.getByText("发送任务"));
    expect(document.querySelector(".ant-drawer-open")).toBeTruthy();

    const closeBtn = document.querySelector(".ant-drawer-close") as HTMLButtonElement;
    if (closeBtn) fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(document.querySelector(".ant-drawer-open")).not.toBeInTheDocument();
    });
  });

  it("submits send form", async () => {
    render(<A2aPage />);
    fireEvent.click(screen.getByText("发送任务"));

    const inputs = document.querySelectorAll("input");
    if (inputs.length > 0) fireEvent.change(inputs[0], { target: { value: "sender1" } });
    if (inputs.length > 1) fireEvent.change(inputs[1], { target: { value: "receiver1" } });
    if (inputs.length > 2) fireEvent.change(inputs[2], { target: { value: "delegate" } });

    const submitBtn = document.querySelector('.ant-drawer button[type="submit"]') as HTMLButtonElement;
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(sendTask).toHaveBeenCalledWith("sender1", "receiver1", "delegate");
    });
  });

  it("shows validation error when fields empty", async () => {
    render(<A2aPage />);
    fireEvent.click(screen.getByText("发送任务"));

    const submitBtn = document.querySelector('.ant-drawer button[type="submit"]') as HTMLButtonElement;
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(sendTask).not.toHaveBeenCalled();
    });
  });
});
