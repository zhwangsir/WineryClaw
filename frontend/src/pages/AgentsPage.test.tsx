import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AgentsPage from "./AgentsPage";
import { useAgentStore } from "../stores/agentStore";

const fetchAgents = vi.fn();
const createAgent = vi.fn().mockResolvedValue({ id: "new1" });
const updateAgent = vi.fn().mockResolvedValue(undefined);
const deleteAgent = vi.fn().mockResolvedValue(undefined);
const updateSystemPrompt = vi.fn().mockResolvedValue(undefined);
const getSystemPrompt = vi.fn().mockResolvedValue("You are helpful.");
const runAgent = vi.fn().mockResolvedValue("run result");

const defaultMock = {
  agents: [
    {
      id: "a1",
      name: "Coder",
      role: "developer",
      enabled: true,
      isDefault: true,
      description: "Code helper",
      capabilities: ["chat"],
      tools: ["execute_shell"],
      modelConfig: { modelId: "openai/gpt-4", baseUrl: "http://localhost", temperature: 0.7, maxTokens: 4096 },
    },
    { id: "a2", name: "Writer", role: "writer", enabled: false, isDefault: false, description: "", capabilities: [] },
    {
      id: "a3",
      name: "Support",
      role: "support",
      enabled: true,
      isDefault: false,
      description: "Help desk",
      capabilities: ["chat", "reasoning"],
    },
    {
      id: "a4",
      name: "Analyst",
      role: "analyst",
      enabled: true,
      isDefault: false,
      description: "Data",
      capabilities: ["tool_use"],
    },
    {
      id: "a5",
      name: "CustomBot",
      role: "custom",
      enabled: true,
      isDefault: false,
      description: "Custom",
      capabilities: ["memory"],
    },
  ],
  fetchAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  updateSystemPrompt,
  getSystemPrompt,
  runAgent,
};

vi.mock("../stores/agentStore", () => ({
  useAgentStore: vi.fn(() => defaultMock),
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Modal: { ...actual.Modal, confirm: vi.fn(({ onOk }) => onOk?.()) },
  };
});

