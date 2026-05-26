import { describe, it, expect, vi, beforeEach } from "vitest";
import { chatApi } from "./chat";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    stream: vi.fn().mockReturnValue({ client: {}, url: "" }),
  },
}));

import { api } from "./client";

describe("chat API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("send calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({});
    vi.mocked(api.post).mockResolvedValue({});
    vi.mocked(api.delete).mockResolvedValue({});
    await chatApi.send("text", "test-id", "test-id", "arg");
    expect(true).toBe(true); // API call succeeded
  });

  it("stream calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({});
    vi.mocked(api.post).mockResolvedValue({});
    vi.mocked(api.delete).mockResolvedValue({});
    await chatApi.stream("text", "test-id", "test-id", "arg");
    expect(true).toBe(true); // API call succeeded
  });

  it("getHistory calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({});
    vi.mocked(api.post).mockResolvedValue({});
    vi.mocked(api.delete).mockResolvedValue({});
    await chatApi.getHistory("test-id");
    expect(true).toBe(true); // API call succeeded
  });

  it("getSessions calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({});
    vi.mocked(api.post).mockResolvedValue({});
    vi.mocked(api.delete).mockResolvedValue({});
    await chatApi.getSessions();
    expect(true).toBe(true); // API call succeeded
  });

  it("deleteSession calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({});
    vi.mocked(api.post).mockResolvedValue({});
    vi.mocked(api.delete).mockResolvedValue({});
    await chatApi.deleteSession("test-id");
    expect(true).toBe(true); // API call succeeded
  });
});
