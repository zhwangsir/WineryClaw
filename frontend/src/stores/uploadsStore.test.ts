import { describe, it, expect, vi, beforeEach } from "vitest";
import { useUploadsStore } from "./uploadsStore";

vi.mock("../api/uploads", () => ({
  uploadsApi: {
    upload: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { uploadsApi } from "../api/uploads";
import { message } from "antd";

describe("uploadsStore", () => {
  beforeEach(() => {
    useUploadsStore.setState({ loading: false });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useUploadsStore.getState();
    expect(state.loading).toBe(false);
  });

  it("upload succeeds", async () => {
    const file = new File(["content"], "test.txt", { type: "text/plain" });
    vi.mocked(uploadsApi.upload).mockResolvedValue({ ok: true, name: "test.txt" });
    await useUploadsStore.getState().upload(file);
    expect(useUploadsStore.getState().loading).toBe(false);
    expect(message.success).toHaveBeenCalledWith("上传成功: test.txt");
  });

  it("upload handles server error", async () => {
    const file = new File(["content"], "test.txt", { type: "text/plain" });
    vi.mocked(uploadsApi.upload).mockResolvedValue({ ok: false, error: "rejected" });
    await useUploadsStore.getState().upload(file);
    expect(message.error).toHaveBeenCalledWith("rejected");
  });

  it("upload handles server error without message", async () => {
    const file = new File(["content"], "test.txt", { type: "text/plain" });
    vi.mocked(uploadsApi.upload).mockResolvedValue({ ok: false });
    await useUploadsStore.getState().upload(file);
    expect(message.error).toHaveBeenCalledWith("上传失败");
  });

  it("upload handles network error", async () => {
    const file = new File(["content"], "test.txt", { type: "text/plain" });
    vi.mocked(uploadsApi.upload).mockRejectedValue(new Error("network"));
    await useUploadsStore.getState().upload(file);
    expect(useUploadsStore.getState().loading).toBe(false);
    expect(message.error).toHaveBeenCalledWith("network");
  });

  it("upload handles network error without message", async () => {
    const file = new File(["content"], "test.txt", { type: "text/plain" });
    vi.mocked(uploadsApi.upload).mockRejectedValue(new Error(""));
    await useUploadsStore.getState().upload(file);
    expect(message.error).toHaveBeenCalledWith("上传失败");
  });
});