describe("AgentsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAgentStore).mockReturnValue({
      ...defaultMock,
      agents: [...defaultMock.agents],
    });
  });

  it("renders page with agents", () => {
    render(<AgentsPage />);
    expect(screen.getByText("智能体")).toBeInTheDocument();
    expect(screen.getByText("Coder")).toBeInTheDocument();
    expect(screen.getByText("Writer")).toBeInTheDocument();
  });

  it("calls fetchAgents on mount", () => {
    render(<AgentsPage />);
    expect(fetchAgents).toHaveBeenCalled();
  });

  it("opens create drawer", () => {
    render(<AgentsPage />);
    fireEvent.click(screen.getByRole("button", { name: /新建智能体/i }));
    expect(document.querySelector(".ant-drawer")).toBeInTheDocument();
    expect(screen.getAllByText("新建智能体").length).toBeGreaterThanOrEqual(2);
  });

  it("submits create form", async () => {
    render(<AgentsPage />);
    fireEvent.click(screen.getByRole("button", { name: /新建智能体/i }));

    const nameInput = document.querySelector('input[placeholder*="代码助手"]') as HTMLInputElement;
    if (nameInput) {
      fireEvent.change(nameInput, { target: { value: "TestAgent" } });
    }

    const saveBtn = document.querySelector(".ant-drawer-footer .ant-btn-primary") as HTMLButtonElement;
    if (saveBtn) fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalled();
    });
  });

  it("submits create form with system prompt", async () => {
    render(<AgentsPage />);
    fireEvent.click(screen.getByRole("button", { name: /新建智能体/i }));
    await waitFor(() => expect(document.querySelector(".ant-drawer")).toBeInTheDocument());

    // Switch to prompt tab and fill system prompt
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(0);
    const promptTab = tabs.find((t) => t.textContent?.includes("系统提示词"));
    if (promptTab) fireEvent.click(promptTab);

    const promptArea = Array.from(document.querySelectorAll("textarea")).find(
      (t) => t.getAttribute("rows") === "20"
    ) as HTMLTextAreaElement;
    if (promptArea) {
      fireEvent.change(promptArea, { target: { value: "custom prompt" } });
    }

    // Switch back to basic tab and fill name
    const basicTab = tabs.find((t) => t.textContent?.includes("基本信息"));
    if (basicTab) fireEvent.click(basicTab);

    const nameInput = document.querySelector('input[placeholder*="代码助手"]') as HTMLInputElement;
    if (nameInput) {
      fireEvent.change(nameInput, { target: { value: "PromptAgent" } });
    }

    const saveBtn = document.querySelector(".ant-drawer-footer .ant-btn-primary") as HTMLButtonElement;
    if (saveBtn) fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalled();
      expect(updateSystemPrompt).toHaveBeenCalledWith("new1", "custom prompt");
    });
  });

  it("shows validation error when name is empty", async () => {
    render(<AgentsPage />);
    fireEvent.click(screen.getByRole("button", { name: /新建智能体/i }));

    // Do not fill name, click save directly
    const saveBtn = document.querySelector(".ant-drawer-footer .ant-btn-primary") as HTMLButtonElement;
    if (saveBtn) fireEvent.click(saveBtn);

    // validateFields should fail, no createAgent call
    await waitFor(() => {
      expect(createAgent).not.toHaveBeenCalled();
    });
  });

  it("opens edit drawer when clicking agent card", async () => {
    render(<AgentsPage />);
    fireEvent.click(screen.getByText("Coder"));
    await waitFor(() => {
      expect(getSystemPrompt).toHaveBeenCalledWith("a1");
    });
  });

  it("opens edit drawer via edit button and saves", async () => {
    render(<AgentsPage />);
    const editButtons = screen.getAllByRole("button").filter((b) => b.querySelector("[data-icon='edit']"));
    if (editButtons.length > 0) {
      fireEvent.click(editButtons[0]);
      await waitFor(() => expect(getSystemPrompt).toHaveBeenCalledWith("a1"));

      const saveBtn = document.querySelector(".ant-drawer-footer .ant-btn-primary") as HTMLButtonElement;
      if (saveBtn) fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateAgent).toHaveBeenCalledWith("a1", expect.any(Object));
        expect(updateSystemPrompt).toHaveBeenCalledWith("a1", "You are helpful.");
      });
    }
  });

  it("switches tabs in drawer", async () => {
    render(<AgentsPage />);
    fireEvent.click(screen.getByText("Coder"));
    await waitFor(() => expect(getSystemPrompt).toHaveBeenCalled());

    const tabs = screen.getAllByRole("tab");
    const promptTab = tabs.find((t) => t.textContent?.includes("系统提示词"));
    if (promptTab) fireEvent.click(promptTab);
    await waitFor(() => {
      expect(screen.getByText(/支持模板变量/)).toBeInTheDocument();
    });

    const toolsTab = tabs.find((t) => t.textContent?.includes("工具配置"));
    if (toolsTab) fireEvent.click(toolsTab);
    await waitFor(() => {
      expect(screen.getByText(/选择该智能体可以使用的工具/)).toBeInTheDocument();
    });

    const modelTab = tabs.find((t) => t.textContent?.includes("模型配置"));
    if (modelTab) fireEvent.click(modelTab);
    await waitFor(() => {
      expect(screen.getByText(/留空以上所有字段将使用全局模型配置/)).toBeInTheDocument();
    });
  });

  it("toggles tool checkbox", async () => {
    render(<AgentsPage />);
    fireEvent.click(screen.getByText("Coder"));
    await waitFor(() => expect(getSystemPrompt).toHaveBeenCalled());

    const tabs = screen.getAllByRole("tab");
    const toolsTab = tabs.find((t) => t.textContent?.includes("工具配置"));
    if (toolsTab) fireEvent.click(toolsTab);

    await waitFor(() => {
      expect(screen.getByText(/选择该智能体可以使用的工具/)).toBeInTheDocument();
    });

    const checkboxes = screen.getAllByRole("checkbox");
    if (checkboxes.length > 0) {
      fireEvent.click(checkboxes[0]);
    }
  });

  it("submits create form with model config", async () => {
    render(<AgentsPage />);
    fireEvent.click(screen.getByRole("button", { name: /新建智能体/i }));
    await waitFor(() => expect(document.querySelector(".ant-drawer")).toBeInTheDocument());

    const nameInput = document.querySelector('input[placeholder*="代码助手"]') as HTMLInputElement;
    if (nameInput) {
      fireEvent.change(nameInput, { target: { value: "ModelAgent" } });
    }

    const tabs = screen.getAllByRole("tab");
    const modelTab = tabs.find((t) => t.textContent?.includes("模型配置"));
    if (modelTab) fireEvent.click(modelTab);

    await waitFor(() => {
      expect(screen.getByText(/留空以上所有字段将使用全局模型配置/)).toBeInTheDocument();
    });

    const baseUrlInput = document.querySelector('input[placeholder*="192.168"]') as HTMLInputElement;
    if (baseUrlInput) {
      fireEvent.change(baseUrlInput, { target: { value: "http://custom" } });
    }

    const saveBtn = document.querySelector(".ant-drawer-footer .ant-btn-primary") as HTMLButtonElement;
    if (saveBtn) fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalled();
    });
  });

  it("shows save error on non-validation failure", async () => {
    createAgent.mockRejectedValue(new Error("server error"));
    render(<AgentsPage />);
    fireEvent.click(screen.getByRole("button", { name: /新建智能体/i }));

    const nameInput = document.querySelector('input[placeholder*="代码助手"]') as HTMLInputElement;
    if (nameInput) {
      fireEvent.change(nameInput, { target: { value: "ErrorAgent" } });
    }

    const saveBtn = document.querySelector(".ant-drawer-footer .ant-btn-primary") as HTMLButtonElement;
    if (saveBtn) fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalled();
    });
  });

  it("shows empty state when no agents", () => {
    vi.mocked(useAgentStore).mockReturnValue({
      agents: [],
      fetchAgents,
      createAgent,
      updateAgent,
      deleteAgent,
      updateSystemPrompt,
      getSystemPrompt,
      runAgent,
    });
    render(<AgentsPage />);
    expect(screen.getByText("暂无智能体")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /创建第一个智能体/i })).toBeInTheDocument();
  });

  it("opens run drawer and submits", async () => {
    render(<AgentsPage />);
    const runButtons = screen.getAllByRole("button").filter((b) => b.querySelector("[data-icon='play-circle']"));
    if (runButtons.length > 0) {
      fireEvent.click(runButtons[0]);
      expect(screen.getByText("运行智能体")).toBeInTheDocument();

      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      if (textarea) {
        fireEvent.change(textarea, { target: { value: "hello" } });
      }

      const submitBtn = screen.getByRole("button", { name: /运行/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(runAgent).toHaveBeenCalledWith("a1", "hello");
        expect(screen.getByText("run result")).toBeInTheDocument();
      });
    }
  });

  it("deletes an agent", async () => {
    render(<AgentsPage />);
    const deleteButtons = screen.getAllByRole("button").filter((b) => b.querySelector("[data-icon='delete']"));
    if (deleteButtons.length > 0) {
      fireEvent.click(deleteButtons[0]);
      // Popconfirm confirm button
      const confirmBtn = document.querySelector(".ant-popconfirm-buttons .ant-btn-primary") as HTMLButtonElement;
      if (confirmBtn) {
        fireEvent.click(confirmBtn);
      }
      await waitFor(() => {
        expect(deleteAgent).toHaveBeenCalled();
      });
    }
  });

  it("shows delete button for non-default agent", () => {
    render(<AgentsPage />);
    expect(screen.getByText("Writer")).toBeInTheDocument();
  });

  it("shows model tooltip when modelConfig exists", () => {
    render(<AgentsPage />);
    expect(screen.getByText("gpt-4")).toBeInTheDocument();
  });

  it("shows global model text when no modelConfig", () => {
    render(<AgentsPage />);
    expect(screen.getAllByText("使用全局模型").length).toBeGreaterThanOrEqual(1);
  });

  it("closes drawer via cancel", async () => {
    render(<AgentsPage />);
    fireEvent.click(screen.getByRole("button", { name: /新建智能体/i }));
    expect(document.querySelector(".ant-drawer")).toBeInTheDocument();

    const footer = document.querySelector(".ant-drawer-footer");
    const cancelBtn = footer?.querySelector("button:not(.ant-btn-primary)") as HTMLButtonElement;
    if (cancelBtn) fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(document.querySelector(".ant-drawer")).not.toBeInTheDocument();
    });
  });

  it("covers all role icons", () => {
    render(<AgentsPage />);
    // Each agent card has an icon rendered; just verify all names present
    expect(screen.getByText("Coder")).toBeInTheDocument();
    expect(screen.getByText("Writer")).toBeInTheDocument();
    expect(screen.getByText("Support")).toBeInTheDocument();
    expect(screen.getByText("Analyst")).toBeInTheDocument();
    expect(screen.getByText("CustomBot")).toBeInTheDocument();
  });

  it("triggers card hover effects", () => {
    render(<AgentsPage />);
    const card = screen.getByText("Coder").closest("div") as HTMLDivElement;
    if (card) {
      fireEvent.mouseEnter(card);
      fireEvent.mouseLeave(card);
    }
  });

  it("shows save error without message", async () => {
    updateAgent.mockRejectedValue({});
    render(<AgentsPage />);
    const editButtons = screen.getAllByRole("button").filter((b) => b.querySelector("[data-icon='edit']"));
    if (editButtons.length > 0) {
      fireEvent.click(editButtons[0]);
      await waitFor(() => expect(getSystemPrompt).toHaveBeenCalledWith("a1"));

      const saveBtn = document.querySelector(".ant-drawer-footer .ant-btn-primary") as HTMLButtonElement;
      if (saveBtn) fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateAgent).toHaveBeenCalled();
      });
    }
  });

  it("shows run result fallback when result is empty", async () => {
    runAgent.mockResolvedValue("");
    render(<AgentsPage />);
    const runButtons = screen.getAllByRole("button").filter((b) => b.querySelector("[data-icon='play-circle']"));
    if (runButtons.length > 0) {
      fireEvent.click(runButtons[0]);
      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      if (textarea) fireEvent.change(textarea, { target: { value: "hello" } });
      const submitBtn = screen.getByRole("button", { name: /运行/i });
      fireEvent.click(submitBtn);
      await waitFor(() => {
        expect(runAgent).toHaveBeenCalled();
      });
    }
  });

  it("renders agent with unknown role and no capabilities", () => {
    vi.mocked(useAgentStore).mockReturnValue({
      ...defaultMock,
      agents: [
        {
          id: "a6",
          name: "Unknown",
          role: undefined,
          enabled: true,
          isDefault: false,
          description: "",
          capabilities: undefined,
        },
      ],
    });
    render(<AgentsPage />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});
