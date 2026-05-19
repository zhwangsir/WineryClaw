/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import HooksPage from "./HooksPage";

const registry = vi.fn();

vi.mock("../api/hooks", () => ({
  hooksApi: {
    registry: vi.fn(() => registry()),
  },
}));

describe("HooksPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders page shell", async () => {
    registry.mockResolvedValue([]);
    render(<BrowserRouter><HooksPage /></BrowserRouter>);
    await waitFor(() => {
      expect(screen.getByText("Hooks")).toBeInTheDocument();
    });
  });

  it("renders hooks from registry", async () => {
    registry.mockResolvedValue(["pre_tool_call", "post_llm_call", "custom_hook"]);
    render(<BrowserRouter><HooksPage /></BrowserRouter>);
    await waitFor(() => {
      expect(screen.getByText("pre_tool_call")).toBeInTheDocument();
    });
    expect(screen.getByText("工具调用前钩子")).toBeInTheDocument();
    expect(screen.getByText("LLM 调用后钩子")).toBeInTheDocument();
    expect(screen.getByText("自定义钩子")).toBeInTheDocument();
  });

  it("shows empty on error", async () => {
    registry.mockRejectedValue(new Error("fail"));
    render(<BrowserRouter><HooksPage /></BrowserRouter>);
    await waitFor(() => {
      expect(screen.getByText("暂无 Hook 注册信息")).toBeInTheDocument();
    });
  });
});
