/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import MCPInfoPanel from "./MCPInfoPanel";

vi.mock("../../api/mcp", () => ({
  mcpApi: { selfInfo: vi.fn(), auditLog: vi.fn() },
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    message: { error: vi.fn(), success: vi.fn() },
  };
});

import { mcpApi } from "../../api/mcp";

const baseInfo = {
  ok: true,
  server: { name: "webrain-mcp", version: "0.1.1" },
  transport: "json-rpc-2.0-http",
  endpoint: "/mcp/jsonrpc",
  auth_required_for_write: true,
  token_configured: true,
  tool_count: 3,
  tools: [
    { name: "webrain_memory_query", description: "Semantic search across memory layers.", scope: "read" as const },
    { name: "webrain_rag_query", description: "Retrieve top-k document chunks.", scope: "read" as const },
    {
      name: "webrain_memory_store",
      description: "Append a new memory entry. Requires authentication.",
      scope: "write" as const,
    },
  ],
};

const baseAuditLogs = [
  {
    id: 1,
    timestamp: "2026-05-24T10:00:00+08:00",
    tool_name: "webrain_kg_search",
    scope: "read",
    client_ip: "127.0.0.1",
    success: 1,
    error_message: null,
  },
  {
    id: 2,
    timestamp: "2026-05-24T10:05:00+08:00",
    tool_name: "webrain_wiki_create",
    scope: "write",
    client_ip: "192.168.1.2",
    success: 0,
    error_message: "auth failed",
  },
];

describe("MCPInfoPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mcpApi.auditLog).mockResolvedValue({ ok: true, logs: baseAuditLogs });
  });

  it("shows server identity tags", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    render(<MCPInfoPanel />);
    expect(await screen.findByText("webrain-mcp v0.1.1")).toBeInTheDocument();
    expect(screen.getByText("json-rpc-2.0-http")).toBeInTheDocument();
  });

  it("renders all exposed tools in the table", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    render(<MCPInfoPanel />);
    expect(await screen.findByText("webrain_memory_query")).toBeInTheDocument();
    expect(screen.getByText("webrain_rag_query")).toBeInTheDocument();
    // Description text
    expect(screen.getByText("Semantic search across memory layers.")).toBeInTheDocument();
  });

  it("renders the absolute HTTP URL using window.location.origin", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    const { container } = render(<MCPInfoPanel />);
    // Wait for the panel to fully render before scanning the DOM
    await screen.findByText("webrain-mcp v0.1.1");
    // URL ends up inside <pre>, which findByText struggles with — scan
    // the container's text content directly.
    expect(container.textContent).toMatch(/\/brain\/mcp\/jsonrpc/);
  });

  it("shows tool count and write-tool count in the section header", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    render(<MCPInfoPanel />);
    // M4b.1 — baseInfo has 3 tools, 1 of which is write
    expect(await screen.findByText(/暴露的工具 \(3 · 1 个 write\)/)).toBeInTheDocument();
  });

  it("shows auth status when auth is required and token is configured", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    render(<MCPInfoPanel />);
    expect(await screen.findByText("鉴权状态")).toBeInTheDocument();
    expect(screen.getByText(/write 工具需要 token/)).toBeInTheDocument();
    expect(screen.getByText("已配置 token")).toBeInTheDocument();
  });

  it("shows unconfigured-token tag when auth not required", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue({
      ...baseInfo,
      auth_required_for_write: false,
      token_configured: false,
    });
    render(<MCPInfoPanel />);
    await screen.findByText("鉴权状态");
    expect(screen.getByText(/write 工具开放/)).toBeInTheDocument();
    expect(screen.queryByText("已配置 token")).not.toBeInTheDocument();
  });

  it("scope column shows write tag on write-scope tools", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    render(<MCPInfoPanel />);
    // wait for table to render
    await screen.findByText("webrain_memory_store");
    // There should be at least one "write" tag (in our baseInfo, exactly one)
    expect(screen.getAllByText("write").length).toBeGreaterThanOrEqual(1);
    // And at least two "read" tags
    expect(screen.getAllByText("read").length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces error message via antd.message on load failure", async () => {
    vi.mocked(mcpApi.selfInfo).mockRejectedValue(new Error("boom"));
    const { message } = await import("antd");
    render(<MCPInfoPanel />);
    // The error message is shown asynchronously after the promise rejects
    await new Promise((r) => setTimeout(r, 50));
    expect((message.error as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  // M4b.2 — audit log table
  it("renders audit log section title", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    render(<MCPInfoPanel />);
    expect(await screen.findByText("最近调用:")).toBeInTheDocument();
  });

  it("renders audit log tool names", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    render(<MCPInfoPanel />);
    expect(await screen.findByText("webrain_kg_search")).toBeInTheDocument();
    expect(screen.getByText("webrain_wiki_create")).toBeInTheDocument();
  });

  it("calls mcpApi.auditLog with limit=20", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    render(<MCPInfoPanel />);
    await screen.findByText("最近调用:");
    expect(mcpApi.auditLog).toHaveBeenCalledWith(20);
  });
});
