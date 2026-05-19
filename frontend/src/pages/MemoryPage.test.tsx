/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import MemoryPage from "./MemoryPage";

const fetchMemories = vi.fn();
const search = vi.fn();
const store = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    memories: [
      { id: "m1", content: "Hello memory", source: "chat", level: "L3", vectorScore: 0.95 },
      { id: "m2", content: "Another", source: "manual", level: "L1" },
    ],
    loading: false,
    fetchMemories,
    search,
    store,
    ...overrides,
  };
}

vi.mock("../stores/memoryStore", () => ({
  useMemoryStore: vi.fn(() => createMockStore()),
}));

import { useMemoryStore } from "../stores/memoryStore";

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Card: ({ children, bodyStyle, ...rest }: any) => (
      <div data-testid="card" {...rest}><div style={bodyStyle}>{children}</div></div>
    ),
  };
});

describe("MemoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useMemoryStore).mockImplementation(() => createMockStore() as any);
  });

  it("renders page shell", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getByText("记忆")).toBeInTheDocument();
  });

  it("fetches memories on mount", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(fetchMemories).toHaveBeenCalled();
  });

  it("renders memories list", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getByText("Hello memory")).toBeInTheDocument();
    expect(screen.getByText(/95\.0%/)).toBeInTheDocument();
  });

  it("shows empty when no memories", () => {
    vi.mocked(useMemoryStore).mockImplementation(() => createMockStore({ memories: [] }) as any);
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getByText("暂无记忆")).toBeInTheDocument();
  });

  it("shows loading spinner when loading and empty", () => {
    vi.mocked(useMemoryStore).mockImplementation(() => createMockStore({ memories: [], loading: true }) as any);
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getByText("加载中...")).toBeInTheDocument();
  });

  it("opens store drawer", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("存储记忆"));
    expect(document.querySelector(".ant-drawer")).toBeTruthy();
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
      expect(store).toHaveBeenCalledWith(expect.objectContaining({ content: "New memory", source: "manual", level: "L3" }));
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

  it("handles store failure without message", async () => {
    store.mockRejectedValue(new Error(""));
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

  it("searches with debounce", async () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);

    const searchInput = document.querySelector('input[placeholder*="搜索记忆"]') as HTMLInputElement;
    if (searchInput) {
      fireEvent.change(searchInput, { target: { value: "hello" } });
    }

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith("hello");
    }, { timeout: 800 });
  });

  it("shows empty search result", async () => {
    vi.mocked(useMemoryStore).mockImplementation(() => createMockStore({ memories: [], q: "xyz" }) as any);
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);

    const searchInput = document.querySelector('input[placeholder*="搜索记忆"]') as HTMLInputElement;
    if (searchInput) {
      fireEvent.change(searchInput, { target: { value: "xyz" } });
    }

    await waitFor(() => {
      expect(screen.getByText("无搜索结果")).toBeInTheDocument();
    }, { timeout: 800 });
  });

  it("renders memory without vectorScore", () => {
    vi.mocked(useMemoryStore).mockImplementation(
      () => createMockStore({ memories: [{ id: "m3", content: "No score", source: "test", level: "L2" }] }) as any
    );
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    expect(screen.getByText("No score")).toBeInTheDocument();
  });

  it("triggers hover effects", () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    const cards = screen.getAllByText("Hello memory");
    if (cards.length > 0) {
      const card = cards[0].closest("div") as HTMLDivElement;
      fireEvent.mouseEnter(card);
      fireEvent.mouseLeave(card);
    }
  });

  it("closes store drawer", async () => {
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("存储记忆"));
    expect(document.querySelector(".ant-drawer-open")).toBeTruthy();

    const closeBtn = document.querySelector(".ant-drawer-close") as HTMLButtonElement;
    if (closeBtn) fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(document.querySelector(".ant-drawer-open")).not.toBeInTheDocument();
    });
  });

  it("submits store form without explicit source and level", async () => {
    store.mockResolvedValue(undefined);
    render(<BrowserRouter><MemoryPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("存储记忆"));

    const contentInput = screen.getByPlaceholderText("输入要存储的记忆内容...");
    fireEvent.change(contentInput, { target: { value: "No source memory" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    expect(submitBtn).toBeTruthy();
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(store).toHaveBeenCalledWith(expect.objectContaining({ content: "No source memory", source: "manual", level: "L3" }));
    });
  });
});
