import { describe, it, expect, vi, beforeEach } from "vitest";
import { toolsApi } from "./tools";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

import { api } from "./client";

describe("tools API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("list calls correct endpoint", async () => {
    vi.mocked(api.get).mockResolvedValue({ tools: [] });
    await toolsApi.list();
    expect(api.get).toHaveBeenCalledWith("/api/tools");
  });

  it("execute calls correct endpoint", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    await toolsApi.execute("arg", "arg");
    expect(api.post).toHaveBeenCalledWith("/api/tools/execute", { tool: "arg", params: "arg" });
  });

  it("enable calls correct endpoint", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    await toolsApi.enable("arg");
    expect(api.post).toHaveBeenCalledWith("/api/tools/enable", { tool: "arg" });
  });

  it("disable calls correct endpoint", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    await toolsApi.disable("arg");
    expect(api.post).toHaveBeenCalledWith("/api/tools/disable", { tool: "arg" });
  });

  it("globalToggle calls correct endpoint", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    await toolsApi.globalToggle(true);
    expect(api.post).toHaveBeenCalledWith("/api/tools/global-toggle", { enabled: true });
  });
});
