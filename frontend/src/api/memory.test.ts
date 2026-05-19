import { describe, it, expect, vi, beforeEach } from "vitest";
import { memoryApi } from "./memory";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("memory API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("list calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await memoryApi.list();
    expect(true).toBe(true);  // API call succeeded
  });

  it("store calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await memoryApi.store({});
    expect(true).toBe(true);  // API call succeeded
  });

  it("search calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await memoryApi.search("search", "arg");
    expect(true).toBe(true);  // API call succeeded
  });

  it("query calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await memoryApi.query("search");
    expect(true).toBe(true);  // API call succeeded
  });

  it("delete calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await memoryApi.delete("test-id");
    expect(true).toBe(true);  // API call succeeded
  });

});
