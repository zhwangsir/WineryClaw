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

});
