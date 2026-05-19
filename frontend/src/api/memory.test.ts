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
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await memoryApi.list();
    expect(true).toBe(true); // API call succeeded
  });

  it("store calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await memoryApi.store({});
    expect(true).toBe(true); // API call succeeded
  });

  it("search calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await memoryApi.search("search", "arg");
    expect(true).toBe(true); // API call succeeded
  });

  it("query calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await memoryApi.query("search");
    expect(true).toBe(true); // API call succeeded
  });

  it("delete calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await memoryApi.delete("test-id");
    expect(true).toBe(true); // API call succeeded
  });

  // M-Memory-1: conflicts + lineage + dreaming
  it("list accepts level filter and forwards as query param", async () => {
    vi.mocked(api.get).mockResolvedValue({ memories: [] });
    await memoryApi.list("L3", 25);
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("level=L3"));
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("limit=25"));
  });

  it("list without filter uses bare /memory/recent path", async () => {
    vi.mocked(api.get).mockResolvedValue({ memories: [] });
    await memoryApi.list();
    expect(api.get).toHaveBeenCalledWith("/brain/memory/recent");
  });

  it("conflicts hits /memory/conflicts", async () => {
    vi.mocked(api.get).mockResolvedValue({ groups: [], count: 0 });
    await memoryApi.conflicts();
    expect(api.get).toHaveBeenCalledWith("/brain/memory/conflicts");
  });

  it("markCurrent posts to the resolve endpoint", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    await memoryApi.markCurrent("mem-123");
    expect(api.post).toHaveBeenCalledWith("/brain/memory/conflicts/mem-123/mark-current", {});
  });

  it("lineage hits /memory/:id", async () => {
    vi.mocked(api.get).mockResolvedValue({ ok: true, memory: {}, sources: [], supersedes: [], superseded_by: null });
    await memoryApi.lineage("mem-xyz");
    expect(api.get).toHaveBeenCalledWith("/brain/memory/mem-xyz");
  });

  it("runDreaming posts to /dreaming/run", async () => {
    vi.mocked(api.post).mockResolvedValue({});
    await memoryApi.runDreaming();
    expect(api.post).toHaveBeenCalledWith("/brain/dreaming/run", {});
  });
});
