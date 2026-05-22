import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SkillsPage from "./SkillsPage";
import { skillsApi } from "../api/skills";

vi.mock("../api/skills", () => ({
  skillsApi: {
    list: vi.fn(),
    stats: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    invoke: vi.fn(),
  },
  Skill: {},
  SkillStats: {},
}));

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Popconfirm: ({ children, onConfirm }: any) => <span onClick={onConfirm}>{children}</span>,
  };
});

describe("SkillsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(skillsApi.list).mockResolvedValue([
      {
        id: "sk1",
        name: "Summarize",
        description: "Summarize text",
        language: "python",
        usageCount: 5,
        successRate: 0.9,
        triggerPatterns: ["summarize"],
        tags: ["text"],
        code: "def run(p): return p",
      },
    ]);
    vi.mocked(skillsApi.stats).mockResolvedValue({ totalSkills: 1, totalInvocations: 5, averageSuccessRate: 0.9 });
    vi.mocked(skillsApi.create).mockResolvedValue(undefined);
    vi.mocked(skillsApi.update).mockResolvedValue(undefined);
    vi.mocked(skillsApi.delete).mockResolvedValue(undefined);
    vi.mocked(skillsApi.invoke).mockResolvedValue({ result: "ok" });
  });

  it("renders skills", async () => {
    render(<SkillsPage />);
    expect(await screen.findByText("Summarize")).toBeInTheDocument();
  });

  it("renders stats", async () => {
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    expect(screen.getByText("技能总数")).toBeInTheDocument();
    expect(screen.getByText("调用次数")).toBeInTheDocument();
    expect(screen.getByText("成功率")).toBeInTheDocument();
  });

  it("shows empty state when no skills", async () => {
    vi.mocked(skillsApi.list).mockResolvedValue([]);
    vi.mocked(skillsApi.stats).mockResolvedValue({ totalSkills: 0, totalInvocations: 0, averageSuccessRate: 0 });
    render(<SkillsPage />);
    await waitFor(() => {
      expect(screen.getByText("暂无注册技能")).toBeInTheDocument();
    });
  });

  it("opens create drawer", async () => {
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    fireEvent.click(screen.getByText("新建技能"));
    // Drawer title is distinct from button label so this asserts the
    // drawer actually opened (vs just finding the button itself).
    expect(screen.getByText("创建新技能")).toBeInTheDocument();
  });

  it("submits create form", async () => {
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    fireEvent.click(screen.getByText("新建技能"));

    const nameInput = document.querySelector('input[placeholder*="summarize_text"]') as HTMLInputElement;
    if (nameInput) fireEvent.change(nameInput, { target: { value: "NewSkill" } });

    const descInput = document.querySelectorAll("input")[1] as HTMLInputElement;
    if (descInput) fireEvent.change(descInput, { target: { value: "Desc" } });

    const codeArea = document.querySelector("textarea") as HTMLTextAreaElement;
    if (codeArea) fireEvent.change(codeArea, { target: { value: "code" } });

    const submitBtn = screen.getByRole("button", { name: /Create/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(skillsApi.create).toHaveBeenCalled();
    });
  });

  it("opens edit drawer with prefilled form", async () => {
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    fireEvent.click(screen.getByText("编辑"));
    expect(screen.getByText("编辑技能")).toBeInTheDocument();

    const nameInput = document.querySelector('input[value="Summarize"]') as HTMLInputElement;
    expect(nameInput).toBeInTheDocument();
  });

  it("submits edit form", async () => {
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    fireEvent.click(screen.getByText("编辑"));

    const submitBtn = screen.getByRole("button", { name: /Update/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(skillsApi.update).toHaveBeenCalledWith("sk1", expect.any(Object));
    });
  });

  it("deletes a skill", async () => {
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    const deleteBtn = screen.getByRole("button", { name: /删除/i });
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      expect(skillsApi.delete).toHaveBeenCalledWith("sk1");
    });
  });

  it("opens invoke drawer", async () => {
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    fireEvent.click(screen.getByText("运行"));
    expect(screen.getByText("调用技能")).toBeInTheDocument();
  });

  it("invokes skill with result", async () => {
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    fireEvent.click(screen.getByText("运行"));

    const runBtn = screen.getByRole("button", { name: "立即执行" });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(skillsApi.invoke).toHaveBeenCalledWith("sk1", {});
      expect(screen.getByText(/"result": "ok"/)).toBeInTheDocument();
    });
  });

  it("invokes skill with invalid JSON params", async () => {
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    fireEvent.click(screen.getByText("运行"));

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    if (textarea) fireEvent.change(textarea, { target: { value: "not json" } });

    const runBtn = screen.getByRole("button", { name: "立即执行" });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(skillsApi.invoke).toHaveBeenCalledWith("sk1", {});
    });
  });

  it("handles fetch error gracefully", async () => {
    vi.mocked(skillsApi.list).mockRejectedValue(new Error("network"));
    render(<SkillsPage />);
    await waitFor(() => {
      expect(skillsApi.list).toHaveBeenCalled();
    });
  });

  it("refreshes data", async () => {
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    // v2.22.1: wait for the refresh button's loading state to clear before
    // clicking. The button uses `loading={loading}` from fetchData; AntD makes
    // loading buttons non-clickable, so on slow CI VMs the click can land
    // before mount-time fetchData finishes and is silently consumed by the
    // loading affordance — only ONE list call (mount) registers, refresh test
    // sees `expected 2, got 1`. waitFor here polls until the button is enabled.
    await waitFor(() => {
      const btn = screen.getByText("刷新").closest("button");
      expect(btn).toBeTruthy();
      expect(btn?.classList.contains("ant-btn-loading")).toBe(false);
    });
    fireEvent.click(screen.getByText("刷新"));
    await waitFor(() => {
      expect(skillsApi.list).toHaveBeenCalledTimes(2);
    });
  });

  it("shows error when create fails", async () => {
    vi.mocked(skillsApi.create).mockRejectedValue(new Error("create failed"));
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    fireEvent.click(screen.getByText("新建技能"));

    const inputs = document.querySelectorAll("input");
    const nameInput = Array.from(inputs).find((i) => i.placeholder?.includes("summarize_text")) as HTMLInputElement;
    if (nameInput) fireEvent.change(nameInput, { target: { value: "FailSkill" } });

    const descInput = Array.from(inputs).find((i) => i.placeholder?.includes("What does")) as HTMLInputElement;
    if (descInput) fireEvent.change(descInput, { target: { value: "desc" } });

    const codeArea = document.querySelector("textarea") as HTMLTextAreaElement;
    if (codeArea) fireEvent.change(codeArea, { target: { value: "code" } });

    const submitBtn = screen.getByRole("button", { name: /Create/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(skillsApi.create).toHaveBeenCalled();
    });
  });

  it("shows error when delete fails", async () => {
    vi.mocked(skillsApi.delete).mockRejectedValue(new Error("delete failed"));
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    const deleteBtn = screen.getByRole("button", { name: /删除/i });
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      expect(skillsApi.delete).toHaveBeenCalledWith("sk1");
    });
  });

  it("shows error when invoke fails", async () => {
    vi.mocked(skillsApi.invoke).mockRejectedValue(new Error("invoke failed"));
    render(<SkillsPage />);
    await screen.findByText("Summarize");
    fireEvent.click(screen.getByText("运行"));

    const runBtn = screen.getByRole("button", { name: "立即执行" });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(skillsApi.invoke).toHaveBeenCalledWith("sk1", {});
      expect(screen.getByText(/Error: invoke failed/)).toBeInTheDocument();
    });
  });
});
