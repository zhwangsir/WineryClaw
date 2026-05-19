import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMemoryStore } from "./memoryStore";

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn(),
    store: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { memoryApi } from "../api/memory";
import { message } from "antd";

describe("memoryStore", () => {
  beforeEach(() => {
    useMemoryStore.setState({
      memories: [],
      loading: false,
      error: null,
      searchQuery: "",
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useMemoryStore.getState();
    expect(state.memories).toEqual([]);
    expect(state.searchQuery).toBe("");
  });

  it("fetchMemories loads memories", async () => {
    const mockData = [{ id: "m1", content: "test", level: "L1", source: "manual" }];
    vi.mocked(memoryApi.list).mockResolvedValue(mockData);
    await useMemoryStore.getState().fetchMemories();
    expect(useMemoryStore.getState().memories).toEqual(mockData);
  });

  it("search updates query and results", async () => {
    const mockData = [{ id: "m1", content: "hello", level: "L1", source: "manual" }];
    vi.mocked(memoryApi.search).mockResolvedValue(mockData);
    await useMemoryStore.getState().search("hello");
    expect(useMemoryStore.getState().searchQuery).toBe("hello");
    expect(useMemoryStore.getState().memories).toEqual(mockData);
  });

  it("deleteMemory removes memory optimistically", async () => {
    useMemoryStore.setState({
      memories: [{ id: "m1", content: "test", level: "L1", source: "manual" }],
    });
    vi.mocked(memoryApi.delete).mockResolvedValue(true);
    await useMemoryStore.getState().deleteMemory("m1");
    expect(useMemoryStore.getState().memories).toEqual([]);
  });

  it("deleteMemory rolls back on error", async () => {
    const prev = [{ id: "m1", content: "test", level: "L1", source: "manual" }];
    useMemoryStore.setState({ memories: prev });
    vi.mocked(memoryApi.delete).mockRejectedValue(new Error("fail"));
    await useMemoryStore.getState().deleteMemory("m1");
    expect(useMemoryStore.getState().memories).toEqual(prev);
  });

  it("deleteMemory rolls back on error without message", async () => {
    useMemoryStore.setState({ memories: [{ id: "m1", content: "test", level: "L1", source: "manual" }] });
    vi.mocked(memoryApi.delete).mockRejectedValue(new Error(""));
    await useMemoryStore.getState().deleteMemory("m1");
    expect(message.error).toHaveBeenCalledWith("删除记忆失败");
  });

  it("fetchMemories skips when already loading", async () => {
    useMemoryStore.setState({ loading: true });
    await useMemoryStore.getState().fetchMemories();
    expect(memoryApi.list).not.toHaveBeenCalled();
  });

  it("fetchMemories handles error", async () => {
    vi.mocked(memoryApi.list).mockRejectedValue(new Error("network"));
    await useMemoryStore.getState().fetchMemories();
    expect(useMemoryStore.getState().error).toBeTruthy();
    expect(useMemoryStore.getState().loading).toBe(false);
  });

  it("fetchMemories handles error without message", async () => {
    vi.mocked(memoryApi.list).mockRejectedValue(new Error(""));
    await useMemoryStore.getState().fetchMemories();
    expect(message.error).toHaveBeenCalledWith("获取记忆失败");
  });

  it("search handles error", async () => {
    vi.mocked(memoryApi.search).mockRejectedValue(new Error("search err"));
    await useMemoryStore.getState().search("q");
    expect(useMemoryStore.getState().error).toBeTruthy();
    expect(useMemoryStore.getState().loading).toBe(false);
  });

  it("search handles error without message", async () => {
    vi.mocked(memoryApi.search).mockRejectedValue(new Error(""));
    await useMemoryStore.getState().search("q");
    expect(message.error).toHaveBeenCalledWith("搜索记忆失败");
  });

  it("store stores memory and refreshes", async () => {
    vi.mocked(memoryApi.store).mockResolvedValue({ id: "m2" });
    vi.mocked(memoryApi.list).mockResolvedValue([{ id: "m2", content: "new", level: "L1", source: "auto" }]);
    await useMemoryStore.getState().store({ content: "new" });
    expect(memoryApi.store).toHaveBeenCalledWith({ content: "new" });
    expect(useMemoryStore.getState().memories.length).toBe(1);
  });

  it("store handles error", async () => {
    vi.mocked(memoryApi.store).mockRejectedValue(new Error("fail"));
    await useMemoryStore.getState().store({ content: "x" });
    expect(useMemoryStore.getState().memories).toEqual([]);
  });

  it("store handles error without message", async () => {
    vi.mocked(memoryApi.store).mockRejectedValue(new Error(""));
    await useMemoryStore.getState().store({ content: "x" });
    expect(message.error).toHaveBeenCalledWith("存储记忆失败");
  });

  it("clearSearch resets query and refreshes", async () => {
    useMemoryStore.setState({ searchQuery: "test" });
    vi.mocked(memoryApi.list).mockResolvedValue([{ id: "m1", content: "a", level: "L1", source: "s" }]);
    await useMemoryStore.getState().clearSearch();
    expect(useMemoryStore.getState().searchQuery).toBe("");
    expect(useMemoryStore.getState().memories.length).toBe(1);
  });
});
