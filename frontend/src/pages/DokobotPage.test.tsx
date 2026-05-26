/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import DokobotPage from "./DokobotPage";

const fetchStatus = vi.fn();
const browse = vi.fn();
const search = vi.fn();
const screenshot = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    available: true,
    fetchStatus,
    browse,
    search,
    screenshot,
    ...overrides,
  };
}

vi.mock("../stores/dokobotStore", () => ({
  useDokobotStore: vi.fn(() => createMockStore()),
}));

import { useDokobotStore } from "../stores/dokobotStore";

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Card: ({ children, title, bodyStyle, ...rest }: any) => (
      <div data-testid="card" {...rest}>
        {title && <div data-testid="card-title">{title}</div>}
        <div style={bodyStyle}>{children}</div>
      </div>
    ),
    Image: ({ src, alt }: any) => <img data-testid="screenshot-image" src={src} alt={alt} />,
  };
});

describe("DokobotPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useDokobotStore).mockImplementation(() => createMockStore() as any);
  });

  it("renders page shell", () => {
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );
    expect(screen.getByText("Dokobot")).toBeInTheDocument();
  });

  it("fetches status on mount", () => {
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );
    expect(fetchStatus).toHaveBeenCalled();
  });

  it("shows available tag when available", () => {
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );
    expect(screen.getByText("服务可用")).toBeInTheDocument();
  });

  it("shows unavailable tag when not available", () => {
    vi.mocked(useDokobotStore).mockImplementation(() => createMockStore({ available: false }) as any);
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );
    expect(screen.getByText("服务不可用")).toBeInTheDocument();
  });

  it("browses URL and shows result", async () => {
    browse.mockResolvedValue({ title: "Example" });
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );

    const urlInputs = screen.getAllByPlaceholderText("URL");
    fireEvent.change(urlInputs[0], { target: { value: "https://example.com" } });

    const browseBtn = screen.getByRole("button", { name: /浏览/i });
    fireEvent.click(browseBtn);

    await waitFor(() => {
      expect(browse).toHaveBeenCalledWith("https://example.com");
    });
    await waitFor(() => {
      expect(screen.getByText(/Example/)).toBeInTheDocument();
    });
  });

  it("searches query and shows result", async () => {
    search.mockResolvedValue({ results: ["a", "b"] });
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );

    const searchInput = screen.getByPlaceholderText("搜索关键词");
    fireEvent.change(searchInput, { target: { value: "test query" } });

    const searchBtn = screen.getByRole("button", { name: /搜索/i });
    fireEvent.click(searchBtn);

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith("test query");
    });
    await waitFor(() => {
      expect(screen.getByText(/"a"/)).toBeInTheDocument();
    });
  });

  it("takes screenshot and displays image", async () => {
    screenshot.mockResolvedValue("data:image/png;base64,abc");
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );

    const urlInputs = screen.getAllByPlaceholderText("URL");
    fireEvent.change(urlInputs[0], { target: { value: "https://example.com" } });

    const screenshotBtn = screen.getByRole("button", { name: /截图/i });
    fireEvent.click(screenshotBtn);

    await waitFor(() => {
      expect(screenshot).toHaveBeenCalledWith("https://example.com");
    });
    await waitFor(() => {
      expect(screen.getByTestId("screenshot-image")).toHaveAttribute("src", "data:image/png;base64,abc");
    });
  });

  it("does not browse when URL is empty", () => {
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );
    const browseBtn = screen.getByRole("button", { name: /浏览/i });
    fireEvent.click(browseBtn);
    expect(browse).not.toHaveBeenCalled();
  });

  it("does not search when query is empty", () => {
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );
    const searchBtn = screen.getByRole("button", { name: /搜索/i });
    fireEvent.click(searchBtn);
    expect(search).not.toHaveBeenCalled();
  });

  it("does not screenshot when URL is empty", () => {
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );
    const screenshotBtn = screen.getByRole("button", { name: /截图/i });
    fireEvent.click(screenshotBtn);
    expect(screenshot).not.toHaveBeenCalled();
  });

  it("hides result card when result is null", async () => {
    browse.mockResolvedValue(null);
    render(
      <BrowserRouter>
        <DokobotPage />
      </BrowserRouter>
    );
    const urlInputs = screen.getAllByPlaceholderText("URL");
    fireEvent.change(urlInputs[0], { target: { value: "https://example.com" } });
    const browseBtn = screen.getByRole("button", { name: /浏览/i });
    fireEvent.click(browseBtn);

    await waitFor(() => expect(browse).toHaveBeenCalled());
    expect(screen.queryByText("结果")).not.toBeInTheDocument();
  });
});
