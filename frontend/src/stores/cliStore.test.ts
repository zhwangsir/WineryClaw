import { describe, it, expect, vi, beforeEach } from "vitest";
import { useCliStore } from "./cliStore";

vi.mock("../api/cli", () => ({
  cliApi: {
    status: vi.fn(),
    chat: vi.fn(),
    exec: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { cliApi } from "../api/cli";
import { message } from "antd";

describe("cliStore", () => {
  beforeEach(() => {
    useCliStore.setState({ status: "", loading: false });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useCliStore.getState();
    expect(state.status).toBe("");
    expect(state.loading).toBe(false);
  });

  it("fetchStatus sets status on success", async () => {
    vi.mocked(cliApi.status).mockResolvedValue({ text: "ready" });
    await useCliStore.getState().fetchStatus();
    expect(useCliStore.getState().status).toBe("ready");
  });

  it("fetchStatus sets unavailable on error", async () => {
    vi.mocked(cliApi.status).mockRejectedValue(new Error("down"));
    await useCliStore.getState().fetchStatus();
    expect(useCliStore.getState().status).toBe(" unavailable");
  });

  it("chat returns reply on success", async () => {
    vi.mocked(cliApi.chat).mockResolvedValue("hello");
    const result = await useCliStore.getState().chat("hi");
    expect(result).toBe("hello");
    expect(useCliStore.getState().loading).toBe(false);
  });

  it("chat handles errors", async () => {
    vi.mocked(cliApi.chat).mockRejectedValue(new Error("fail"));
    const result = await useCliStore.getState().chat("hi");
    expect(result).toBeUndefined();
    expect(useCliStore.getState().loading).toBe(false);
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("chat handles error without message", async () => {
    vi.mocked(cliApi.chat).mockRejectedValue(new Error(""));
    await useCliStore.getState().chat("hi");
    expect(message.error).toHaveBeenCalledWith("请求失败");
  });

  it("exec returns result on success", async () => {
    vi.mocked(cliApi.exec).mockResolvedValue({ ok: true });
    const result = await useCliStore.getState().exec("tool", { x: 1 });
    expect(result).toEqual({ ok: true });
    expect(useCliStore.getState().loading).toBe(false);
  });

  it("exec handles errors", async () => {
    vi.mocked(cliApi.exec).mockRejectedValue(new Error("fail"));
    const result = await useCliStore.getState().exec("tool");
    expect(result).toBeUndefined();
    expect(useCliStore.getState().loading).toBe(false);
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("exec handles error without message", async () => {
    vi.mocked(cliApi.exec).mockRejectedValue(new Error(""));
    await useCliStore.getState().exec("tool");
    expect(message.error).toHaveBeenCalledWith("执行失败");
  });
});
