/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import MetricsPage from "./MetricsPage";
import { metricsApi } from "../api/metrics";

vi.mock("../api/metrics", () => ({
  metricsApi: {
    query: vi.fn(),
  },
}));

describe("MetricsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(metricsApi.query).mockResolvedValue({ cpu: 0.5, memory: 1024 });
  });

  const renderPage = () =>
    render(
      <BrowserRouter>
        <MetricsPage />
      </BrowserRouter>
    );

  it("renders page shell", () => {
    renderPage();
    expect(screen.getByText("指标")).toBeInTheDocument();
  });

  it("fetches metrics on mount", async () => {
    renderPage();
    await waitFor(() => {
      expect(metricsApi.query).toHaveBeenCalledWith(undefined);
    });
  });

  it("shows empty state initially", async () => {
    vi.mocked(metricsApi.query).mockResolvedValue(null as any);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("暂无指标数据")).toBeInTheDocument();
    });
  });

  it("queries with name filter", async () => {
    renderPage();
    await waitFor(() => expect(metricsApi.query).toHaveBeenCalled());

    const input = screen.getByPlaceholderText("指标名称（可选）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "cpu" } });

    const queryBtn = screen.getByRole("button", { name: /查询/i });
    fireEvent.click(queryBtn);

    await waitFor(() => {
      expect(metricsApi.query).toHaveBeenCalledWith("cpu");
    });
  });

  it("displays success result", async () => {
    vi.mocked(metricsApi.query).mockResolvedValue({ cpu: 0.5 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/"cpu"/)).toBeInTheDocument();
    });
  });

  it("displays error result", async () => {
    vi.mocked(metricsApi.query).mockRejectedValue(new Error("timeout"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("timeout")).toBeInTheDocument();
    });
  });

  it("shows loading state on button", async () => {
    vi.mocked(metricsApi.query).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({}), 50)));
    renderPage();
    const queryBtn = screen.getByRole("button", { name: /查询/i });
    fireEvent.click(queryBtn);
    await waitFor(() => {
      expect(queryBtn.classList.contains("ant-btn-loading")).toBe(true);
    });
  });

  it("displays error result without message", async () => {
    vi.mocked(metricsApi.query).mockRejectedValue({});
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("查询失败")).toBeInTheDocument();
    });
  });
});
