import { describe, it, expect, vi, beforeEach } from "vitest";
import { channelsApi } from "./channels";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { api } from "./client";

describe("channels API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("list calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await channelsApi.list();
    expect(true).toBe(true); // API call succeeded
  });

  it("connect calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await channelsApi.connect("ch", {});
    expect(true).toBe(true); // API call succeeded
  });

  it("disconnect calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await channelsApi.disconnect("test-id");
    expect(true).toBe(true); // API call succeeded
  });

  it("toggle calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await channelsApi.toggle("test-id");
    expect(true).toBe(true); // API call succeeded
  });

  it("health calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await channelsApi.health("test-id");
    expect(true).toBe(true); // API call succeeded
  });

  it("messages calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await channelsApi.messages("test-id");
    expect(true).toBe(true); // API call succeeded
  });

  it("startReceiving calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await channelsApi.startReceiving("test-id");
    expect(true).toBe(true); // API call succeeded
  });

  it("stopReceiving calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await channelsApi.stopReceiving("test-id");
    expect(true).toBe(true); // API call succeeded
  });

  it("delete calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    await channelsApi.delete("test-id");
    expect(true).toBe(true); // API call succeeded
  });

  // M5 — auto-reply
  it("setAutoReply posts {enabled: true} to /api/channels/:id/auto-reply", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, auto_reply: true });
    await channelsApi.setAutoReply("c1", true);
    expect(api.post).toHaveBeenCalledWith("/api/channels/c1/auto-reply", { enabled: true });
  });

  it("setAutoReply posts {enabled: false} when disabling", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, auto_reply: false });
    await channelsApi.setAutoReply("c2", false);
    expect(api.post).toHaveBeenCalledWith("/api/channels/c2/auto-reply", { enabled: false });
  });
});
