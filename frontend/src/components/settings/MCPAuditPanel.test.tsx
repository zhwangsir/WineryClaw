/**
 * @vitest-environment jsdom
 *
 * v2.32 — MCPAuditPanel tests (P1 #8).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MCPAuditPanel from "./MCPAuditPanel";

vi.mock("../../api/client", () => ({
  api: { get: vi.fn() },
}));

import { api } from "../../api/client";

describe("MCPAuditPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders empty state with zeroed stats", async () => {
    vi.mocked(api.get).mockResolvedValue({
      count: 0,
      entries: [],
      path: "/tmp/mcp.jsonl",
      stats: { total: 0, by_tool: {}, by_scope: {}, success: 0, failure: 0 },
    });
    render(<MCPAuditPanel />);
    await waitFor(() => expect(screen.getByText(/总计 0 条/)).toBeInTheDocument());
  });

  it("renders success row with redacted args_summary", async () => {
    vi.mocked(api.get).mockResolvedValue({
      count: 1,
      entries: [
        {
          ts: "2026-05-22T10:00:00Z",
          tool: "memory_store",
          scope: "write",
          success: true,
          latency_ms: 12.34,
          args_summary: { level: "L3", content: { len: 42 } },
          result_preview: '{"ok":true}',
          error: null,
          bearer_id: "sha256:abcdef012345",
          request_id: null,
        },
      ],
      path: "/tmp/mcp.jsonl",
      stats: { total: 1, by_tool: { memory_store: 1 }, by_scope: { write: 1 }, success: 1, failure: 0 },
    });
    render(<MCPAuditPanel />);
    await waitFor(() => expect(screen.getByText("memory_store")).toBeInTheDocument());
    expect(screen.getByText("sha256:abcdef012345")).toBeInTheDocument();
    expect(screen.getByText("write")).toBeInTheDocument();
    // args_summary preview is JSON-encoded
    expect(screen.getByText(/"len":42/)).toBeInTheDocument();
  });

  it("computes success rate from stats", async () => {
    vi.mocked(api.get).mockResolvedValue({
      count: 4,
      entries: [],
      path: "/tmp/mcp.jsonl",
      stats: { total: 4, by_tool: { a: 4 }, by_scope: { read: 4 }, success: 3, failure: 1 },
    });
    render(<MCPAuditPanel />);
    // 3 / 4 = 75%
    await waitFor(() => expect(screen.getByText("75")).toBeInTheDocument());
  });

  it("renders failure row with error preview", async () => {
    vi.mocked(api.get).mockResolvedValue({
      count: 1,
      entries: [
        {
          ts: "2026-05-22T10:00:00Z",
          tool: "memory_store",
          scope: "write",
          success: false,
          latency_ms: 5,
          args_summary: {},
          result_preview: null,
          error: "UNAUTHORIZED: missing/invalid bearer",
          bearer_id: null,
          request_id: null,
        },
      ],
      path: "/tmp/mcp.jsonl",
      stats: { total: 1, by_tool: { memory_store: 1 }, by_scope: { write: 1 }, success: 0, failure: 1 },
    });
    render(<MCPAuditPanel />);
    await waitFor(() => expect(screen.getByText("失败")).toBeInTheDocument());
    expect(screen.getByText(/UNAUTHORIZED/)).toBeInTheDocument();
  });
});
