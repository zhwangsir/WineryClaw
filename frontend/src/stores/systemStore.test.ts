import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSystemStore } from "./systemStore";

vi.mock("../api/system", () => ({
  systemApi: {
    health: vi.fn(),
  },
}));

vi.mock("../api/config", () => ({
  configApi: {
    health: vi.fn(),
  },
}));

vi.mock("../utils/storage", () => ({
  StorageAdapter: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

import { systemApi } from "../api/system";
import { configApi } from "../api/config";
import { StorageAdapter } from "../utils/storage";

describe("systemStore", () => {
  beforeEach(() => {
    useSystemStore.setState({
      health: null,
      modelHealth: null,
      loading: false,
      error: null,
      theme: "dark",
      lastHealthUpdate: 0,
      notifications: [],
    });
    vi.clearAllMocks();
    vi.mocked(StorageAdapter.get).mockReturnValue("dark");
  });

  it("has correct initial state", () => {
    const state = useSystemStore.getState();
    expect(state.theme).toBe("dark");
    expect(state.health).toBeNull();
  });

  it("fetchHealth loads health", async () => {
    vi.mocked(systemApi.health).mockResolvedValue({ status: "ok" });
    await useSystemStore.getState().fetchHealth();
    expect(useSystemStore.getState().health).toEqual({ status: "ok" });
    expect(useSystemStore.getState().loading).toBe(false);
  });

  it("fetchHealth skips when loading", async () => {
    useSystemStore.setState({ loading: true });
    await useSystemStore.getState().fetchHealth();
    expect(systemApi.health).not.toHaveBeenCalled();
  });

  it("fetchHealth skips when fresh", async () => {
    useSystemStore.setState({ health: { status: "ok" }, lastHealthUpdate: Date.now() });
    await useSystemStore.getState().fetchHealth();
    expect(systemApi.health).not.toHaveBeenCalled();
  });

  it("fetchHealth handles errors", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(systemApi.health).mockRejectedValue(new Error("fail"));
    await useSystemStore.getState().fetchHealth();
    expect(useSystemStore.getState().loading).toBe(false);
    consoleSpy.mockRestore();
  });

  it("fetchModelHealth loads model health", async () => {
    vi.mocked(configApi.health).mockResolvedValue({ endpoints: {} });
    await useSystemStore.getState().fetchModelHealth();
    expect(useSystemStore.getState().modelHealth).toBeDefined();
  });

  it("fetchModelHealth skips when fresh", async () => {
    useSystemStore.setState({ modelHealth: { endpoints: {} } as any, lastHealthUpdate: Date.now() });
    await useSystemStore.getState().fetchModelHealth();
    expect(configApi.health).not.toHaveBeenCalled();
  });

  it("fetchModelHealth skips when loading", async () => {
    useSystemStore.setState({ loading: true });
    await useSystemStore.getState().fetchModelHealth();
    expect(configApi.health).not.toHaveBeenCalled();
  });

  it("setTheme stores and applies theme", () => {
    useSystemStore.getState().setTheme("light");
    expect(useSystemStore.getState().theme).toBe("light");
    expect(StorageAdapter.set).toHaveBeenCalledWith("webrain-theme", "light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("toggleTheme switches theme", () => {
    useSystemStore.setState({ theme: "dark" });
    useSystemStore.getState().toggleTheme();
    expect(useSystemStore.getState().theme).toBe("light");
  });

  it("toggleTheme switches from light to dark", () => {
    useSystemStore.setState({ theme: "light" });
    useSystemStore.getState().toggleTheme();
    expect(useSystemStore.getState().theme).toBe("dark");
  });

  it("markNotificationRead marks notification", () => {
    useSystemStore.setState({
      notifications: [{ id: "n1", title: "Test", read: false }],
    });
    useSystemStore.getState().markNotificationRead("n1");
    expect(useSystemStore.getState().notifications[0].read).toBe(true);
  });

  it("markNotificationRead leaves others unchanged", () => {
    useSystemStore.setState({
      notifications: [
        { id: "n1", title: "A", read: false },
        { id: "n2", title: "B", read: false },
      ],
    });
    useSystemStore.getState().markNotificationRead("n1");
    expect(useSystemStore.getState().notifications[0].read).toBe(true);
    expect(useSystemStore.getState().notifications[1].read).toBe(false);
  });

  it("fetchModelHealth handles errors", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(configApi.health).mockRejectedValue(new Error("fail"));
    await useSystemStore.getState().fetchModelHealth();
    expect(useSystemStore.getState().loading).toBe(false);
    consoleSpy.mockRestore();
  });
});
