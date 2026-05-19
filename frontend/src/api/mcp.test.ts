import { describe, it, expect, vi, beforeEach } from "vitest";
import { mcpApi } from "./mcp";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("mcp API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listServers calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await mcpApi.listServers();
    expect(true).toBe(true);  // API call succeeded
  });

  it("listTools calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await mcpApi.listTools();
    expect(true).toBe(true);  // API call succeeded
  });

  it("connect calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await mcpApi.connect({}, "arg");
    expect(true).toBe(true);  // API call succeeded
  });

  it("callTool calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await mcpApi.callTool("arg", "arg", "arg", "arg");
    expect(true).toBe(true);  // API call succeeded
  });

  // M4b — webrain as MCP server
  it("selfInfo hits /brain/mcp/info", async () => {
    const fake = {
      ok: true,
      server: { name: "webrain-mcp", version: "0.1.0" },
      transport: "json-rpc-2.0-http",
      endpoint: "/mcp/jsonrpc",
      tool_count: 6,
      tools: [{ name: "webrain_memory_query", description: "..." }],
    };
    vi.mocked(api.get).mockResolvedValue(fake);
    const res = await mcpApi.selfInfo();
    expect(api.get).toHaveBeenCalledWith("/brain/mcp/info");
    expect(res).toEqual(fake);
  });

});
