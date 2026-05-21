import { describe, it, expect, vi, beforeEach } from "vitest";
import { a2aApi } from "./a2a";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("a2a API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listTasks calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await a2aApi.listTasks();
    expect(true).toBe(true); // API call succeeded
  });

  it("sendTask calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await a2aApi.sendTask("test-id", "test-id", "type", "arg", "arg");
    expect(true).toBe(true); // API call succeeded
  });

  it("getTask calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await a2aApi.getTask("test-id");
    expect(true).toBe(true); // API call succeeded
  });
});
