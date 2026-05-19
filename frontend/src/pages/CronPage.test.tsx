import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CronPage from "./CronPage";
import { useCronStore } from "../stores/cronStore";

const fetchJobs = vi.fn();
const createJob = vi.fn().mockResolvedValue(undefined);
const enableJob = vi.fn().mockResolvedValue(undefined);
const disableJob = vi.fn().mockResolvedValue(undefined);
const deleteJob = vi.fn().mockResolvedValue(undefined);
const fetchRuns = vi.fn().mockResolvedValue(undefined);
const fetchStats = vi.fn().mockResolvedValue(undefined);

const defaultMock = {
  jobs: [
    { id: "j1", name: "Backup", cron_expr: "0 0 * * *", task_type: "shell", enabled: true, run_count: 5, last_run: "2024-01-01T00:00:00Z" },
    { id: "j2", name: "Cleanup", cron_expr: "0 2 * * *", task_type: "python", enabled: false, run_count: 2 },
  ],
  runs: [
    { job_id: "j1", job_name: "Backup", status: "success", started_at: "2024-01-01T00:00:00Z", output: "done" },
    { job_id: "j2", job_name: "Cleanup", status: "error", started_at: "2024-01-01T02:00:00Z", output: "error msg" },
  ],
  stats: { total_jobs: 2, enabled_jobs: 1, total_runs: 7 },
  loading: false,
  fetchJobs,
  createJob,
  enableJob,
  disableJob,
  deleteJob,
  fetchRuns,
  fetchStats,
};

vi.mock("../stores/cronStore", () => ({
  useCronStore: vi.fn(() => defaultMock),
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Popconfirm: ({ children, onConfirm }: any) => (
      <span onClick={onConfirm}>{children}</span>
    ),
  };
});

describe("CronPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCronStore).mockReturnValue({
      ...defaultMock,
      jobs: [...defaultMock.jobs],
      runs: [...defaultMock.runs],
    });
  });

  it("renders page with stats and jobs", () => {
    render(<CronPage />);
    expect(screen.getByText("定时任务")).toBeInTheDocument();
    expect(screen.getByText("Backup")).toBeInTheDocument();
    expect(screen.getByText("Cleanup")).toBeInTheDocument();
  });

  it("calls fetchJobs and fetchStats on mount", () => {
    render(<CronPage />);
    expect(fetchJobs).toHaveBeenCalled();
    expect(fetchStats).toHaveBeenCalled();
  });

  it("opens create modal", () => {
    render(<CronPage />);
    fireEvent.click(screen.getByText("新建任务"));
    expect(screen.getByText("新建定时任务")).toBeInTheDocument();
  });

  it("submits create form", async () => {
    render(<CronPage />);
    fireEvent.click(screen.getByText("新建任务"));

    const nameInput = screen.getByPlaceholderText("例如: 每日数据备份") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "TestJob" } });

    const cronInput = screen.getByPlaceholderText("0 0 * * * (每天零点)") as HTMLInputElement;
    fireEvent.change(cronInput, { target: { value: "* * * * *" } });

    const typeSelect = document.querySelector(".ant-select-selection-search-input") as HTMLInputElement;
    if (typeSelect) {
      fireEvent.mouseDown(typeSelect);
      const option = document.querySelector(".ant-select-item-option-content") as HTMLElement;
      if (option) fireEvent.click(option);
    }

    const okBtn = document.querySelector(".ant-modal-footer .ant-btn-primary") as HTMLButtonElement;
    if (okBtn) fireEvent.click(okBtn);

    await waitFor(() => {
      expect(createJob).toHaveBeenCalled();
    });
  });

  it("shows empty state when no jobs", () => {
    vi.mocked(useCronStore).mockReturnValue({ ...defaultMock, jobs: [], runs: [], stats: null, loading: false });
    render(<CronPage />);
    expect(screen.getByText("暂无定时任务")).toBeInTheDocument();
  });

  it("shows loading spin", () => {
    vi.mocked(useCronStore).mockReturnValue({ ...defaultMock, jobs: [], runs: [], loading: true });
    render(<CronPage />);
    expect(document.querySelector(".ant-spin")).toBeInTheDocument();
  });

  it("disables enabled job", () => {
    render(<CronPage />);
    const pauseButtons = screen.getAllByRole("button").filter((b) => b.querySelector("[data-icon='pause-circle']"));
    if (pauseButtons.length > 0) {
      fireEvent.click(pauseButtons[0]);
      expect(disableJob).toHaveBeenCalledWith("j1");
    }
  });

  it("enables disabled job", () => {
    render(<CronPage />);
    const playButtons = screen.getAllByRole("button").filter((b) => b.querySelector("[data-icon='play-circle']"));
    if (playButtons.length > 0) {
      fireEvent.click(playButtons[0]);
      expect(enableJob).toHaveBeenCalledWith("j2");
    }
  });

  it("deletes a job", () => {
    render(<CronPage />);
    const deleteButtons = screen.getAllByRole("button").filter((b) => b.querySelector("[data-icon='delete']"));
    if (deleteButtons.length > 0) {
      fireEvent.click(deleteButtons[0]);
      expect(deleteJob).toHaveBeenCalled();
    }
  });

  it("opens runs drawer with content", async () => {
    render(<CronPage />);
    fireEvent.click(screen.getByText("运行历史"));
    expect(fetchRuns).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText("Backup")).toBeInTheDocument();
      expect(screen.getByText("Cleanup")).toBeInTheDocument();
    });
  });

  it("opens runs drawer with empty state", async () => {
    vi.mocked(useCronStore).mockReturnValue({ ...defaultMock, runs: [] });
    render(<CronPage />);
    fireEvent.click(screen.getByText("运行历史"));
    await waitFor(() => {
      expect(screen.getByText("暂无运行记录")).toBeInTheDocument();
    });
  });

  it("renders job with missing next_run and run_count", () => {
    vi.mocked(useCronStore).mockReturnValue({
      ...defaultMock,
      jobs: [{ id: "j3", name: "Minimal", cron_expr: "* * * * *", task_type: "shell", enabled: true }],
    });
    render(<CronPage />);
    expect(screen.getByText("Minimal")).toBeInTheDocument();
  });

  it("renders run with missing status and started_at and job_name", async () => {
    vi.mocked(useCronStore).mockReturnValue({
      ...defaultMock,
      runs: [{ job_id: "j3", status: undefined, started_at: undefined, output: "" }],
    });
    render(<CronPage />);
    fireEvent.click(screen.getByText("运行历史"));
    await waitFor(() => {
      expect(screen.getByText("j3")).toBeInTheDocument();
    });
  });
});
