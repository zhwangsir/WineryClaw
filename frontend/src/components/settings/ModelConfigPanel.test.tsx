/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ModelConfigPanel from "./ModelConfigPanel";

const fetchModelConfig = vi.fn();
const saveModelConfig = vi.fn();
const detectModel = vi.fn();
const resetModel = vi.fn();

const baseConfig = {
  baseUrl: "http://localhost:1234/v1",
  modelId: "gpt-4o",
  apiKey: "sk-test",
  temperature: 0.7,
  maxTokens: 4096,
  endpoints: [
    { name: "openai", baseUrl: "https://api.openai.com/v1", modelId: "gpt-4o", priority: 5, timeout: 60 },
    { name: "local", baseUrl: "http://localhost:1234/v1", modelId: "llama", priority: 3, timeout: 30 },
  ],
};

vi.mock("../../stores/configStore", () => ({
  useConfigStore: vi.fn(() => ({
    modelConfig: baseConfig,
    loading: false,
    detecting: false,
    detectResult: null,
    fetchModelConfig,
    saveModelConfig,
    detectModel,
    resetModel,
  })),
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual("antd");
  return {
    ...actual,
    message: {
      success: vi.fn(),
      warning: vi.fn(),
    },
  };
});

import { useConfigStore } from "../../stores/configStore";
import { message } from "antd";

describe("ModelConfigPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConfigStore).mockReturnValue({
      modelConfig: baseConfig,
      loading: false,
      detecting: false,
      detectResult: null,
      fetchModelConfig,
      saveModelConfig,
      detectModel,
      resetModel,
    } as any);
  });

  it("renders base config form", () => {
    render(<ModelConfigPanel />);
    expect(screen.getByText("基础配置")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("http://localhost:1234/v1")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("gpt-4o")).toBeInTheDocument();
  });

  it("calls fetchModelConfig on mount", () => {
    render(<ModelConfigPanel />);
    expect(fetchModelConfig).toHaveBeenCalled();
  });

  it("renders endpoints table", () => {
    render(<ModelConfigPanel />);
    expect(screen.getByText("模型端点")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("local")).toBeInTheDocument();
  });

  it("saves base config", async () => {
    render(<ModelConfigPanel />);
    const btn = screen.getByText("保存配置");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(saveModelConfig).toHaveBeenCalled();
      expect(message.success).toHaveBeenCalledWith("模型配置已保存");
    });
  });

  it("detects model and shows success", async () => {
    vi.mocked(detectModel).mockResolvedValue(undefined);
    vi.mocked(useConfigStore).mockReturnValue({
      modelConfig: baseConfig,
      loading: false,
      detecting: false,
      detectResult: { ok: true, message: "ok" },
      fetchModelConfig,
      saveModelConfig,
      detectModel,
      resetModel,
    } as any);

    render(<ModelConfigPanel />);
    const btn = screen.getByText("检测模型");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(detectModel).toHaveBeenCalled();
      expect(message.success).toHaveBeenCalledWith("ok");
    });
  });

  it("detects model and shows warning on failure", async () => {
    vi.mocked(detectModel).mockResolvedValue(undefined);
    vi.mocked(useConfigStore).mockReturnValue({
      modelConfig: baseConfig,
      loading: false,
      detecting: false,
      detectResult: { ok: false, message: "fail" },
      fetchModelConfig,
      saveModelConfig,
      detectModel,
      resetModel,
    } as any);

    render(<ModelConfigPanel />);
    const btn = screen.getByText("检测模型");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(detectModel).toHaveBeenCalled();
      expect(message.warning).toHaveBeenCalledWith("fail");
    });
  });

  it("resets model config", async () => {
    vi.mocked(resetModel).mockResolvedValue(undefined);
    render(<ModelConfigPanel />);
    const btn = screen.getByText("重置默认");
    fireEvent.click(btn);
    // Popconfirm confirm button
    const confirmBtn = document.querySelector(".ant-popconfirm-buttons button:last-child");
    if (confirmBtn) fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(resetModel).toHaveBeenCalled();
      expect(message.success).toHaveBeenCalledWith("已重置为默认配置");
    });
  });

  it("opens add endpoint modal", () => {
    render(<ModelConfigPanel />);
    const addBtn = screen.getAllByText("新增端点").find((el) => el.closest("button"));
    expect(addBtn).toBeTruthy();
    if (addBtn) fireEvent.click(addBtn);
    // Modal title uses inline style fontWeight 600
    const modalTitle = screen.getAllByText("新增端点").find((el) => {
      const style = (el as HTMLElement).style;
      return style.fontWeight === "600";
    });
    expect(modalTitle).toBeTruthy();
  });

  it("adds a new endpoint", async () => {
    render(<ModelConfigPanel />);
    const addBtn = screen.getAllByText("新增端点").find((el) => el.closest("button"));
    if (addBtn) fireEvent.click(addBtn);
    const nameInput = screen.getAllByPlaceholderText("例如: openai")[0];
    const urlInput = screen.getAllByPlaceholderText("https://api.openai.com/v1")[0];
    fireEvent.change(nameInput, { target: { value: "newep" } });
    fireEvent.change(urlInput, { target: { value: "http://new" } });

    // modelId input inside modal
    const modelInput = screen.getAllByPlaceholderText("gpt-4o")[0];
    fireEvent.change(modelInput, { target: { value: "gpt-3" } });

    const okBtn = screen.getAllByRole("button").find((b) => b.textContent?.includes("保存"));
    if (okBtn) fireEvent.click(okBtn);

    await waitFor(() => {
      expect(saveModelConfig).toHaveBeenCalled();
    });
  });

  it("edits an endpoint", async () => {
    render(<ModelConfigPanel />);
    const editButtons = screen.getAllByRole("button").filter((b) => b.querySelector("[data-icon='edit']") || b.querySelector(".anticon-edit"));
    if (editButtons.length > 0) {
      fireEvent.click(editButtons[0]);
      await waitFor(() => {
        expect(screen.getByText("编辑端点")).toBeInTheDocument();
      });
    }
  });

  it("deletes an endpoint", async () => {
    vi.mocked(saveModelConfig).mockResolvedValue(undefined);
    render(<ModelConfigPanel />);
    const deleteButtons = screen.getAllByRole("button").filter((b) => b.querySelector("[data-icon='delete']") || b.querySelector(".anticon-delete"));
    if (deleteButtons.length > 0) {
      fireEvent.click(deleteButtons[0]);
      // Popconfirm confirm
      const confirmBtn = document.querySelector(".ant-popconfirm-buttons button:last-child");
      if (confirmBtn) fireEvent.click(confirmBtn);
      await waitFor(() => {
        expect(saveModelConfig).toHaveBeenCalled();
      });
    }
  });

  it("shows detect result with endpoints", () => {
    vi.mocked(useConfigStore).mockReturnValue({
      modelConfig: baseConfig,
      loading: false,
      detecting: false,
      detectResult: {
        ok: true,
        message: "all good",
        details: {
          endpoints: [
            { name: "ep1", ok: true, message: "ready", availableModels: ["m1", "m2"] },
            { name: "ep2", ok: false, message: "down" },
          ],
        },
      },
      fetchModelConfig,
      saveModelConfig,
      detectModel,
      resetModel,
    } as any);

    render(<ModelConfigPanel />);
    expect(screen.getByText(/检测通过/)).toBeInTheDocument();
    expect(screen.getByText("ep1")).toBeInTheDocument();
    expect(screen.getByText("ep2")).toBeInTheDocument();
    expect(screen.getByText(/m1, m2/)).toBeInTheDocument();
  });

  it("shows loading spinner", () => {
    vi.mocked(useConfigStore).mockReturnValue({
      modelConfig: null,
      loading: true,
      detecting: false,
      detectResult: null,
      fetchModelConfig,
      saveModelConfig,
      detectModel,
      resetModel,
    } as any);

    render(<ModelConfigPanel />);
    expect(document.querySelector(".ant-spin")).toBeTruthy();
  });
});
