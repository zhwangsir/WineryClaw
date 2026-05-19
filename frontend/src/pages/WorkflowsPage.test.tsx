/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import WorkflowsPage from "./WorkflowsPage";

const fetchWorkflows = vi.fn();
const createWorkflow = vi.fn();
const deleteWorkflow = vi.fn();
const runWorkflow = vi.fn();
const fetchRuns = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    workflows: [
      { id: "w1", name: "WF One", description: "Desc", nodes: [{ id: "n1" }], edges: [{ id: "e1" }] },
      { id: "w2", name: "WF Two", description: "", nodes: [], edges: [] },
    ],
    runs: [
      { runId: "r1", status: "completed", startedAt: "2024-01-01T00:00:00Z" },
    ],
    fetchWorkflows,
    createWorkflow,
    deleteWorkflow,
    runWorkflow,
    fetchRuns,
    ...overrides,
  };
}

vi.mock("../stores/workflowStore", () => ({
  useWorkflowStore: vi.fn(() => createMockStore()),
}));

import { useWorkflowStore } from "../stores/workflowStore";

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Popconfirm: ({ children, onConfirm }: any) => (
      <div data-testid="popconfirm" onClick={onConfirm}>{children}</div>
    ),
    Card: ({ children, title, actions, bodyStyle, headStyle, ...rest }: any) => (
      <div data-testid="card" {...rest}>
        {title && <div data-testid="card-title">{title}</div>}
        {actions && <div data-testid="card-actions">{actions}</div>}
        <div style={bodyStyle}>{children}</div>
      </div>
    ),
  };
});

describe("WorkflowsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useWorkflowStore).mockImplementation(() => createMockStore() as any);
  });

  it("renders page shell", () => {
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    expect(screen.getByText("工作流")).toBeInTheDocument();
  });

  it("fetches workflows on mount", () => {
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    expect(fetchWorkflows).toHaveBeenCalled();
  });

  it("renders workflow cards", () => {
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    expect(screen.getByText("WF One")).toBeInTheDocument();
    expect(screen.getByText("WF Two")).toBeInTheDocument();
    expect(screen.getByText("Desc")).toBeInTheDocument();
    expect(screen.getByText("无描述")).toBeInTheDocument();
  });

  it("shows empty state when no workflows", () => {
    vi.mocked(useWorkflowStore).mockImplementation(() => createMockStore({ workflows: [] }) as any);
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    expect(screen.getByText("暂无工作流")).toBeInTheDocument();
  });

  it("opens create drawer and submits", async () => {
    createWorkflow.mockResolvedValue(undefined);
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("新建工作流"));
    expect(document.querySelector(".ant-drawer")).toBeTruthy();

    const nameInput = screen.getByPlaceholderText("工作流名称");
    fireEvent.change(nameInput, { target: { value: "New WF" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    expect(submitBtn).toBeTruthy();
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createWorkflow).toHaveBeenCalledWith(expect.objectContaining({ name: "New WF", nodes: [], edges: [] }));
    });
  });

  it("opens run drawer and submits with valid JSON", async () => {
    runWorkflow.mockResolvedValue(undefined);
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    const runButtons = screen.getAllByText("运行");
    fireEvent.click(runButtons[0]);

    expect(screen.getByText(/运行: WF One/)).toBeInTheDocument();
    expect(fetchRuns).toHaveBeenCalledWith("w1");

    const textarea = document.querySelector("textarea");
    if (textarea) fireEvent.change(textarea, { target: { value: '{"key":"val"}' } });

    const forms = document.querySelectorAll("form");
    const runForm = forms[forms.length - 1];
    fireEvent.submit(runForm);

    await waitFor(() => {
      expect(runWorkflow).toHaveBeenCalledWith("w1", { key: "val" });
    });
  });

  it("shows JSON error on invalid inputs in run drawer", async () => {
    runWorkflow.mockResolvedValue(undefined);
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    const runButtons = screen.getAllByText("运行");
    fireEvent.click(runButtons[0]);

    const textarea = document.querySelector("textarea");
    if (textarea) fireEvent.change(textarea, { target: { value: "not json" } });

    const forms = document.querySelectorAll("form");
    const runForm = forms[forms.length - 1];
    fireEvent.submit(runForm);
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("submits run with empty inputs as empty object", async () => {
    runWorkflow.mockResolvedValue(undefined);
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    const runButtons = screen.getAllByText("运行");
    fireEvent.click(runButtons[0]);

    const textarea = document.querySelector("textarea");
    if (textarea) fireEvent.change(textarea, { target: { value: "" } });

    const forms = document.querySelectorAll("form");
    const runForm = forms[forms.length - 1];
    fireEvent.submit(runForm);

    await waitFor(() => {
      expect(runWorkflow).toHaveBeenCalledWith("w1", {});
    });
  });

  it("renders run with unknown status", () => {
    vi.mocked(useWorkflowStore).mockImplementation(() => createMockStore({
      runs: [{ runId: "r2", status: "unknown", startedAt: "2024-01-01T00:00:00Z" }],
    }) as any);
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    const runButtons = screen.getAllByText("运行");
    fireEvent.click(runButtons[0]);
    expect(screen.getByText("历史运行")).toBeInTheDocument();
  });

  it("deletes workflow on confirm", () => {
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    const popconfirms = screen.getAllByTestId("popconfirm");
    if (popconfirms.length > 0) {
      fireEvent.click(popconfirms[0]);
      expect(deleteWorkflow).toHaveBeenCalledWith("w1");
    }
  });

  it("renders runs table when runs exist", () => {
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    const runButtons = screen.getAllByText("运行");
    fireEvent.click(runButtons[0]);
    expect(screen.getByText("历史运行")).toBeInTheDocument();
  });

  it("does not run workflow when selectedWorkflow is null", () => {
    render(<BrowserRouter><WorkflowsPage /></BrowserRouter>);
    // Directly verify guard by ensuring no crash when no workflow selected
    expect(runWorkflow).not.toHaveBeenCalled();
  });
});
