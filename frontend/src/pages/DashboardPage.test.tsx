/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import DashboardPage from "./DashboardPage";

const fetchHealth = vi.fn();
const fetchAgents = vi.fn();
const fetchTools = vi.fn();
const fetchChannels = vi.fn();

function createSystemMock(overrides: any = {}) {
  return {
    health: { status: "ok", modules: { sandbox: true, chat: true } },
    modelHealth: { status: "ok", endpoints: { openai: { healthy: true, model_id: "gpt-4" }, anthropic: { healthy: false, model_id: "claude" } } },
    fetchHealth,
    ...overrides,
  };
}

vi.mock("../stores/systemStore", () => ({
  useSystemStore: vi.fn(() => createSystemMock()),
}));

import { useSystemStore } from "../stores/systemStore";

vi.mock("../stores/agentStore", () => ({
  useAgentStore: vi.fn(() => ({
    agents: [{ id: "a1" }, { id: "a2" }],
    fetchAgents,
  })),
}));

vi.mock("../stores/toolStore", () => ({
  useToolStore: vi.fn(() => ({
    tools: [{ id: "t1" }],
    fetchTools,
  })),
}));

vi.mock("../stores/channelStore", () => ({
  useChannelStore: vi.fn(() => ({
    channels: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
    fetchChannels,
  })),
}));

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders page shell", () => {
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    expect(screen.getByText("仪表板")).toBeInTheDocument();
  });

  it("fetches data on mount", () => {
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    expect(fetchHealth).toHaveBeenCalled();
    expect(fetchAgents).toHaveBeenCalled();
    expect(fetchTools).toHaveBeenCalled();
    expect(fetchChannels).toHaveBeenCalled();
  });

  it("renders stat cards", () => {
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    expect(screen.getAllByText("智能体").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("工具").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("通道").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("模型端点").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("沙箱").length).toBeGreaterThanOrEqual(1);
  });

  it("renders module health list", () => {
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    expect(screen.getByText("sandbox")).toBeInTheDocument();
    expect(screen.getByText("chat")).toBeInTheDocument();
  });

  it("renders model endpoints", () => {
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
  });

  it("shows no endpoints message when empty", () => {
    vi.mocked(useSystemStore).mockImplementation(() =>
      createSystemMock({ modelHealth: { status: "ok", endpoints: {} } }) as any
    );
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    expect(screen.getByText("未配置模型端点")).toBeInTheDocument();
  });

  it("refreshes data on click", () => {
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("刷新"));
    expect(fetchHealth).toHaveBeenCalledTimes(2);
    expect(fetchAgents).toHaveBeenCalledTimes(2);
  });

  it("shows loading when health is null", () => {
    vi.mocked(useSystemStore).mockImplementation(() =>
      createSystemMock({ health: null }) as any
    );
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    expect(screen.getByText("加载中...")).toBeInTheDocument();
  });

  it("shows skeleton when no modules", () => {
    vi.mocked(useSystemStore).mockImplementation(() =>
      createSystemMock({ health: { status: "ok", modules: {} } }) as any
    );
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    expect(document.querySelector(".ant-skeleton")).toBeTruthy();
  });

  it("handles mouse enter and leave on stat cards", () => {
    vi.mocked(useSystemStore).mockImplementation(() => createSystemMock() as any);
    const { container } = render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    const cards = container.querySelectorAll(".ant-card");
    expect(cards.length).toBeGreaterThan(0);
    fireEvent.mouseEnter(cards[0]);
    fireEvent.mouseLeave(cards[0]);
  });

  it("renders with missing modules and modelHealth", () => {
    vi.mocked(useSystemStore).mockImplementation(() =>
      createSystemMock({ health: { status: "ok" }, modelHealth: undefined }) as any
    );
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    expect(screen.getByText("未配置模型端点")).toBeInTheDocument();
  });

  it("renders inactive module status", () => {
    vi.mocked(useSystemStore).mockImplementation(() =>
      createSystemMock({ health: { status: "ok", modules: { sandbox: false, chat: true } } }) as any
    );
    render(<BrowserRouter><DashboardPage /></BrowserRouter>);
    expect(screen.getByText("sandbox")).toBeInTheDocument();
  });
});
