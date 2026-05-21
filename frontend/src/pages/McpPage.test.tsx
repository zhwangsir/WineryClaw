/**
 * @vitest-environment jsdom
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

  it("renders connected and disconnected servers", () => {
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    expect(screen.getAllByText("fs").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("web").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("已连接").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("未连接").length).toBeGreaterThanOrEqual(1);
  });

  it("renders server tools tags", () => {
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    expect(screen.getAllByText("read").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("write").length).toBeGreaterThanOrEqual(1);
  });

  it("renders tools table", () => {
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows empty when no servers", () => {
    vi.mocked(useMcpStore).mockImplementation(() => createMockStore({ servers: [] }) as any);
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    expect(screen.getByText("暂无 MCP 服务器")).toBeInTheDocument();
  });

  it("shows empty when no tools", () => {
    vi.mocked(useMcpStore).mockImplementation(() => createMockStore({ tools: [] }) as any);
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    expect(screen.getByText("暂无 MCP 工具")).toBeInTheDocument();
  });

  it("opens connect drawer and submits", async () => {
    connect.mockResolvedValue(undefined);
    render(
      <BrowserRouter>
        <McpPage />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText("连接服务器"));
    expect(screen.getByText("连接 MCP 服务器")).toBeInTheDocument();

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
