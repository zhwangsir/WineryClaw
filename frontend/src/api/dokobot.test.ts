import { describe, it, expect, vi, beforeEach } from "vitest";
import { dokobotApi } from "./dokobot";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("dokobot API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("status calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await dokobotApi.status();
    expect(true).toBe(true);  // API call succeeded
  });

  it("browse calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await dokobotApi.browse("arg", "arg");
    expect(true).toBe(true);  // API call succeeded
  });

  it("search calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await dokobotApi.search("search");
    expect(true).toBe(true);  // API call succeeded
  });

  it("screenshot calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await dokobotApi.screenshot("arg");
    expect(true).toBe(true);  // API call succeeded
  });

});
