import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AboutPanel from "./AboutPanel";

const mockHealth = { modules: { gateway: true, brain: false } };
const fetchHealth = vi.fn();

vi.mock("../../stores/systemStore", () => ({
  useSystemStore: () => ({
    health: mockHealth,
    fetchHealth,
  }),
}));

describe("AboutPanel", () => {
  it("renders version info", () => {
    render(<AboutPanel />);
    expect(screen.getByText("WeBrain")).toBeInTheDocument();
    expect(screen.getByText("1.0.2")).toBeInTheDocument();
    expect(screen.getByText("MIT")).toBeInTheDocument();
  });

  it("renders module statuses", () => {
    render(<AboutPanel />);
    expect(screen.getByText("gateway")).toBeInTheDocument();
    expect(screen.getByText("brain")).toBeInTheDocument();
    expect(screen.getByText("正常")).toBeInTheDocument();
    expect(screen.getByText("异常")).toBeInTheDocument();
  });

  it("renders empty state when no modules", () => {
    mockHealth.modules = {};
    render(<AboutPanel />);
    expect(screen.getByText("暂无状态信息")).toBeInTheDocument();
  });
});
