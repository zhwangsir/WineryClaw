import { create } from "zustand";
import { message } from "antd";
import { workflowsApi } from "../api/workflows";
import type { WorkflowDef, WorkflowRun } from "../api/types";

interface WorkflowState {
  workflows: WorkflowDef[];
  runs: WorkflowRun[];
  loading: boolean;
  error: Error | null;

  fetchWorkflows: () => Promise<void>;
  createWorkflow: (data: Partial<WorkflowDef>) => Promise<void>;
  updateWorkflow: (id: string, data: Partial<WorkflowDef>) => Promise<void>;
  deleteWorkflow: (id: string) => Promise<void>;
  runWorkflow: (id: string, inputs?: Record<string, unknown>) => Promise<void>;
  fetchRuns: (id: string, status?: string) => Promise<void>;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  workflows: [],
  runs: [],
  loading: false,
  error: null,

  fetchWorkflows: async () => {
    set({ loading: true, error: null });
    try {
      const workflows = await workflowsApi.list();
      set({ workflows, loading: false });
    } catch (e: any) {
      set({ error: e, loading: false });
      message.error(e.message || "获取工作流失败");
    }
  },

  createWorkflow: async (data) => {
    try {
      await workflowsApi.create(data);
      message.success("工作流创建成功");
      await get().fetchWorkflows();
    } catch (e: any) {
      message.error(e.message || "创建工作流失败");
    }
  },

  updateWorkflow: async (id, data) => {
    try {
      await workflowsApi.update(id, data);
      message.success("工作流更新成功");
      await get().fetchWorkflows();
    } catch (e: any) {
      message.error(e.message || "更新工作流失败");
    }
  },

  deleteWorkflow: async (id) => {
    try {
      await workflowsApi.delete(id);
      message.success("工作流已删除");
      await get().fetchWorkflows();
    } catch (e: any) {
      message.error(e.message || "删除工作流失败");
    }
  },

  runWorkflow: async (id, inputs) => {
    try {
      const run = await workflowsApi.run(id, inputs);
      message.success(`工作流已启动 (Run: ${run.runId})`);
      await get().fetchRuns(id);
    } catch (e: any) {
      message.error(e.message || "启动工作流失败");
    }
  },

  fetchRuns: async (id, status) => {
    try {
      const runs = await workflowsApi.runs(id, status);
      set({ runs });
    } catch (e: any) {
      message.error(e.message || "获取运行记录失败");
    }
  },
}));
