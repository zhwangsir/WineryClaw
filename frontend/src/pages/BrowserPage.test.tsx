import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import BrowserPage from "./BrowserPage";

const fetchSessions = vi.fn();
const launch = vi.fn();
const newPage = vi.fn();
const navigate = vi.fn();
const click = vi.fn();
const type = vi.fn();
const screenshot = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    sessions: [
      { id: "sess-1", title: "Page 1", url: "https://example.com" },
      { id: "sess-2", title: "Page 2", url: "https://test.com" },
    ],
    fetchSessions,
    launch,
    newPage,
    navigate,
    click,
    type,
    screenshot,
    ...overrides,
  };
}

vi.mock("../stores/browserStore", () => ({
  useBrowserStore: vi.fn(() => createMockStore()),
}));

import { useBrowserStore } from "../stores/browserStore";

describe("BrowserPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useBrowserStore).mockReturnValue(createMockStore());
  });

  it("renders page shell and sessions", () => {
    render(<BrowserPage />);
    expect(screen.getByText("浏览器")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getByText("Page 2")).toBeInTheDocument();
  });

  it("calls fetchSessions on mount", () => {
    render(<BrowserPage />);
    expect(fetchSessions).toHaveBeenCalled();
  });

  it("launches browser", () => {
    render(<BrowserPage />);
    fireEvent.click(screen.getByText("启动浏览器"));
    expect(launch).toHaveBeenCalled();
  });

  it("creates new page", () => {
    render(<BrowserPage />);
    fireEvent.click(screen.getByText("新页面"));
    expect(newPage).toHaveBeenCalled();
  });

  it("selects session and shows controls", () => {
    render(<BrowserPage />);
    // Click on first session row
    const rows = document.querySelectorAll(".ant-table-row");
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(rows[0]);
    expect(screen.getByPlaceholderText("URL")).toBeInTheDocument();
  });

  it("navigates to URL", () => {
    render(<BrowserPage />);
    fireEvent.click(document.querySelectorAll(".ant-table-row")[0]);
    const urlInput = screen.getByPlaceholderText("URL");
    fireEvent.change(urlInput, { target: { value: "https://new.com" } });
    fireEvent.click(screen.getByText("导航"));
    expect(navigate).toHaveBeenCalledWith("sess-1", "https://new.com");
  });

  it("clicks selector", () => {
    render(<BrowserPage />);
    fireEvent.click(document.querySelectorAll(".ant-table-row")[0]);
    const selInput = screen.getByPlaceholderText("CSS Selector");
    fireEvent.change(selInput, { target: { value: "#btn" } });
    fireEvent.click(screen.getByText("点击"));
    expect(click).toHaveBeenCalledWith("sess-1", "#btn");
  });

  it("types text", () => {
    render(<BrowserPage />);
    fireEvent.click(document.querySelectorAll(".ant-table-row")[0]);
    const selInput = screen.getByPlaceholderText("CSS Selector");
    const textInput = screen.getByPlaceholderText("输入文本");
    fireEvent.change(selInput, { target: { value: "#input" } });
    fireEvent.change(textInput, { target: { value: "hello" } });
    fireEvent.click(screen.getByText("输入"));
    expect(type).toHaveBeenCalledWith("sess-1", "#input", "hello");
  });

  it("takes screenshot", async () => {
    screenshot.mockResolvedValue("data:image/png;base64,abc");
    render(<BrowserPage />);
    fireEvent.click(document.querySelectorAll(".ant-table-row")[0]);
    const screenshotBtn = screen.getByRole("button", { name: /截图/i });
    fireEvent.click(screenshotBtn);
    expect(screenshot).toHaveBeenCalledWith("sess-1");
  });

  it("shows empty state when no sessions", () => {
    vi.mocked(useBrowserStore).mockReturnValue(createMockStore({ sessions: [] }));
    render(<BrowserPage />);
    expect(screen.getByText("暂无会话")).toBeInTheDocument();
  });

  it("does not show controls when no active session", () => {
    render(<BrowserPage />);
    expect(screen.queryByPlaceholderText("URL")).not.toBeInTheDocument();
  });

  it("renders session with empty title and url", () => {
    vi.mocked(useBrowserStore).mockReturnValue(createMockStore({
      sessions: [{ id: "sess-empty", title: "", url: "" }],
    }));
    render(<BrowserPage />);
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("renders session with long url", () => {
    vi.mocked(useBrowserStore).mockReturnValue(createMockStore({
      sessions: [{ id: "sess-long", title: "Long", url: "https://example.com/" + "a".repeat(50) }],
    }));
    render(<BrowserPage />);
    expect(screen.getByText("Long")).toBeInTheDocument();
  });
});
