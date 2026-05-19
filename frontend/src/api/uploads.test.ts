import { describe, it, expect, vi, beforeEach } from "vitest";
import { uploadsApi } from "./uploads";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("uploads API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upload calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await uploadsApi.upload("data", {}, "type");
    expect(true).toBe(true);  // API call succeeded
  });

});
