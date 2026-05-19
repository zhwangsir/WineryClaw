import { create } from "zustand";
import { message } from "antd";
import { agentsApi } from "../api/agents";
import { StorageAdapter } from "../utils/storage";
import type { Agent, AgentToolConfig } from "../api/types";

const CURRENT_AGENT_KEY = "webrain-current-agent-id";

interface AgentState {
  agents: Agent[];
  loading: boolean;
  error: Error | null;
  selectedAgent: Agent | null;
  currentAgentId: string;

  fetchAgents: () => Promise<void>;
  selectAgent: (id: string) => void;
  createAgent: (data: Partial<Agent>) => Promise<Agent | undefined>;
  updateAgent: (id: string, data: Partial<Agent>) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  runAgent: (id: string, input: string) => Promise<string>;
  getSystemPrompt: (id: string) => Promise<string>;
  updateSystemPrompt: (id: string, content: string) => Promise<void>;
  getTools: (id: string) => Promise<AgentToolConfig[]>;
  updateTools: (id: string, tools: AgentToolConfig[]) => Promise<void>;
}

function getStoredAgentId(): string | null {
  return StorageAdapter.get<string | null>(CURRENT_AGENT_KEY, null);
}

function setStoredAgentId(id: string | null) {
  if (id) StorageAdapter.set(CURRENT_AGENT_KEY, id);
  else StorageAdapter.remove(CURRENT_AGENT_KEY);
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  loading: false,
  error: null,
  selectedAgent: null,
  currentAgentId: getStoredAgentId() || "agent-default",

  fetchAgents: async () => {
    if (get().loading) return;

    set({ loading: true, error: null });
    try {
      const list = await agentsApi.list();
      const agents = Array.isArray(list) ? list : [];
      set({ agents, loading: false, error: null });

      // Validate currentAgentId against fetched list
      const { currentAgentId } = get();
      if (!agents.find((a) => a.id === currentAgentId) && agents.length > 0) {
        const defaultAgent = agents.find((a) => a.isDefault) || agents[0];
        set({ currentAgentId: defaultAgent.id });
        setStoredAgentId(defaultAgent.id);
      }
    } catch (e: any) {
      message.error(e.message || "获取智能体失败");
      set({ loading: false, error: e });
    }
  },

  selectAgent: (id) => {
    const agent = get().agents.find((a) => a.id === id) || null;
    set({ selectedAgent: agent, currentAgentId: id });
    setStoredAgentId(id);
  },

  createAgent: async (data) => {
    set({ loading: true, error: null });
    try {
      const agent = await agentsApi.create(data);
      set((s) => ({ agents: [...s.agents, agent], loading: false, error: null }));
      message.success("智能体已创建");
      return agent;
    } catch (e: any) {
      message.error(e.message || "创建智能体失败");
      set({ loading: false, error: e });
      return undefined;
    }
  },

  updateAgent: async (id, data) => {
    set({ loading: true, error: null });
    try {
      const agent = await agentsApi.update(id, data);
      set((s) => ({
        agents: s.agents.map((a) => (a.id === id ? agent : a)),
        selectedAgent: s.selectedAgent?.id === id ? agent : s.selectedAgent,
        loading: false,
        error: null,
      }));
      message.success("智能体已更新");
    } catch (e: any) {
      message.error(e.message || "更新智能体失败");
      set({ loading: false, error: e });
    }
  },

  deleteAgent: async (id) => {
    try {
      await agentsApi.delete(id);
      set((s) => {
        const remaining = s.agents.filter((a) => a.id !== id);
        let currentId = s.currentAgentId;
        if (currentId === id && remaining.length > 0) {
          currentId = remaining[0].id;
          setStoredAgentId(currentId);
        }
        return {
          agents: remaining,
          selectedAgent: s.selectedAgent?.id === id ? null : s.selectedAgent,
          currentAgentId: currentId,
        };
      });
      message.success("智能体已删除");
    } catch (e: any) {
      message.error(e.message || "删除智能体失败");
    }
  },

  runAgent: async (id, input) => {
    try {
      const res = await agentsApi.run(id, input);
      return res.result;
    } catch (e: any) {
      message.error(e.message || "运行智能体失败");
      return "";
    }
  },

  getSystemPrompt: async (id) => {
    try {
      return await agentsApi.getSystemPrompt(id);
    } catch (e: any) {
      message.error(e.message || "获取系统提示词失败");
      return "";
    }
  },

  updateSystemPrompt: async (id, content) => {
    try {
      await agentsApi.updateSystemPrompt(id, content);
      message.success("系统提示词已更新");
    } catch (e: any) {
      message.error(e.message || "更新系统提示词失败");
    }
  },

  getTools: async (id) => {
    try {
      return await agentsApi.getTools(id);
    } catch (e: any) {
      message.error(e.message || "获取工具配置失败");
      return [];
    }
  },

  updateTools: async (id, tools) => {
    try {
      await agentsApi.updateTools(id, tools);
      message.success("工具配置已更新");
    } catch (e: any) {
      message.error(e.message || "更新工具配置失败");
    }
  },
}));
