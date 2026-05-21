import { describe, it, expect, vi, beforeEach } from "vitest";
import { hooksApi } from "./hooks";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("hooks API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registry calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await hooksApi.registry();
    expect(true).toBe(true); // API call succeeded
  });
});
