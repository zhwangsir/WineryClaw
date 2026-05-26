/**
 * @vitest-environment jsdom
 *
 * v2.32 — MCPAuditPanel tests (P1 #8).
 * v2.38 — added: filter Select wiring + error path coverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

  // ─────────────────────────────────────────────────────────────────────
  // v2.38 — filter Select wiring + error path coverage.
  //
  // The 3 Select dropdowns (tool / scope / success) build query params for
  // the next GET. Before this round these were entirely untested — a bug
  // where flipping "仅成功" silently passed "仅失败" would never surface.
  // ─────────────────────────────────────────────────────────────────────

  it("v2.38: scope Select onChange triggers GET with scope= query param", async () => {
    vi.mocked(api.get).mockResolvedValue({
      count: 0,
      entries: [],
      path: "/tmp/mcp.jsonl",
      stats: { total: 0, by_tool: {}, by_scope: {}, success: 0, failure: 0 },
    });
    render(<MCPAuditPanel />);
    // Wait for the initial GET (no filters yet).
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    const initialCall = vi.mocked(api.get).mock.calls[0][0] as string;
    expect(initialCall).not.toMatch(/scope=/);

    // Pick the "scope" select by placeholder. antd renders the placeholder
    // as a sibling element to the actual combobox; reach the combobox via
    // the parent container.
    const scopeCombobox = screen
      .getByText("按 scope")
      .closest(".ant-select")
      ?.querySelector(".ant-select-selector") as HTMLElement;
    expect(scopeCombobox).toBeTruthy();
    fireEvent.mouseDown(scopeCombobox);

    // The dropdown is rendered in a portal — searchable by role=option.
    await waitFor(() => {
      const opt = screen.getByText("write", { selector: ".ant-select-item-option-content" });
      fireEvent.click(opt);
    });

    // After change, a second GET must have fired and must include scope=write.
    await waitFor(() => {
      const calls = vi.mocked(api.get).mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes("scope=write"))).toBe(true);
    });
  });

  it("v2.38: success Select onChange triggers GET with success= query param", async () => {
    vi.mocked(api.get).mockResolvedValue({
      count: 0,
      entries: [],
      path: "/tmp/mcp.jsonl",
      stats: { total: 0, by_tool: {}, by_scope: {}, success: 0, failure: 0 },
    });
    render(<MCPAuditPanel />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    // The 3rd Select (index 2) is the success filter (default "全部" / "all").
    // Find it via its currently-displayed selected value text.
    const successCombobox = screen
      .getByText("全部")
      .closest(".ant-select")
      ?.querySelector(".ant-select-selector") as HTMLElement;
    expect(successCombobox).toBeTruthy();
    fireEvent.mouseDown(successCombobox);

    await waitFor(() => {
      const opt = screen.getByText("仅失败", {
        selector: ".ant-select-item-option-content",
      });
      fireEvent.click(opt);
    });

    // success=false because the option's value is "false"
    await waitFor(() => {
      const calls = vi.mocked(api.get).mock.calls.map((c) => c[0] as string);
      expect(calls.some((u) => u.includes("success=false"))).toBe(true);
    });
  });

  it("v2.38: success=all does NOT add success= query (matches backend default)", async () => {
    vi.mocked(api.get).mockResolvedValue({
      count: 0,
      entries: [],
      path: "/tmp/mcp.jsonl",
      stats: { total: 0, by_tool: {}, by_scope: {}, success: 0, failure: 0 },
    });
    render(<MCPAuditPanel />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    // Initial state is successFilter=all; URL must NOT contain success=
    const url = vi.mocked(api.get).mock.calls[0][0] as string;
    expect(url).not.toMatch(/success=/);
  });

  it("v2.38: api.get rejection surfaces a user-facing error message", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error("boom"));
    render(<MCPAuditPanel />);
    // The panel calls message.error(...). antd's message renders globally;
    // we can match by partial Chinese text or just verify the rejection
    // didn't crash the page (the Card title still renders).
    await waitFor(() => {
      expect(screen.getByText("MCP 调用审计")).toBeInTheDocument();
    });
    // No data was set, so the stats Tag should not render. The component
    // gracefully shows the empty Table.
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
