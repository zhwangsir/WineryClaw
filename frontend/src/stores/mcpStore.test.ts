import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMcpStore } from "./mcpStore";

vi.mock("../api/mcp", () => ({
  mcpApi: {
    listServers: vi.fn(),
    listTools: vi.fn(),
    connect: vi.fn(),
    callTool: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { mcpApi } from "../api/mcp";
import { message } from "antd";

describe("mcpStore", () => {
  beforeEach(() => {
    useMcpStore.setState({ servers: [], tools: [], loading: false });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useMcpStore.getState();
    expect(state.servers).toEqual([]);
    expect(state.tools).toEqual([]);
  });

  it("fetchServers loads servers", async () => {
    vi.mocked(mcpApi.listServers).mockResolvedValue([{ name: "s1" }]);
    await useMcpStore.getState().fetchServers();
    expect(useMcpStore.getState().servers).toHaveLength(1);
    expect(useMcpStore.getState().loading).toBe(false);
  });

  it("fetchServers handles errors", async () => {
    vi.mocked(mcpApi.listServers).mockRejectedValue(new Error("fail"));
    await useMcpStore.getState().fetchServers();
    expect(useMcpStore.getState().loading).toBe(false);
  });

  it("fetchServers handles error without message", async () => {
    vi.mocked(mcpApi.listServers).mockRejectedValue(new Error(""));
    await useMcpStore.getState().fetchServers();
    expect(message.error).toHaveBeenCalledWith("获取 MCP 服务器失败");
  });

  it("fetchTools loads tools", async () => {
    vi.mocked(mcpApi.listTools).mockResolvedValue([{ name: "t1" }]);
    await useMcpStore.getState().fetchTools();
    expect(useMcpStore.getState().tools).toHaveLength(1);
  });

  it("fetchTools handles errors", async () => {
    vi.mocked(mcpApi.listTools).mockRejectedValue(new Error("fail"));
    await useMcpStore.getState().fetchTools();
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("fetchTools handles error without message", async () => {
    vi.mocked(mcpApi.listTools).mockRejectedValue(new Error(""));
    await useMcpStore.getState().fetchTools();
    expect(message.error).toHaveBeenCalledWith("获取 MCP 工具失败");
  });

  it("connect succeeds and refetches", async () => {
    vi.mocked(mcpApi.connect).mockResolvedValue(undefined);
    vi.mocked(mcpApi.listServers).mockResolvedValue([]);
    vi.mocked(mcpApi.listTools).mockResolvedValue([]);
    await useMcpStore.getState().connect({ name: "s1", url: "http://localhost" });
    expect(message.success).toHaveBeenCalledWith('MCP 服务器 "s1" 连接成功');
  });

  it("connect handles errors", async () => {
    vi.mocked(mcpApi.connect).mockRejectedValue(new Error("fail"));
    await useMcpStore.getState().connect({ name: "s1" });
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("connect handles error without message", async () => {
    vi.mocked(mcpApi.connect).mockRejectedValue(new Error(""));
    await useMcpStore.getState().connect({ name: "s1" });
    expect(message.error).toHaveBeenCalledWith("连接失败");
  });

  it("callTool returns result", async () => {
    vi.mocked(mcpApi.callTool).mockResolvedValue({ result: "ok" });
    const result = await useMcpStore.getState().callTool("s1", "t1", { x: 1 });
    expect(result).toEqual({ result: "ok" });
  });

  it("callTool handles errors", async () => {
    vi.mocked(mcpApi.callTool).mockRejectedValue(new Error("fail"));
    const result = await useMcpStore.getState().callTool("s1", "t1");
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("callTool handles error without message", async () => {
    vi.mocked(mcpApi.callTool).mockRejectedValue(new Error(""));
    const result = await useMcpStore.getState().callTool("s1", "t1");
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("调用工具失败");
  });
});
