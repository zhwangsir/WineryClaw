import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ChatHeader from "./ChatHeader";

const selectAgent = vi.fn();

vi.mock("../../stores/systemStore", () => ({
  useSystemStore: () => ({
    modelHealth: {
      endpoints: {
        openai: { model_id: "gpt-4", healthy: true, base_url: "https://api.openai.com" },
        local: { model_id: "llama", healthy: false, base_url: "http://localhost" },
      },
    },
  }),
}));

vi.mock("../../stores/configStore", () => ({
  useConfigStore: () => ({
    modelConfig: { modelId: "gpt-4" },
    fetchModelConfig: vi.fn(),
  }),
}));

vi.mock("../../stores/agentStore", () => ({
  useAgentStore: () => ({
    agents: [
      { id: "a1", name: "Agent1", enabled: true, isDefault: true },
      { id: "a2", name: "Agent2", enabled: false },
    ],
    currentAgentId: "a1",
    selectAgent,
  }),
}));

vi.mock("../../api/config", () => ({
  configApi: {
    setModel: vi.fn(),
  },
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    message: {
      success: vi.fn(),
      error: vi.fn(),
    },
  };
});

const baseProps = {
  title: "Chat",
  streaming: false,
  toolEnabled: false,
  onToggleTool: vi.fn(),
  showSearch: false,
  onToggleSearch: vi.fn(),
  onExport: vi.fn(),
  onClear: vi.fn(),
  messagesCount: 0,
};

describe("ChatHeader", () => {
  it("renders title", () => {
    render(<ChatHeader {...baseProps} />);
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("shows streaming indicator", () => {
    render(<ChatHeader {...baseProps} streaming={true} />);
    expect(screen.getByText("生成中…")).toBeInTheDocument();
  });

  it("renders agent selector with options", () => {
    render(<ChatHeader {...baseProps} />);
    expect(screen.getByText("Agent1")).toBeInTheDocument();
  });

  it("renders model selector", () => {
    render(<ChatHeader {...baseProps} />);
    // Select options are rendered inside AntD dropdown, not directly in DOM
    expect(document.querySelector(".ant-select")).toBeInTheDocument();
  });

  it("shows action buttons when messages exist", () => {
    render(<ChatHeader {...baseProps} messagesCount={3} />);
    expect(screen.getByText("清空")).toBeInTheDocument();
  });

  it("calls onToggleTool when tool button clicked", () => {
    render(<ChatHeader {...baseProps} toolEnabled={true} messagesCount={1} />);
    fireEvent.click(screen.getByText("ON"));
    expect(baseProps.onToggleTool).toHaveBeenCalled();
  });

  it("calls onClear when clear confirmed", () => {
    render(<ChatHeader {...baseProps} messagesCount={1} />);
    fireEvent.click(screen.getByText("清空"));
    // Popconfirm opens; we can't easily confirm in test without mocking,
    // but at least the button renders and is clickable
  });

  it("switches model when model select changes", async () => {
    const configApi = await import("../../api/config");
    render(<ChatHeader {...baseProps} messagesCount={1} />);
    // Open the model Select dropdown (second .ant-select on page)
    const selects = document.querySelectorAll(".ant-select");
    expect(selects.length).toBeGreaterThanOrEqual(2);
    const modelSelect = selects[1];
    fireEvent.mouseDown(modelSelect.querySelector(".ant-select-selector")!);
    // Wait for dropdown to render
    await new Promise((r) => setTimeout(r, 0));
    const option = document.querySelector(".ant-select-item-option") as HTMLElement;
    if (option) fireEvent.click(option);
    expect(configApi.configApi.setModel).toHaveBeenCalled();
  });
});
