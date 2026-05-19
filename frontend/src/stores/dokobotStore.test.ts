import { describe, it, expect, vi, beforeEach } from "vitest";
import { useDokobotStore } from "./dokobotStore";

vi.mock("../api/dokobot", () => ({
  dokobotApi: {
    status: vi.fn(),
    browse: vi.fn(),
    search: vi.fn(),
    screenshot: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { dokobotApi } from "../api/dokobot";
import { message } from "antd";

describe("dokobotStore", () => {
  beforeEach(() => {
    useDokobotStore.setState({ available: false, loading: false });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useDokobotStore.getState();
    expect(state.available).toBe(false);
  });

  it("fetchStatus sets available on success", async () => {
    vi.mocked(dokobotApi.status).mockResolvedValue({ available: true });
    await useDokobotStore.getState().fetchStatus();
    expect(useDokobotStore.getState().available).toBe(true);
  });

  it("fetchStatus sets available false on error", async () => {
    vi.mocked(dokobotApi.status).mockRejectedValue(new Error("down"));
    await useDokobotStore.getState().fetchStatus();
    expect(useDokobotStore.getState().available).toBe(false);
  });

  it("browse returns result on success", async () => {
    vi.mocked(dokobotApi.browse).mockResolvedValue({ title: "Page" });
    const result = await useDokobotStore.getState().browse("https://example.com");
    expect(result).toEqual({ title: "Page" });
    expect(message.success).toHaveBeenCalledWith("浏览完成");
  });

  it("browse returns undefined on error", async () => {
    vi.mocked(dokobotApi.browse).mockRejectedValue(new Error("fail"));
    const result = await useDokobotStore.getState().browse("https://example.com");
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("browse handles error without message", async () => {
    vi.mocked(dokobotApi.browse).mockRejectedValue(new Error(""));
    await useDokobotStore.getState().browse("https://example.com");
    expect(message.error).toHaveBeenCalledWith("浏览失败");
  });

  it("search returns result on success", async () => {
    vi.mocked(dokobotApi.search).mockResolvedValue([{ url: "u1" }]);
    const result = await useDokobotStore.getState().search("query");
    expect(result).toEqual([{ url: "u1" }]);
    expect(message.success).toHaveBeenCalledWith("搜索完成");
  });

  it("search returns undefined on error", async () => {
    vi.mocked(dokobotApi.search).mockRejectedValue(new Error("fail"));
    const result = await useDokobotStore.getState().search("query");
    expect(result).toBeUndefined();
  });

  it("search handles error without message", async () => {
    vi.mocked(dokobotApi.search).mockRejectedValue(new Error(""));
    await useDokobotStore.getState().search("query");
    expect(message.error).toHaveBeenCalledWith("搜索失败");
  });

  it("screenshot returns dataUrl on success", async () => {
    vi.mocked(dokobotApi.screenshot).mockResolvedValue({ dataUrl: "data:image/png;base64,abc" });
    const result = await useDokobotStore.getState().screenshot("https://example.com");
    expect(result).toBe("data:image/png;base64,abc");
  });

  it("screenshot returns undefined on error", async () => {
    vi.mocked(dokobotApi.screenshot).mockRejectedValue(new Error("fail"));
    const result = await useDokobotStore.getState().screenshot("https://example.com");
    expect(result).toBeUndefined();
  });

  it("screenshot handles error without message", async () => {
    vi.mocked(dokobotApi.screenshot).mockRejectedValue(new Error(""));
    await useDokobotStore.getState().screenshot("https://example.com");
    expect(message.error).toHaveBeenCalledWith("截图失败");
  });
});
