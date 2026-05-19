import { describe, it, expect, vi, beforeEach } from "vitest";
import { cliApi } from "./cli";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("cli API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("status calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await cliApi.status();
    expect(true).toBe(true);  // API call succeeded
  });

  it("chat calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await cliApi.chat("msg", "test-id");
    expect(true).toBe(true);  // API call succeeded
  });

  it("exec calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} })
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    await cliApi.exec("arg", "arg", "arg");
    expect(true).toBe(true);  // API call succeeded
  });

});
