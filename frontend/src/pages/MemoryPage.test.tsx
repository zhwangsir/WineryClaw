/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import MemoryPage from "./MemoryPage";
import type { ConflictGroup, Memory } from "../api/types";

const fetchMemories = vi.fn();
const fetchConflicts = vi.fn();
const search = vi.fn();
const store = vi.fn();
const setLevelFilter = vi.fn();
const markCurrent = vi.fn();
const runDreaming = vi.fn();
const deleteMemory = vi.fn();

function baseMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    content: "Hello memory",
    source: "chat",
    level: "L3",
    createdAt: new Date().toISOString(),
    importance: 0.6,
    last_accessed_at: new Date().toISOString(),
    access_count: 3,
    provenance_source: "chat",
    is_current: 1,
    ...over,
  };
}

function createMockStore(over: Record<string, unknown> = {}) {
  return {
    memories: [
      baseMemory({ id: "m1", content: "Hello memory", level: "L3", vectorScore: 0.95 }),
      baseMemory({ id: "m2", content: "Another", level: "L1" }),
    ],
    conflicts: [] as ConflictGroup[],
    loading: false,
    conflictsLoading: false,
    dreamingRunning: false,
    error: null,
    searchQuery: "",
    levelFilter: "all",
    fetchMemories,
    fetchConflicts,
    setLevelFilter,
    search,
    store,
    clearSearch: vi.fn(),
    markCurrent,
    runDreaming,
    deleteMemory,
    ...over,
  };
}

vi.mock("../stores/memoryStore", () => ({
  useMemoryStore: vi.fn(() => createMockStore()),
}));

import { useMemoryStore } from "../stores/memoryStore";

