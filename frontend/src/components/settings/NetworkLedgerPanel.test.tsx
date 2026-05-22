/**
 * @vitest-environment jsdom
 *
 * v2.32 — NetworkLedgerPanel tests (P1 #8).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import NetworkLedgerPanel from "./NetworkLedgerPanel";

vi.mock("../../api/client", () => ({
  api: { get: vi.fn() },
}));

import { api } from "../../api/client";

describe("NetworkLedgerPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders empty state when no entries", async () => {
    vi.mocked(api.get).mockResolvedValue({
      count: 0,
      total: 0,
      entries: [],
      path: "/tmp/ledger.jsonl",
      stats: {},
    });
    render(<NetworkLedgerPanel />);
    await waitFor(() => expect(screen.getByText(/0 条/)).toBeInTheDocument());
    expect(screen.getByText(/\/tmp\/ledger\.jsonl/)).toBeInTheDocument();
  });

  it("renders success row with formatted bytes + latency", async () => {
    vi.mocked(api.get).mockResolvedValue({
      count: 1,
      total: 1,
      entries: [
        {
          ts: "2026-05-22T10:00:00Z",
          event: "llm_call",
          endpoint: "lmstudio",
          base_url: "http://127.0.0.1:1234",
          model: "qwen3",
          success: true,
          latency_ms: 350,
          request_bytes: 2048,
          response_bytes: 512,
          error: null,
        },
      ],
      path: "/tmp/ledger.jsonl",
    });
    render(<NetworkLedgerPanel />);
    await waitFor(() => expect(screen.getByText("lmstudio")).toBeInTheDocument());
    // 2048 → "2.0 KB", 512 → "512 B"
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
    expect(screen.getByText(/512 B/)).toBeInTheDocument();
    expect(screen.getByText("350 ms")).toBeInTheDocument();
    expect(screen.getByText("成功")).toBeInTheDocument();
  });

  it("renders failure row with error tooltip", async () => {
    vi.mocked(api.get).mockResolvedValue({
      count: 1,
      total: 1,
      entries: [
        {
          ts: "2026-05-22T10:00:00Z",
          event: "llm_call",
          endpoint: "exo",
          base_url: "http://192.168.1.10",
          model: "kimi",
          success: false,
          latency_ms: 5021,
          request_bytes: null,
          response_bytes: null,
          error: "HTTPStatusError: Server error '502 Bad Gateway'",
        },
      ],
      path: "/tmp/ledger.jsonl",
    });
    render(<NetworkLedgerPanel />);
    await waitFor(() => expect(screen.getByText("失败")).toBeInTheDocument());
    // 5021ms → "5.02 s"
    expect(screen.getByText(/5\.02 s/)).toBeInTheDocument();
    expect(screen.getByText(/HTTPStatusError/)).toBeInTheDocument();
  });

  // ─────────────────────────────────────────────────────────────────────
  // v2.38 — error path coverage.
  // ─────────────────────────────────────────────────────────────────────

  it("v2.38: api.get rejection does not crash; Card title still renders", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error("connection refused"));
    render(<NetworkLedgerPanel />);
    await waitFor(() => {
      expect(screen.getByText(/网络出站审计/)).toBeInTheDocument();
    });
    // data stays null → the dynamic "<n> 条 / 总计 …" Tag (rendered ONLY
    // when data exists) should be absent. We anchor on the unique
    // "总计" prefix so we don't accidentally match the static "50 条"
    // string in the description paragraph above.
    expect(screen.queryByText(/总计/)).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
