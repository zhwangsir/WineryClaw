import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GlobalConfigPanel from "./GlobalConfigPanel";
import { useConfigStore } from "../../stores/configStore";

const fetchGlobalConfig = vi.fn();
const saveGlobalConfig = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    globalConfig: {
      debug: false,
      logLevel: "info",
      maxConcurrentTools: 4,
      toolTimeoutMs: 30000,
      requireConfirmation: true,
      whitelistMode: "permissive",
    },
    loading: false,
    fetchGlobalConfig,
    saveGlobalConfig,
    ...overrides,
  };
}

vi.mock("../../stores/configStore", () => ({
  useConfigStore: vi.fn(() => createMockStore()),
}));

describe("GlobalConfigPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConfigStore).mockReturnValue(createMockStore());
  });

  it("fetches config on mount", () => {
    render(<GlobalConfigPanel />);
    expect(fetchGlobalConfig).toHaveBeenCalled();
  });

  it("renders form fields", () => {
    render(<GlobalConfigPanel />);
    expect(screen.getByText("Debug 模式")).toBeInTheDocument();
    expect(screen.getByText("日志级别")).toBeInTheDocument();
    expect(screen.getByText("最大并发工具数")).toBeInTheDocument();
    expect(screen.getByText("工具超时 (毫秒)")).toBeInTheDocument();
    expect(screen.getByText("需要确认")).toBeInTheDocument();
    expect(screen.getByText("白名单模式")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    vi.mocked(useConfigStore).mockReturnValue(createMockStore({ loading: true }));
    const { container } = render(<GlobalConfigPanel />);
    expect(container.querySelector(".ant-spin-spinning")).toBeTruthy();
  });

  it("saves config", async () => {
    saveGlobalConfig.mockResolvedValue(undefined);
    render(<GlobalConfigPanel />);
    const saveBtn = screen.getByText("保存配置");
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(saveGlobalConfig).toHaveBeenCalled();
    });
  });

  it("renders with null config", () => {
    vi.mocked(useConfigStore).mockReturnValue(createMockStore({ globalConfig: null }));
    render(<GlobalConfigPanel />);
    expect(screen.getByText("保存配置")).toBeInTheDocument();
  });
});
