import { describe, it, expect, vi, beforeEach } from "vitest";
import { llmApi } from "./llm";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
}));

import { api } from "./client";

describe("llm API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stats hits /brain/llm/stats", async () => {
    vi.mocked(api.get).mockResolvedValue({ ok: true, total_count: 2, healthy_count: 2 });
    const res = await llmApi.stats();
    expect(api.get).toHaveBeenCalledWith("/brain/llm/stats");
    expect(res.ok).toBe(true);
  });

  it("recheck without name posts empty body", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, probed: true });
    await llmApi.recheck();
    expect(api.post).toHaveBeenCalledWith("/brain/llm/health/recheck", {});
  });

  it("recheck with name posts {name}", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, probed: true });
    await llmApi.recheck("primary");
    expect(api.post).toHaveBeenCalledWith("/brain/llm/health/recheck", { name: "primary" });
  });
});
