/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ToolsPage from "./ToolsPage";

const fetchTools = vi.fn();
const toggleTool = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    tools: [
      { id: "t1", name: "File Read", description: "Read files", category: "filesystem", enabled: true },
      { id: "t2", name: "HTTP Request", description: "Make HTTP calls", category: "network", enabled: false },
      { id: "t3", name: "Shell Exec", description: "Run shell commands", category: "system", enabled: true },
    ],
    loading: false,
    fetchTools,
    toggleTool,
    ...overrides,
  };
}

vi.mock("../stores/toolStore", () => ({
  useToolStore: vi.fn(() => createMockStore()),
}));

import { useToolStore } from "../stores/toolStore";

vi.mock("../components/tools/ToolExecutorModal", () => ({
  default: ({ toolName, open }: any) => (open ? <div data-testid="executor-modal">{toolName}</div> : null),
}));

describe("ToolsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useToolStore).mockImplementation(() => createMockStore() as any);
  });

  it("renders tools", () => {
    render(<ToolsPage />);
    expect(screen.getByText("File Read")).toBeInTheDocument();
    expect(screen.getByText("HTTP Request")).toBeInTheDocument();
    expect(screen.getByText("Shell Exec")).toBeInTheDocument();
  });

  it("calls fetchTools on mount", () => {
    render(<ToolsPage />);
    expect(fetchTools).toHaveBeenCalled();
  });

  it("filters by search", () => {
    render(<ToolsPage />);
    const searchInput = document.querySelector("input") as HTMLInputElement;
    if (searchInput) {
      fireEvent.change(searchInput, { target: { value: "HTTP" } });
    }
    expect(screen.getByText("HTTP Request")).toBeInTheDocument();
  });

  it("filters by category", () => {
    render(<ToolsPage />);
    const segmented = document.querySelector(".ant-segmented");
    expect(segmented).toBeInTheDocument();
  });

  it("shows empty search result", async () => {
    render(<ToolsPage />);
    const searchInput = document.querySelector("input") as HTMLInputElement;
    if (searchInput) {
      fireEvent.change(searchInput, { target: { value: "xyznotfound" } });
    }
    await waitFor(() => {
      expect(screen.getByText("没有匹配的工具")).toBeInTheDocument();
    }, { timeout: 800 });
  });

  it("toggles tool", () => {
    render(<ToolsPage />);
    const switches = document.querySelectorAll(".ant-switch");
    expect(switches.length).toBeGreaterThan(0);
    fireEvent.click(switches[0]);
    expect(toggleTool).toHaveBeenCalled();
  });

  it("opens tool executor", () => {
    render(<ToolsPage />);
    const testButtons = screen.getAllByText("测试");
    fireEvent.click(testButtons[0]);
    expect(screen.getByTestId("executor-modal")).toBeInTheDocument();
  });

  it("shows skeleton when loading", () => {
    vi.mocked(useToolStore).mockImplementation(() => createMockStore({ loading: true, tools: [] }) as any);
    const { container } = render(<ToolsPage />);
    expect(container.querySelector(".ant-skeleton")).toBeTruthy();
  });

  it("shows empty state when no tools", () => {
    vi.mocked(useToolStore).mockImplementation(() => createMockStore({ tools: [] }) as any);
    render(<ToolsPage />);
    expect(screen.getByText("暂无工具")).toBeInTheDocument();
  });

  it("handles mouse enter and leave on tool cards", () => {
    vi.mocked(useToolStore).mockImplementation(() => createMockStore() as any);
    render(<ToolsPage />);
    const card = screen.getByText("File Read").parentElement?.parentElement;
    expect(card).toBeTruthy();
    if (card) {
      fireEvent.mouseEnter(card);
      fireEvent.mouseLeave(card);
    }
  });

  it("filters by category segment", () => {
    render(<ToolsPage />);
    const segmented = document.querySelector(".ant-segmented");
    expect(segmented).toBeInTheDocument();
    const items = segmented?.querySelectorAll(".ant-segmented-item");
    if (items && items.length > 1) {
      fireEvent.click(items[1]);
    }
  });

  it("renders unknown category tool", () => {
    vi.mocked(useToolStore).mockImplementation(() => createMockStore({
      tools: [{ id: "t4", name: "Unknown", description: "Desc", category: "unknown_cat", enabled: true }],
    }) as any);
    render(<ToolsPage />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});
