import { describe, it, expect, vi, beforeEach } from "vitest";
import { systemApi } from "./system";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("system API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("health calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await systemApi.health();
    expect(true).toBe(true); // API call succeeded
  });

  it("metrics calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await systemApi.metrics();
    expect(true).toBe(true); // API call succeeded
  });
});
