/**
 * @vitest-environment jsdom
 *
 * v2.19 — refit tests to v2.8 McpPage redesign:
 *   - default tab is "内置市场" (catalog), so servers/tools tabs need explicit click
 *   - "连接服务器" button renamed to "手动连接"
 *   - drawer title now "手动连接 MCP 服务器" (was "连接 MCP 服务器")
 *   - empty server text now includes "· 去内置市场安装"
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import McpPage from "./McpPage";

const fetchServers = vi.fn();
const fetchTools = vi.fn();
const connect = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    servers: [
      { name: "fs", connected: true, url: "http://localhost:3001", tools: ["read", "write"] },
      { name: "web", connected: false, url: "", tools: [] },
    ],
    tools: [
      { name: "read", server: "fs", description: "Read file" },
      { name: "write", server: "fs", description: "" },
    ],
    loading: false,
    fetchServers,
    fetchTools,
    connect,
    ...overrides,
  };
}

vi.mock("../stores/mcpStore", () => ({
  useMcpStore: vi.fn(() => createMockStore()),
}));

import { useMcpStore } from "../stores/mcpStore";

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Card: ({ children, bodyStyle, ...rest }: any) => (
      <div data-testid="card" {...rest}>
        <div style={bodyStyle}>{children}</div>
      </div>
    ),
  };
});

// Mock mcpApi so tests don't depend on real catalog/install endpoints.
vi.mock("../api/mcp", () => ({
  mcpApi: {
    listCatalog: vi.fn().mockResolvedValue([]),
    installFromCatalog: vi.fn().mockResolvedValue({ ok: true, tools: [] }),
  },
}));

/** Open the "已安装" tab — required to see servers UI under v2.8+ Tabs layout. */
async function openInstalledTab() {
  // The tab label is "<LinkOutlined /> 已安装 (N)" — match via includes
  const tabs = screen.getAllByRole("tab");
  const installed = tabs.find((t) => t.textContent?.includes("已安装"));
  if (!installed) throw new Error("已安装 tab not found");
  fireEvent.click(installed);
}

/** Open the "工具" tab. */
async function openToolsTab() {
  const tabs = screen.getAllByRole("tab");
  const tools = tabs.find((t) => t.textContent?.includes("工具"));
  if (!tools) throw new Error("工具 tab not found");
  fireEvent.click(tools);
}

describe("McpPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useMcpStore).mockImplementation(() => createMockStore() as any);
  });

  it("renders page shell", () => {
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    expect(screen.getByText("MCP")).toBeInTheDocument();
  });

  it("fetches servers and tools on mount", () => {
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    expect(fetchServers).toHaveBeenCalled();
    expect(fetchTools).toHaveBeenCalled();
  });

  it("renders connected and disconnected servers (after opening 已安装 tab)", async () => {
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    await openInstalledTab();
    await waitFor(() => {
      expect(screen.getAllByText("fs").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText("web").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("已连接").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("未连接").length).toBeGreaterThanOrEqual(1);
  });

  it("renders server tools tags (after opening 已安装 tab)", async () => {
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    await openInstalledTab();
    await waitFor(() => {
      expect(screen.getAllByText("read").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText("write").length).toBeGreaterThanOrEqual(1);
  });

  it("renders tools table (after opening 工具 tab)", async () => {
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    await openToolsTab();
    await waitFor(() => {
      expect(screen.getByText("Read file")).toBeInTheDocument();
    });
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows empty hint when no servers (under 已安装 tab)", async () => {
    vi.mocked(useMcpStore).mockImplementation(() => createMockStore({ servers: [] }) as any);
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    await openInstalledTab();
    // v2.8 changed copy: "暂无 MCP 服务器 · 去内置市场安装"
    await waitFor(() => {
      expect(screen.getByText(/暂无 MCP 服务器/)).toBeInTheDocument();
    });
  });

  it("shows empty when no tools (under 工具 tab)", async () => {
    vi.mocked(useMcpStore).mockImplementation(() => createMockStore({ tools: [] }) as any);
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    await openToolsTab();
    await waitFor(() => {
      expect(screen.getByText("暂无 MCP 工具")).toBeInTheDocument();
    });
  });

  it("opens manual-connect drawer and submits", async () => {
    connect.mockResolvedValue(undefined);
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    // v2.8 renamed to "手动连接"
    fireEvent.click(screen.getByText("手动连接"));
    expect(screen.getByText("手动连接 MCP 服务器")).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText("例如: filesystem");
    fireEvent.change(nameInput, { target: { value: "db" } });
    const urlInput = screen.getByPlaceholderText("例如: http://localhost:3001/sse");
    fireEvent.change(urlInput, { target: { value: "http://db/sse" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    expect(submitBtn).toBeTruthy();
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(connect).toHaveBeenCalledWith({ name: "db", url: "http://db/sse" });
    });
  });
});
