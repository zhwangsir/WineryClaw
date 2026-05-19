/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import MCPInfoPanel from "./MCPInfoPanel";

vi.mock("../../api/mcp", () => ({
  mcpApi: { selfInfo: vi.fn() },
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
  server: { name: "webrain-mcp", version: "0.1.0" },
  transport: "json-rpc-2.0-http",
  endpoint: "/mcp/jsonrpc",
  tool_count: 2,
  tools: [
    { name: "webrain_memory_query", description: "Semantic search across memory layers." },
    { name: "webrain_rag_query", description: "Retrieve top-k document chunks." },
  ],
};

describe("MCPInfoPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows server identity tags", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    render(<MCPInfoPanel />);
    expect(await screen.findByText("webrain-mcp v0.1.0")).toBeInTheDocument();
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
    await screen.findByText("webrain-mcp v0.1.0");
    // URL ends up inside <pre>, which findByText struggles with — scan
    // the container's text content directly.
    expect(container.textContent).toMatch(/\/brain\/mcp\/jsonrpc/);
  });

  it("shows tool count in the section header", async () => {
    vi.mocked(mcpApi.selfInfo).mockResolvedValue(baseInfo);
    render(<MCPInfoPanel />);
    expect(await screen.findByText(/暴露的工具 \(2\)/)).toBeInTheDocument();
  });

  it("surfaces error message via antd.message on load failure", async () => {
    vi.mocked(mcpApi.selfInfo).mockRejectedValue(new Error("boom"));
    const { message } = await import("antd");
    render(<MCPInfoPanel />);
    // The error message is shown asynchronously after the promise rejects
    await new Promise((r) => setTimeout(r, 50));
    expect((message.error as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});
