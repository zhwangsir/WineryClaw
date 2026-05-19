import { describe, it, expect, vi, beforeEach } from "vitest";
import { usePluginStore } from "./pluginStore";

vi.mock("../api/plugins", () => ({
  pluginsApi: {
    delete: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { pluginsApi } from "../api/plugins";
import { message } from "antd";

describe("pluginStore", () => {
  beforeEach(() => {
    usePluginStore.setState({ loading: false });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = usePluginStore.getState();
    expect(state.loading).toBe(false);
    expect(state.deletePlugin).toBeDefined();
  });

  it("deletePlugin succeeds", async () => {
    vi.mocked(pluginsApi.delete).mockResolvedValue(undefined);
    await usePluginStore.getState().deletePlugin("p1");
    expect(pluginsApi.delete).toHaveBeenCalledWith("p1");
    expect(message.success).toHaveBeenCalledWith("插件已删除");
  });

  it("deletePlugin handles errors", async () => {
    vi.mocked(pluginsApi.delete).mockRejectedValue(new Error("fail"));
    await usePluginStore.getState().deletePlugin("p1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("deletePlugin uses fallback error message", async () => {
    vi.mocked(pluginsApi.delete).mockRejectedValue({});
    await usePluginStore.getState().deletePlugin("p1");
    expect(message.error).toHaveBeenCalledWith("删除插件失败");
  });
});
