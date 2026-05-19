/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LLMHealthPanel from "./LLMHealthPanel";

vi.mock("../../api/llm", () => ({
  llmApi: {
    stats: vi.fn(),
    recheck: vi.fn(),
  },
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  };
});

import { llmApi } from "../../api/llm";

const baseStats = {
  ok: true,
  status: "healthy" as const,
  total_count: 2,
  healthy_count: 2,
  monitor_running: true,
  endpoints: [
    {
      name: "primary",
      base_url: "http://p/v1",
      model_id: "model-1",
      provider: "openai",
      priority: 10,
      healthy: true,
      success_count: 42,
      failure_count: 0,
      avg_latency_ms: 250.5,
      last_latency_ms: 240,
      last_success_at: Date.now() / 1000 - 30,
      last_failure_at: null,
      last_error: null,
      unhealthy_since: null,
    },
    {
      name: "secondary",
      base_url: "http://s/v1",
      model_id: "model-2",
      provider: "openai",
      priority: 5,
      healthy: true,
      success_count: 0,
      failure_count: 0,
      avg_latency_ms: 0,
      last_latency_ms: 0,
      last_success_at: null,
      last_failure_at: null,
      last_error: null,
      unhealthy_since: null,
    },
  ],
};

describe("LLMHealthPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders endpoint rows after fetching stats", async () => {
    vi.mocked(llmApi.stats).mockResolvedValue(baseStats);

    render(<LLMHealthPanel />);

    expect(await screen.findByText("primary")).toBeInTheDocument();
    expect(screen.getByText("secondary")).toBeInTheDocument();
    expect(screen.getByText("model-1")).toBeInTheDocument();
    expect(screen.getByText(/全部在线 · 2\/2/)).toBeInTheDocument();
    expect(screen.getByText("监视中")).toBeInTheDocument();
  });

  it("shows degraded status when one endpoint is unhealthy", async () => {
    vi.mocked(llmApi.stats).mockResolvedValue({
      ...baseStats,
      status: "degraded",
      healthy_count: 1,
      endpoints: [
        baseStats.endpoints[0],
        {
          ...baseStats.endpoints[1],
          healthy: false,
          failure_count: 3,
          last_error: "ConnectError: refused",
        },
      ],
    });

    render(<LLMHealthPanel />);
    expect(await screen.findByText(/部分降级 · 1\/2/)).toBeInTheDocument();
    expect(screen.getByText("离线")).toBeInTheDocument();
    expect(screen.getByText("ConnectError: refused")).toBeInTheDocument();
  });

  it("recheck-all button calls recheck() without a name", async () => {
    vi.mocked(llmApi.stats).mockResolvedValue(baseStats);
    vi.mocked(llmApi.recheck).mockResolvedValue({ ok: true, probed: true });

    render(<LLMHealthPanel />);
    await screen.findByText("primary");

    const button = screen.getByText("全部重新探测");
    fireEvent.click(button);

    await waitFor(() => {
      expect(llmApi.recheck).toHaveBeenCalledWith(undefined);
    });
  });

  it("per-row recheck button passes the endpoint name", async () => {
    vi.mocked(llmApi.stats).mockResolvedValue(baseStats);
    vi.mocked(llmApi.recheck).mockResolvedValue({ ok: true, probed: true });

    render(<LLMHealthPanel />);
    await screen.findByText("primary");

    // Per-row "探测" buttons (one per endpoint)
    const rowButtons = screen.getAllByText("探测");
    expect(rowButtons.length).toBe(2);
    fireEvent.click(rowButtons[0]);

    await waitFor(() => {
      expect(llmApi.recheck).toHaveBeenCalledWith("primary");
    });
  });

  it("surfaces server error string when ok=false", async () => {
    vi.mocked(llmApi.stats).mockResolvedValue({
      ok: false,
      status: "unknown",
      total_count: 0,
      healthy_count: 0,
      monitor_running: false,
      endpoints: [],
      error: "chat engine not initialized",
    });

    render(<LLMHealthPanel />);
    expect(await screen.findByText("chat engine not initialized")).toBeInTheDocument();
  });
});
