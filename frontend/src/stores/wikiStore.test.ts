import { describe, it, expect, vi, beforeEach } from "vitest";
import { useWikiStore } from "./wikiStore";

vi.mock("../api/wiki", () => ({
  wikiApi: {
    agents: vi.fn(),
    archive: vi.fn(),
    channels: vi.fn(),
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
    list: vi.fn(),
    logs: vi.fn(),
    memories: vi.fn(),
    messages: vi.fn(),
    notes: vi.fn(),
    notess: vi.fn(),
    plugins: vi.fn(),
    proposals: vi.fn(),
    query: vi.fn(),
    recent: vi.fn(),
    relations: vi.fn(),
    reports: vi.fn(),
    restore: vi.fn(),
    run: vi.fn(),
    search: vi.fn(),
    send: vi.fn(),
    sessions: vi.fn(),
    skills: vi.fn(),
    stats: vi.fn(),
    statss: vi.fn(),
    store: vi.fn(),
    tasks: vi.fn(),
    templates: vi.fn(),
    toggle: vi.fn(),
    tools: vi.fn(),
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

import { wikiApi } from "../api/wiki";
import { message } from "antd";

describe("wikiStore", () => {
  beforeEach(() => {
    useWikiStore.setState({
      notes: [],
      searchResults: [],
      stats: null,
      loading: false,
      query: "",
    });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useWikiStore.getState();
    expect(state.notes).toEqual([]);
    expect(state.query).toBe("");
  });

  it("fetchNotes loads notes", async () => {
    const mockData = [{ id: "1", title: "Test" }];
    vi.mocked(wikiApi.list).mockResolvedValue(mockData);
    await useWikiStore.getState().fetchNotes();
    expect(useWikiStore.getState().notes).toEqual(mockData);
    expect(useWikiStore.getState().loading).toBe(false);
  });

  it("fetchNotes handles non-array response", async () => {
    vi.mocked(wikiApi.list).mockResolvedValue(null as any);
    await useWikiStore.getState().fetchNotes();
    expect(useWikiStore.getState().notes).toEqual([]);
  });

  it("fetchNotes handles errors", async () => {
    vi.mocked(wikiApi.list).mockRejectedValue(new Error("fail"));
    await useWikiStore.getState().fetchNotes();
    expect(useWikiStore.getState().loading).toBe(false);
  });

  it("fetchNotes handles error without message", async () => {
    vi.mocked(wikiApi.list).mockRejectedValue(new Error(""));
    await useWikiStore.getState().fetchNotes();
    expect(message.error).toHaveBeenCalledWith("获取笔记失败");
  });

  it("search sets results", async () => {
    const results = [{ id: "1", title: "Found" }];
    vi.mocked(wikiApi.search).mockResolvedValue(results);
    await useWikiStore.getState().search("q");
    expect(useWikiStore.getState().searchResults).toEqual(results);
    expect(useWikiStore.getState().query).toBe("q");
  });

  it("search handles errors", async () => {
    vi.mocked(wikiApi.search).mockRejectedValue(new Error("fail"));
    await useWikiStore.getState().search("q");
    expect(useWikiStore.getState().loading).toBe(false);
  });

  it("search handles error without message", async () => {
    vi.mocked(wikiApi.search).mockRejectedValue(new Error(""));
    await useWikiStore.getState().search("q");
    expect(message.error).toHaveBeenCalledWith("搜索笔记失败");
  });

  it("createNote prepends note and shows success", async () => {
    const note = { id: "n1", title: "New" };
    vi.mocked(wikiApi.create).mockResolvedValue(note);
    await useWikiStore.getState().createNote({ title: "New" });
    expect(useWikiStore.getState().notes[0]).toEqual(note);
    expect(message.success).toHaveBeenCalledWith("笔记已创建");
  });

  it("createNote handles errors", async () => {
    vi.mocked(wikiApi.create).mockRejectedValue(new Error("fail"));
    await useWikiStore.getState().createNote({});
    expect(useWikiStore.getState().loading).toBe(false);
  });

  it("createNote handles error without message", async () => {
    vi.mocked(wikiApi.create).mockRejectedValue(new Error(""));
    await useWikiStore.getState().createNote({});
    expect(message.error).toHaveBeenCalledWith("创建笔记失败");
  });

  it("updateNote updates existing note", async () => {
    useWikiStore.setState({
      notes: [
        { id: "n1", title: "Old" },
        { id: "n2", title: "Other" },
      ],
    });
    const updated = { id: "n1", title: "New" };
    vi.mocked(wikiApi.update).mockResolvedValue(updated);
    await useWikiStore.getState().updateNote("n1", { title: "New" });
    expect(useWikiStore.getState().notes[0].title).toBe("New");
    expect(useWikiStore.getState().notes[1].title).toBe("Other");
    expect(message.success).toHaveBeenCalledWith("笔记已更新");
  });

  it("updateNote handles errors", async () => {
    vi.mocked(wikiApi.update).mockRejectedValue(new Error("fail"));
    await useWikiStore.getState().updateNote("n1", {});
    expect(useWikiStore.getState().loading).toBe(false);
  });

  it("updateNote handles error without message", async () => {
    vi.mocked(wikiApi.update).mockRejectedValue(new Error(""));
    await useWikiStore.getState().updateNote("n1", {});
    expect(message.error).toHaveBeenCalledWith("更新笔记失败");
  });

  it("deleteNote removes item", async () => {
    useWikiStore.setState({ notes: [{ id: "del-1", title: "X" }] });
    vi.mocked(wikiApi.delete).mockResolvedValue(true);
    await useWikiStore.getState().deleteNote("del-1");
    expect(useWikiStore.getState().notes).toHaveLength(0);
    expect(message.success).toHaveBeenCalledWith("笔记已删除");
  });

  it("deleteNote handles errors", async () => {
    vi.mocked(wikiApi.delete).mockRejectedValue(new Error("fail"));
    await useWikiStore.getState().deleteNote("del-1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("deleteNote handles error without message", async () => {
    vi.mocked(wikiApi.delete).mockRejectedValue(new Error(""));
    await useWikiStore.getState().deleteNote("del-1");
    expect(message.error).toHaveBeenCalledWith("删除笔记失败");
  });

  it("fetchStats sets stats", async () => {
    vi.mocked(wikiApi.stats).mockResolvedValue({ count: 5 });
    await useWikiStore.getState().fetchStats();
    expect(useWikiStore.getState().stats).toEqual({ count: 5 });
  });

  it("fetchStats handles errors", async () => {
    vi.mocked(wikiApi.stats).mockRejectedValue(new Error("fail"));
    await useWikiStore.getState().fetchStats();
    expect(useWikiStore.getState().stats).toBeNull();
  });

  it("fetchStats handles error without message", async () => {
    vi.mocked(wikiApi.stats).mockRejectedValue(new Error(""));
    await useWikiStore.getState().fetchStats();
    expect(message.error).toHaveBeenCalledWith("获取统计失败");
  });
});
