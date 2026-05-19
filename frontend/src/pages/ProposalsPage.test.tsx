/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import ProposalsPage from "./ProposalsPage";

const fetchProposals = vi.fn();
const createProposal = vi.fn();
const vote = vi.fn();
const close = vi.fn();

function createMockStore(overrides: any = {}) {
  return {
    proposals: [
      { id: "p1", topic: "Topic A", proposerId: "a1", status: "open", votes: [{}, {}], quorum: 3 },
      { id: "p2", topic: "Topic B", proposerId: "a2", status: "closed", votes: [], quorum: 1 },
    ],
    loading: false,
    fetchProposals,
    createProposal,
    vote,
    close,
    ...overrides,
  };
}

vi.mock("../stores/proposalStore", () => ({
  useProposalStore: vi.fn(() => createMockStore()),
}));

import { useProposalStore } from "../stores/proposalStore";

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    Popconfirm: ({ children, onConfirm }: any) => (
      <div data-testid="popconfirm" onClick={onConfirm}>{children}</div>
    ),
    Select: ({ value, onChange, options }: any) => (
      <select value={value} onChange={(e) => onChange?.(e.target.value)}>
        {options?.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    ),
  };
});

describe("ProposalsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useProposalStore).mockImplementation(() => createMockStore() as any);
  });

  it("renders page shell", () => {
    render(<BrowserRouter><ProposalsPage /></BrowserRouter>);
    expect(screen.getByText("提案")).toBeInTheDocument();
  });

  it("fetches proposals on mount", () => {
    render(<BrowserRouter><ProposalsPage /></BrowserRouter>);
    expect(fetchProposals).toHaveBeenCalled();
  });

  it("renders proposals table", () => {
    render(<BrowserRouter><ProposalsPage /></BrowserRouter>);
    expect(screen.getByText("Topic A")).toBeInTheDocument();
    expect(screen.getByText("Topic B")).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("renders proposal with unknown status and no votes", () => {
    vi.mocked(useProposalStore).mockImplementation(() => createMockStore({
      proposals: [
        { id: "p3", topic: "Topic C", proposerId: "a3", status: "unknown" },
      ],
    }) as any);
    render(<BrowserRouter><ProposalsPage /></BrowserRouter>);
    expect(screen.getByText("Topic C")).toBeInTheDocument();
    expect(screen.getByText("0 / 1")).toBeInTheDocument();
  });

  it("shows empty state when no proposals", () => {
    vi.mocked(useProposalStore).mockImplementation(() => createMockStore({ proposals: [] }) as any);
    render(<BrowserRouter><ProposalsPage /></BrowserRouter>);
    expect(screen.getByText("暂无提案")).toBeInTheDocument();
  });

  it("opens create drawer and submits", async () => {
    createProposal.mockResolvedValue(undefined);
    render(<BrowserRouter><ProposalsPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("新建提案"));
    expect(document.querySelector(".ant-drawer")).toBeTruthy();

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "a1" } });
    fireEvent.change(inputs[1], { target: { value: "New Topic" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    expect(submitBtn).toBeTruthy();
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({ topic: "New Topic", quorum: 1 }));
    });
  });

  it("submits with default quorum when not provided", async () => {
    createProposal.mockResolvedValue(undefined);
    render(<BrowserRouter><ProposalsPage /></BrowserRouter>);
    fireEvent.click(screen.getByText("新建提案"));

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "a1" } });
    fireEvent.change(inputs[1], { target: { value: "Topic" } });

    // Clear quorum input to test fallback
    const numberInput = document.querySelector('input[type="number"]') as HTMLInputElement;
    if (numberInput) fireEvent.change(numberInput, { target: { value: "" } });

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({ quorum: 1 }));
    });
  });

  it("opens vote drawer", () => {
    render(<BrowserRouter><ProposalsPage /></BrowserRouter>);
    const voteButtons = screen.getAllByText("投票");
    fireEvent.click(voteButtons[0]);
    expect(document.querySelector(".ant-drawer")).toBeTruthy();
  });

  it("closes proposal on confirm", () => {
    render(<BrowserRouter><ProposalsPage /></BrowserRouter>);
    const popconfirms = screen.getAllByTestId("popconfirm");
    if (popconfirms.length > 0) {
      fireEvent.click(popconfirms[0]);
      expect(close).toHaveBeenCalledWith("p1");
    }
  });

  it("submits vote drawer", async () => {
    vote.mockResolvedValue(undefined);
    render(<BrowserRouter><ProposalsPage /></BrowserRouter>);
    const voteButtons = screen.getAllByText("投票");
    fireEvent.click(voteButtons[0]);
    expect(document.querySelector(".ant-drawer")).toBeTruthy();

    const inputs = screen.getAllByRole("textbox");
    if (inputs[0]) fireEvent.change(inputs[0], { target: { value: "a1" } });
    if (inputs[1]) fireEvent.change(inputs[1], { target: { value: "agree" } });

    const select = document.querySelector("select") as HTMLSelectElement;
    if (select) fireEvent.change(select, { target: { value: "yes" } });

    const submitBtn = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    if (submitBtn) fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(vote).toHaveBeenCalledWith("p1", "a1", true, "agree");
    });
  });
});
