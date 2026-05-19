import { create } from "zustand";
import { message } from "antd";
import { proposalsApi } from "../api/proposals";
import type { Proposal } from "../api/proposals";

interface ProposalState {
  proposals: Proposal[];
  loading: boolean;

  fetchProposals: (status?: string) => Promise<void>;
  createProposal: (data: { proposerId: string; topic: string; description: string; quorum?: number; timeoutSec?: number }) => Promise<void>;
  vote: (id: string, agentId: string, vote: boolean, reason?: string) => Promise<void>;
  close: (id: string) => Promise<void>;
}

export const useProposalStore = create<ProposalState>((set, get) => ({
  proposals: [],
  loading: false,

  fetchProposals: async (status) => {
    set({ loading: true });
    try {
      const proposals = await proposalsApi.list(status);
      set({ proposals, loading: false });
    } catch (e: any) {
      set({ loading: false });
      message.error(e.message || "获取提案失败");
    }
  },

  createProposal: async (data) => {
    try {
      await proposalsApi.create(data);
      message.success("提案创建成功");
      await get().fetchProposals();
    } catch (e: any) {
      message.error(e.message || "创建提案失败");
    }
  },

  vote: async (id, agentId, vote, reason) => {
    try {
      await proposalsApi.vote(id, agentId, vote, reason);
      message.success("投票成功");
      await get().fetchProposals();
    } catch (e: any) {
      message.error(e.message || "投票失败");
    }
  },

  close: async (id) => {
    try {
      await proposalsApi.close(id);
      message.success("提案已关闭");
      await get().fetchProposals();
    } catch (e: any) {
      message.error(e.message || "关闭提案失败");
    }
  },
}));
