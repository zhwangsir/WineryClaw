import { describe, it, expect, vi, beforeEach } from "vitest";
import { useBrowserStore } from "./browserStore";

vi.mock("../api/browser", () => ({
  browserApi: {
    agents: vi.fn(),
    archive: vi.fn(),
    channels: vi.fn(),
    click: vi.fn(),
    clicks: vi.fn(),
    connect: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    disconnect: vi.fn(),
    download: vi.fn(),
    entities: vi.fn(),
    events: vi.fn(),
    execute: vi.fn(),
    fetch: vi.fn(),
    files: vi.fn(),
    get: vi.fn(),
    health: vi.fn(),
    history: vi.fn(),
    install: vi.fn(),
    jobs: vi.fn(),
    launch: vi.fn(),
    launchs: vi.fn(),
    list: vi.fn(),
    logs: vi.fn(),
    memories: vi.fn(),
    messages: vi.fn(),
    navigate: vi.fn(),
    navigates: vi.fn(),
    newPage: vi.fn(),
    newpage: vi.fn(),
    newpages: vi.fn(),
    notes: vi.fn(),
    plugins: vi.fn(),
    proposals: vi.fn(),
    query: vi.fn(),
    recent: vi.fn(),
    relations: vi.fn(),
    reports: vi.fn(),
    restore: vi.fn(),
    run: vi.fn(),
    screenshot: vi.fn(),
    screenshots: vi.fn(),
    search: vi.fn(),
    send: vi.fn(),
    sessions: vi.fn(),
    sessionss: vi.fn(),
    skills: vi.fn(),
    stats: vi.fn(),
    store: vi.fn(),
    tasks: vi.fn(),
    templates: vi.fn(),
    toggle: vi.fn(),
    tools: vi.fn(),
    type: vi.fn(),
    types: vi.fn(),
    uninstall: vi.fn(),
    update: vi.fn(),
    upload: vi.fn(),
    users: vi.fn(),
    workflows: vi.fn(),
    workspaces: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import { browserApi } from "../api/browser";
import { message } from "antd";

describe("browserStore", () => {
  beforeEach(() => {
    useBrowserStore.setState({
      sessions: [],
      loading: false,
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useBrowserStore.getState();
    expect(state.sessions).toEqual([]);
    expect(state.loading).toBe(false);
  });

  it("fetchSessions succeeds", async () => {
    const mockData = [{ id: "1", url: "https://example.com" }];
    vi.mocked(browserApi.sessions).mockResolvedValue(mockData);
    await useBrowserStore.getState().fetchSessions();
    expect(useBrowserStore.getState().sessions).toEqual(mockData);
    expect(useBrowserStore.getState().loading).toBe(false);
  });

  it("fetchSessions handles errors", async () => {
    vi.mocked(browserApi.sessions).mockRejectedValue(new Error("fail"));
    await useBrowserStore.getState().fetchSessions();
    expect(useBrowserStore.getState().loading).toBe(false);
  });

  it("fetch handles errors without message", async () => {
    vi.mocked(browserApi.sessions).mockRejectedValue({});
    await useBrowserStore.getState().fetchSessions();
    expect(message.error).toHaveBeenCalledWith("获取会话失败");
  });

  it("launch shows success when ok", async () => {
    vi.mocked(browserApi.launch).mockResolvedValue({ ok: true });
    await useBrowserStore.getState().launch();
    expect(message.success).toHaveBeenCalledWith("浏览器已启动");
  });

  it("launch shows error when not ok", async () => {
    vi.mocked(browserApi.launch).mockResolvedValue({ ok: false, error: "busy" });
    await useBrowserStore.getState().launch();
    expect(message.error).toHaveBeenCalledWith("busy");
  });

  it("launch shows default error when not ok without error", async () => {
    vi.mocked(browserApi.launch).mockResolvedValue({ ok: false });
    await useBrowserStore.getState().launch();
    expect(message.error).toHaveBeenCalledWith("启动失败");
  });

  it("launch handles exception without message", async () => {
    vi.mocked(browserApi.launch).mockRejectedValue(new Error(""));
    await useBrowserStore.getState().launch();
    expect(message.error).toHaveBeenCalledWith("启动失败");
  });

  it("launch handles exception", async () => {
    vi.mocked(browserApi.launch).mockRejectedValue(new Error("fail"));
    await useBrowserStore.getState().launch();
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("newPage returns session and fetches", async () => {
    const session = { id: "s1", url: "https://test.com" };
    vi.mocked(browserApi.newPage).mockResolvedValue({ ok: true, session });
    vi.mocked(browserApi.sessions).mockResolvedValue([session]);
    const result = await useBrowserStore.getState().newPage("https://test.com");
    expect(result).toEqual(session);
  });

  it("newPage shows error when not ok", async () => {
    vi.mocked(browserApi.newPage).mockResolvedValue({ ok: false, error: "err" });
    const result = await useBrowserStore.getState().newPage();
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("err");
  });

  it("newPage shows default error when not ok without error", async () => {
    vi.mocked(browserApi.newPage).mockResolvedValue({ ok: false });
    const result = await useBrowserStore.getState().newPage();
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("创建页面失败");
  });

  it("newPage handles ok without session", async () => {
    vi.mocked(browserApi.newPage).mockResolvedValue({ ok: true });
    const result = await useBrowserStore.getState().newPage();
    expect(result).toBeUndefined();
  });

  it("newPage handles exception without message", async () => {
    vi.mocked(browserApi.newPage).mockRejectedValue(new Error(""));
    const result = await useBrowserStore.getState().newPage();
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("创建页面失败");
  });

  it("navigate succeeds and refetches", async () => {
    vi.mocked(browserApi.navigate).mockResolvedValue({ ok: true });
    vi.mocked(browserApi.sessions).mockResolvedValue([]);
    await useBrowserStore.getState().navigate("s1", "https://new.com");
    expect(message.success).toHaveBeenCalledWith("导航成功");
  });

  it("navigate shows error when not ok", async () => {
    vi.mocked(browserApi.navigate).mockResolvedValue({ ok: false, error: "err" });
    await useBrowserStore.getState().navigate("s1", "https://new.com");
    expect(message.error).toHaveBeenCalledWith("err");
  });

  it("navigate shows default error when not ok without error", async () => {
    vi.mocked(browserApi.navigate).mockResolvedValue({ ok: false });
    await useBrowserStore.getState().navigate("s1", "https://new.com");
    expect(message.error).toHaveBeenCalledWith("导航失败");
  });

  it("navigate handles exception without message", async () => {
    vi.mocked(browserApi.navigate).mockRejectedValue(new Error(""));
    await useBrowserStore.getState().navigate("s1", "https://new.com");
    expect(message.error).toHaveBeenCalledWith("导航失败");
  });

  it("click succeeds", async () => {
    vi.mocked(browserApi.click).mockResolvedValue({ ok: true });
    await useBrowserStore.getState().click("s1", "#btn");
    expect(message.success).toHaveBeenCalledWith("点击成功");
  });

  it("click shows error when not ok", async () => {
    vi.mocked(browserApi.click).mockResolvedValue({ ok: false, error: "err" });
    await useBrowserStore.getState().click("s1", "#btn");
    expect(message.error).toHaveBeenCalledWith("err");
  });

  it("click shows default error when not ok without error", async () => {
    vi.mocked(browserApi.click).mockResolvedValue({ ok: false });
    await useBrowserStore.getState().click("s1", "#btn");
    expect(message.error).toHaveBeenCalledWith("点击失败");
  });

  it("click handles exception without message", async () => {
    vi.mocked(browserApi.click).mockRejectedValue(new Error(""));
    await useBrowserStore.getState().click("s1", "#btn");
    expect(message.error).toHaveBeenCalledWith("点击失败");
  });

  it("type succeeds", async () => {
    vi.mocked(browserApi.type).mockResolvedValue({ ok: true });
    await useBrowserStore.getState().type("s1", "#input", "hello");
    expect(message.success).toHaveBeenCalledWith("输入成功");
  });

  it("type shows error when not ok", async () => {
    vi.mocked(browserApi.type).mockResolvedValue({ ok: false, error: "err" });
    await useBrowserStore.getState().type("s1", "#input", "hello");
    expect(message.error).toHaveBeenCalledWith("err");
  });

  it("type shows default error when not ok without error", async () => {
    vi.mocked(browserApi.type).mockResolvedValue({ ok: false });
    await useBrowserStore.getState().type("s1", "#input", "hello");
    expect(message.error).toHaveBeenCalledWith("输入失败");
  });

  it("type handles exception without message", async () => {
    vi.mocked(browserApi.type).mockRejectedValue(new Error(""));
    await useBrowserStore.getState().type("s1", "#input", "hello");
    expect(message.error).toHaveBeenCalledWith("输入失败");
  });

  it("screenshot returns dataUrl on success", async () => {
    vi.mocked(browserApi.screenshot).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,abc" });
    const result = await useBrowserStore.getState().screenshot("s1");
    expect(result).toBe("data:image/png;base64,abc");
  });

  it("screenshot shows error when not ok", async () => {
    vi.mocked(browserApi.screenshot).mockResolvedValue({ ok: false, error: "err" });
    const result = await useBrowserStore.getState().screenshot("s1");
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("err");
  });

  it("screenshot shows default error when not ok without error", async () => {
    vi.mocked(browserApi.screenshot).mockResolvedValue({ ok: false });
    const result = await useBrowserStore.getState().screenshot("s1");
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("截图失败");
  });

  it("screenshot handles ok without dataUrl", async () => {
    vi.mocked(browserApi.screenshot).mockResolvedValue({ ok: true });
    const result = await useBrowserStore.getState().screenshot("s1");
    expect(result).toBeUndefined();
  });

  it("screenshot handles exception without message", async () => {
    vi.mocked(browserApi.screenshot).mockRejectedValue(new Error(""));
    const result = await useBrowserStore.getState().screenshot("s1");
    expect(result).toBeUndefined();
    expect(message.error).toHaveBeenCalledWith("截图失败");
  });
});