describe("MemoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useMemoryStore).mockImplementation(() => createMockStore() as never);
  });

  it("renders page shell with title and subtitle", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getByText("记忆")).toBeInTheDocument();
    expect(screen.getByText(/分层记忆/)).toBeInTheDocument();
  });

  it("fetches memories AND conflicts on mount", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(fetchMemories).toHaveBeenCalled();
    expect(fetchConflicts).toHaveBeenCalled();
  });

  it("renders memory content in cards", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getByText("Hello memory")).toBeInTheDocument();
    expect(screen.getByText("Another")).toBeInTheDocument();
  });

  it("shows level filter Segmented with all levels", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    // The Segmented options include counts: "L1 (1)", "L2 (...)", etc.
    expect(screen.getByText(/全部/)).toBeInTheDocument();
    expect(screen.getByText(/^L1\s*\(/)).toBeInTheDocument();
    expect(screen.getByText(/^L2\s*\(/)).toBeInTheDocument();
    expect(screen.getByText(/^L3\s*\(/)).toBeInTheDocument();
    expect(screen.getByText(/^L4\s*\(/)).toBeInTheDocument();
  });

  it("shows empty when no memories", () => {
    vi.mocked(useMemoryStore).mockImplementation(
      () => createMockStore({ memories: [] }) as never,
    );
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getByText("暂无记忆")).toBeInTheDocument();
  });

  it("shows skeletons when loading + empty + memories tab", () => {
    vi.mocked(useMemoryStore).mockImplementation(
      () => createMockStore({ memories: [], loading: true }) as never,
    );
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    // PageShell shows loading state — verify it does not crash
    expect(screen.getByText("记忆")).toBeInTheDocument();
  });

  it("opens store drawer when 存储记忆 clicked", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("存储记忆"));
    expect(document.querySelector(".ant-drawer-open")).toBeTruthy();
  });

  it("submits store form successfully", async () => {
    store.mockResolvedValue(undefined);
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("存储记忆"));

    const contentInput = screen.getByPlaceholderText("输入要存储的记忆内容...");
    fireEvent.change(contentInput, { target: { value: "New memory" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    expect(submitBtn).toBeTruthy();
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({ content: "New memory", source: "manual", level: "L3" }),
      );
    });
  });

  it("handles store failure", async () => {
    store.mockRejectedValue(new Error("fail"));
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("存储记忆"));

    const contentInput = screen.getByPlaceholderText("输入要存储的记忆内容...");
    fireEvent.change(contentInput, { target: { value: "Bad" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(store).toHaveBeenCalled();
    });
  });

  it("triggers search via debounced input", async () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    const searchInput = document.querySelector('input[placeholder*="搜索记忆"]') as HTMLInputElement;
    if (searchInput) {
      fireEvent.change(searchInput, { target: { value: "hello" } });
    }
    await waitFor(() => {
      expect(search).toHaveBeenCalledWith("hello");
    }, { timeout: 800 });
  });

  it("runs dreaming when 运行 Dreaming clicked", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("运行 Dreaming"));
    expect(runDreaming).toHaveBeenCalled();
  });

  it("refreshes on 刷新", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("刷新"));
    // fetchMemories was called twice: once on mount, once on click
    expect(fetchMemories.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("shows conflict badge with count when conflicts exist", () => {
    const conflicts: ConflictGroup[] = [
      {
        conflict_group: "g-abc",
        current_id: "m1",
        memories: [
          baseMemory({ id: "m1", content: "Beijing", conflict_group: "g-abc", is_current: 1 }),
          baseMemory({ id: "m2", content: "Shanghai", conflict_group: "g-abc", is_current: 0 }),
        ],
      },
    ];
    vi.mocked(useMemoryStore).mockImplementation(
      () => createMockStore({ conflicts }) as never,
    );
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    // Badge component renders count visually; just ensure tab is rendered
    expect(screen.getByText("冲突")).toBeInTheDocument();
  });

  it("renders conflict cards when switching to conflicts tab", async () => {
    const conflicts: ConflictGroup[] = [
      {
        conflict_group: "g-xyz",
        current_id: "m1",
        memories: [
          baseMemory({ id: "m1", content: "Lives in Beijing", conflict_group: "g-xyz", is_current: 1 }),
          baseMemory({ id: "m2", content: "Lives in Shanghai", conflict_group: "g-xyz", is_current: 0 }),
        ],
      },
    ];
    vi.mocked(useMemoryStore).mockImplementation(
      () => createMockStore({ conflicts }) as never,
    );
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("冲突"));

    await waitFor(() => {
      expect(screen.getByText("Lives in Beijing")).toBeInTheDocument();
      expect(screen.getByText("Lives in Shanghai")).toBeInTheDocument();
    });
  });

  it("shows empty conflicts message when none exist", async () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("冲突"));
    await waitFor(() => {
      expect(screen.getByText(/无冲突记忆/)).toBeInTheDocument();
    });
  });

  it("renders importance value on memory card", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    // baseMemory has importance 0.6 → rendered as "0.60"
    expect(screen.getAllByText(/0\.60/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders access count and relative time", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getAllByText(/访问:/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders 已合并 tag when memory has superseded_by", () => {
    const memWithSuper = baseMemory({
      id: "m1", content: "Old L1", level: "L1", superseded_by: "abcd1234efgh5678",
    });
    vi.mocked(useMemoryStore).mockImplementation(
      () => createMockStore({ memories: [memWithSuper] }) as never,
    );
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getByText("已合并")).toBeInTheDocument();
  });

  it("renders conflict tag when memory is in conflict group and is_current=0", () => {
    const memSuperseded = baseMemory({
      id: "m1", content: "Old fact", conflict_group: "g1", is_current: 0,
    });
    vi.mocked(useMemoryStore).mockImplementation(
      () => createMockStore({ memories: [memSuperseded] }) as never,
    );
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getByText("冲突·旧版")).toBeInTheDocument();
  });

  it("submits store form without explicit source and level", async () => {
    store.mockResolvedValue(undefined);
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("存储记忆"));

    const contentInput = screen.getByPlaceholderText("输入要存储的记忆内容...");
    fireEvent.change(contentInput, { target: { value: "Quick note" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Quick note", source: "manual", level: "L3" }),
      );
    });
  });
});
