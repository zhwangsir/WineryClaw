import { describe, it, expect, vi, beforeEach } from "vitest";
import { useProposalStore } from "./proposalStore";

vi.mock("../api/proposals", () => ({
  proposalsApi: {
    list: vi.fn(),
    create: vi.fn(),
    vote: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { proposalsApi } from "../api/proposals";
import { message } from "antd";

describe("proposalStore", () => {
  beforeEach(() => {
    useProposalStore.setState({ proposals: [], loading: false });
    vi.clearAllMocks();
  });

  it("has correct initial state", () => {
    const state = useProposalStore.getState();
    expect(state.proposals).toEqual([]);
    expect(state.loading).toBe(false);
  });

  it("fetchProposals loads proposals", async () => {
    vi.mocked(proposalsApi.list).mockResolvedValue([{ id: "p1" }]);
    await useProposalStore.getState().fetchProposals();
    expect(useProposalStore.getState().proposals).toHaveLength(1);
    expect(useProposalStore.getState().loading).toBe(false);
  });

  it("fetchProposals with status filter", async () => {
    vi.mocked(proposalsApi.list).mockResolvedValue([]);
    await useProposalStore.getState().fetchProposals("open");
    expect(proposalsApi.list).toHaveBeenCalledWith("open");
  });

  it("fetchProposals handles errors", async () => {
    vi.mocked(proposalsApi.list).mockRejectedValue(new Error("fail"));
    await useProposalStore.getState().fetchProposals();
    expect(useProposalStore.getState().loading).toBe(false);
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("fetchProposals handles error without message", async () => {
    vi.mocked(proposalsApi.list).mockRejectedValue(new Error(""));
    await useProposalStore.getState().fetchProposals();
    expect(message.error).toHaveBeenCalledWith("获取提案失败");
  });

  it("createProposal succeeds and refetches", async () => {
    vi.mocked(proposalsApi.create).mockResolvedValue(undefined);
    vi.mocked(proposalsApi.list).mockResolvedValue([]);
    await useProposalStore.getState().createProposal({ proposerId: "a1", topic: "Test", description: "Desc" });
    expect(message.success).toHaveBeenCalledWith("提案创建成功");
  });

  it("createProposal handles errors", async () => {
    vi.mocked(proposalsApi.create).mockRejectedValue(new Error("fail"));
    await useProposalStore.getState().createProposal({ proposerId: "", topic: "", description: "" });
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("createProposal handles error without message", async () => {
    vi.mocked(proposalsApi.create).mockRejectedValue(new Error(""));
    await useProposalStore.getState().createProposal({ proposerId: "", topic: "", description: "" });
    expect(message.error).toHaveBeenCalledWith("创建提案失败");
  });

  it("vote succeeds and refetches", async () => {
    vi.mocked(proposalsApi.vote).mockResolvedValue(undefined);
    vi.mocked(proposalsApi.list).mockResolvedValue([]);
    await useProposalStore.getState().vote("p1", "a1", true, "agree");
    expect(message.success).toHaveBeenCalledWith("投票成功");
  });

  it("vote handles errors", async () => {
    vi.mocked(proposalsApi.vote).mockRejectedValue(new Error("fail"));
    await useProposalStore.getState().vote("p1", "a1", false);
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("vote handles error without message", async () => {
    vi.mocked(proposalsApi.vote).mockRejectedValue(new Error(""));
    await useProposalStore.getState().vote("p1", "a1", false);
    expect(message.error).toHaveBeenCalledWith("投票失败");
  });

  it("close succeeds and refetches", async () => {
    vi.mocked(proposalsApi.close).mockResolvedValue(undefined);
    vi.mocked(proposalsApi.list).mockResolvedValue([]);
    await useProposalStore.getState().close("p1");
    expect(message.success).toHaveBeenCalledWith("提案已关闭");
  });

  it("close handles errors", async () => {
    vi.mocked(proposalsApi.close).mockRejectedValue(new Error("fail"));
    await useProposalStore.getState().close("p1");
    expect(message.error).toHaveBeenCalledWith("fail");
  });

  it("close handles error without message", async () => {
    vi.mocked(proposalsApi.close).mockRejectedValue(new Error(""));
    await useProposalStore.getState().close("p1");
    expect(message.error).toHaveBeenCalledWith("关闭提案失败");
  });
});
