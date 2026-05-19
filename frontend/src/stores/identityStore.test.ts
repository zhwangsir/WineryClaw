import { describe, it, expect, vi, beforeEach } from "vitest";
import { useIdentityStore } from "./identityStore";

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../api/identity", () => ({
  identityApi: {
    listUsers: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
  },
}));

import { identityApi } from "../api/identity";
import { message } from "antd";

describe("identityStore", () => {
  beforeEach(() => {
    useIdentityStore.setState({
      users: [],
      loading: false,
    });
    vi.restoreAllMocks();
  });

  it("has correct initial state", () => {
    const state = useIdentityStore.getState();
    expect(state.users).toEqual([]);
    expect(state.loading).toBe(false);
  });

  it("fetchUsers loads users", async () => {
    const mockData = [{ id: "u1", name: "Alice", role: "admin", workspaces: ["default"], createdAt: "2024-01-01" }];
    vi.mocked(identityApi.listUsers).mockResolvedValue(mockData);
    await useIdentityStore.getState().fetchUsers();
    expect(useIdentityStore.getState().users).toEqual(mockData);
  });

  it("createUser adds user and refreshes", async () => {
    vi.mocked(identityApi.createUser).mockResolvedValue({ id: "u2", name: "Bob", role: "user", workspaces: ["default"], createdAt: "2024-01-01" });
    const fetchSpy = vi.spyOn(useIdentityStore.getState(), "fetchUsers").mockResolvedValue();
    await useIdentityStore.getState().createUser({ name: "Bob", role: "user" });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("deleteUser removes user optimistically", async () => {
    useIdentityStore.setState({
      users: [{ id: "u1", name: "Alice", role: "admin", workspaces: ["default"], createdAt: "2024-01-01" }],
    });
    vi.mocked(identityApi.deleteUser).mockResolvedValue(true);
    await useIdentityStore.getState().deleteUser("u1");
    expect(useIdentityStore.getState().users).toEqual([]);
  });

  it("deleteUser rolls back on error", async () => {
    const prev = [{ id: "u1", name: "Alice", role: "admin", workspaces: ["default"], createdAt: "2024-01-01" }];
    useIdentityStore.setState({ users: prev });
    vi.mocked(identityApi.deleteUser).mockRejectedValue(new Error("fail"));
    await useIdentityStore.getState().deleteUser("u1");
    expect(useIdentityStore.getState().users).toEqual(prev);
  });

  it("fetchUsers handles error without message", async () => {
    vi.mocked(identityApi.listUsers).mockImplementation(() => Promise.reject(new Error("")));
    await useIdentityStore.getState().fetchUsers();
    expect(message.error).toHaveBeenCalledWith("获取用户失败");
  });

  it("fetchUsers handles error", async () => {
    vi.mocked(identityApi.listUsers).mockRejectedValue(new Error("network"));
    await useIdentityStore.getState().fetchUsers();
    expect(useIdentityStore.getState().loading).toBe(false);
    expect(useIdentityStore.getState().users).toEqual([]);
  });

  it("createUser handles error", async () => {
    vi.mocked(identityApi.createUser).mockRejectedValue(new Error("fail"));
    const fetchSpy = vi.spyOn(useIdentityStore.getState(), "fetchUsers").mockResolvedValue();
    await useIdentityStore.getState().createUser({ name: "Bob", role: "user" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("createUser handles error without message", async () => {
    vi.mocked(identityApi.createUser).mockRejectedValue(new Error(""));
    await useIdentityStore.getState().createUser({ name: "Bob", role: "user" });
    expect(message.error).toHaveBeenCalledWith("创建用户失败");
  });
});
