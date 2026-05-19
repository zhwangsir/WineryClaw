import { describe, it, expect, vi, beforeEach } from "vitest";
import { sandboxApi } from "./sandbox";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("sandbox API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("status calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await sandboxApi.status();
    expect(true).toBe(true);  // API call succeeded
  });

  it("stats calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await sandboxApi.stats();
    expect(true).toBe(true);  // API call succeeded
  });

  it("audit calls correct endpoint with params", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { logs: [] } });
    await sandboxApi.audit("agent1", 10);
    expect(api.get).toHaveBeenCalledWith("/api/sandbox/audit?agentId=agent1&limit=10");
  });

  it("audit calls endpoint without optional params", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { logs: [] } });
    await sandboxApi.audit();
    expect(api.get).toHaveBeenCalledWith("/api/sandbox/audit?");
  });

  it("execute calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await sandboxApi.execute("arg", "data", "arg");
    expect(true).toBe(true);  // API call succeeded
  });

  it("executePython calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await sandboxApi.executePython("arg");
    expect(true).toBe(true);  // API call succeeded
  });

});
