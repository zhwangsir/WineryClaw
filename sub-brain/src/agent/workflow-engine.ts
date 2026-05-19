/**
 * Workflow Engine — DAG 工作流编排
 * 节点定义、依赖解析、并行执行、状态追踪
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ===== Workflow Types =====

export type WorkflowNodeType =
  | "agent"       // 委托给 Agent 执行
  | "tool"        // 调用工具
  | "llm"         // LLM 推理
  | "condition"   // 条件分支
  | "parallel"    // 并行网关
  | "join"        // 汇聚网关
  | "delay"       // 延时
  | "webhook"     // HTTP webhook
  | "memory";     // 记忆操作

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  name: string;
  description?: string;
  // Node-specific config
  config: Record<string, unknown>;
  // Agent-specific
  agentId?: string;
  // Tool-specific
  toolName?: string;
  toolParams?: Record<string, unknown>;
  // LLM-specific
  prompt?: string;
  modelConfig?: Record<string, unknown>;
  // Condition-specific
  condition?: string;
  // Delay-specific
  delayMs?: number;
  // Webhook-specific
  webhookUrl?: string;
  webhookMethod?: string;
  // Memory-specific
  memoryAction?: "store" | "search" | "recall";
  memoryParams?: Record<string, unknown>;
  // Retry config
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  // UI
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;      // condition expression for conditional edges
  label?: string;
}

export type WorkflowStatus = "draft" | "active" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables?: Record<string, { type: string; default?: unknown; description: string }>;
  createdAt: string;
  updatedAt: string;
  owner: string;
  workspaceId: string;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  nodeResults: Record<string, WorkflowNodeResult>;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface WorkflowNodeResult {
  nodeId: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
}

export type NodeExecutor = (node: WorkflowNode, context: WorkflowContext) => Promise<unknown>;

export interface WorkflowContext {
  runId: string;
  workflowId: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  nodeResults: Record<string, WorkflowNodeResult>;
  variables: Record<string, unknown>;
  signal?: AbortSignal;
}

// ===== DAG Utilities =====

function buildAdjacency(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
  }
  return adj;
}

function buildReverseAdjacency(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const n of nodes) rev.set(n.id, []);
  for (const e of edges) {
    const list = rev.get(e.to);
    if (list) list.push(e.from);
  }
  return rev;
}

function topologicalSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const adj = buildAdjacency(nodes, edges);
  const inDegree = new Map<string, number>();
  for (const n of nodes) inDegree.set(n.id, 0);
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const next of adj.get(id) || []) {
      const newDeg = (inDegree.get(next) || 0) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  if (result.length !== nodes.length) {
    throw new Error("Workflow contains cycles — cannot execute DAG with cycles");
  }
  return result;
}

function detectCycles(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  try {
    topologicalSort(nodes, edges);
    return false;
  } catch (err) { console.error("[workflow-engine] Error:", err);
    return true;
  }
}

// ===== Workflow Engine =====

const WORKFLOW_DIR = join(homedir(), ".webrain", "agents", "workflows");
const RUN_DIR = join(homedir(), ".webrain", "agents", "workflow-runs");

export class WorkflowEngine {
  private workflows = new Map<string, WorkflowDefinition>();
  private runs = new Map<string, WorkflowRun>();
  private executors = new Map<WorkflowNodeType, NodeExecutor>();
  private activeExecutions = new Map<string, AbortController>();

  constructor() {
    this.loadWorkflows();
    this.loadRuns();
    this.registerDefaultExecutors();
  }

  private loadWorkflows(): void {
    try {
      if (!existsSync(WORKFLOW_DIR)) return;
      for (const f of readdirSync(WORKFLOW_DIR)) {
        if (f.endsWith(".json")) {
          try {
            const wf: WorkflowDefinition = JSON.parse(readFileSync(join(WORKFLOW_DIR, f), "utf-8"));
            this.workflows.set(wf.id, wf);
          } catch (err) { console.error("[workflow-engine] Error:", err); console.error("[workflow] Error:", err); }
        }
      }
    } catch (err) { console.error("[workflow-engine] Error:", err);
      console.error("[workflow] Load failed:", err);
    }
  }

  private saveWorkflow(wf: WorkflowDefinition): void {
    try {
      if (!existsSync(WORKFLOW_DIR)) mkdirSync(WORKFLOW_DIR, { recursive: true });
      writeFileSync(join(WORKFLOW_DIR, `${wf.id}.json`), JSON.stringify(wf, null, 2));
    } catch (err) { console.error("[workflow-engine] Error:", err);
      console.error("[workflow] Save failed:", err);
    }
  }

  private deleteWorkflowFile(id: string): void {
    try {
      const path = join(WORKFLOW_DIR, `${id}.json`);
      if (existsSync(path)) unlinkSync(path);
    } catch (err) { console.error("[workflow-engine] Error:", err); console.error("[workflow] Error:", err); }
  }

  private loadRuns(): void {
    try {
      if (!existsSync(RUN_DIR)) return;
      for (const f of readdirSync(RUN_DIR)) {
        if (f.endsWith(".json")) {
          try {
            const run: WorkflowRun = JSON.parse(readFileSync(join(RUN_DIR, f), "utf-8"));
            this.runs.set(run.runId, run);
          } catch (err) { console.error("[workflow-engine] Error:", err); console.error("[workflow] Error:", err); }
        }
      }
    } catch (err) { console.error("[workflow-engine] Error:", err);
      console.error("[workflow] Load runs failed:", err);
    }
  }

  private saveRun(run: WorkflowRun): void {
    try {
      if (!existsSync(RUN_DIR)) mkdirSync(RUN_DIR, { recursive: true });
      writeFileSync(join(RUN_DIR, `${run.runId}.json`), JSON.stringify(run, null, 2));
    } catch (err) { console.error("[workflow-engine] Error:", err);
      console.error("[workflow] Save run failed:", err);
    }
  }

  // ---- Executor Registration ----

  registerExecutor(type: WorkflowNodeType, executor: NodeExecutor): void {
    this.executors.set(type, executor);
  }

  private registerDefaultExecutors(): void {
    // Delay executor
    this.registerExecutor("delay", async (node, ctx) => {
      const ms = (node.delayMs || 1000);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        ctx.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Workflow cancelled'));
        });
      });
      return { delayed: ms };
    });

    // Webhook executor
    this.registerExecutor("webhook", async (node) => {
      const url = node.webhookUrl;
      const method = node.webhookMethod || "POST";
      if (!url) throw new Error("Webhook URL not specified");
      const axios = (await import("axios")).default;
      const resp = await axios.request({ url, method, timeout: 30000 });
      return { status: resp.status, data: resp.data };
    });

    // Memory executor (placeholder — will be wired by agent-manager)
    this.registerExecutor("memory", async (node, ctx) => {
      return { action: node.memoryAction, params: node.memoryParams, context: ctx.runId };
    });

    // LLM executor (placeholder)
    this.registerExecutor("llm", async (node) => {
      return { prompt: node.prompt, modelConfig: node.modelConfig, status: "placeholder" };
    });

    // Condition executor
    this.registerExecutor("condition", async (node, ctx) => {
      const expr = node.condition || "true";
      // Simple expression evaluation — supports variable substitution
      let evaluated = expr;
      for (const [k, v] of Object.entries(ctx.outputs)) {
        evaluated = evaluated.replace(new RegExp(`\\b${k}\\b`, "g"), JSON.stringify(v));
      }
      for (const [k, v] of Object.entries(ctx.inputs)) {
        evaluated = evaluated.replace(new RegExp(`\\b${k}\\b`, "g"), JSON.stringify(v));
      }
      // Evaluate as boolean
      try {
        const result = new Function(`return (${evaluated})`)();
        return { condition: expr, result: !!result };
      } catch (err) { console.error("[workflow-engine] Error:", err);
        return { condition: expr, result: false, error: "Evaluation failed" };
      }
    });

    // Tool executor (placeholder)
    this.registerExecutor("tool", async (node) => {
      return { tool: node.toolName, params: node.toolParams, status: "placeholder" };
    });

    // Agent executor (placeholder)
    this.registerExecutor("agent", async (node) => {
      return { agentId: node.agentId, config: node.config, status: "placeholder" };
    });

    // Parallel / Join — these are structural, execution handled by engine
    this.registerExecutor("parallel", async () => ({ type: "parallel" }));
    this.registerExecutor("join", async () => ({ type: "join" }));
  }

  // ---- CRUD ----

  listWorkflows(workspaceId?: string): WorkflowDefinition[] {
    const all = Array.from(this.workflows.values());
    return workspaceId ? all.filter(w => w.workspaceId === workspaceId) : all;
  }

  getWorkflow(id: string): WorkflowDefinition | undefined {
    return this.workflows.get(id);
  }

  createWorkflow(def: Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">): { ok: boolean; workflow?: WorkflowDefinition; error?: string } {
    if (detectCycles(def.nodes, def.edges)) {
      return { ok: false, error: "Workflow contains cycles" };
    }
    const wf: WorkflowDefinition = {
      ...def,
      id: `wf-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.workflows.set(wf.id, wf);
    this.saveWorkflow(wf);
    return { ok: true, workflow: wf };
  }

  updateWorkflow(id: string, updates: Partial<Omit<WorkflowDefinition, "id" | "createdAt">>): { ok: boolean; workflow?: WorkflowDefinition; error?: string } {
    const wf = this.workflows.get(id);
    if (!wf) return { ok: false, error: "Workflow not found" };

    const nextNodes = updates.nodes || wf.nodes;
    const nextEdges = updates.edges || wf.edges;
    if (detectCycles(nextNodes, nextEdges)) {
      return { ok: false, error: "Update would introduce cycles" };
    }

    Object.assign(wf, updates, { updatedAt: new Date().toISOString() });
    this.saveWorkflow(wf);
    return { ok: true, workflow: wf };
  }

  deleteWorkflow(id: string): boolean {
    const wf = this.workflows.get(id);
    if (!wf) return false;
    this.deleteWorkflowFile(id);
    return this.workflows.delete(id);
  }

  validateWorkflow(id: string): { valid: boolean; errors: string[] } {
    const wf = this.workflows.get(id);
    if (!wf) return { valid: false, errors: ["Workflow not found"] };

    const errors: string[] = [];

    // Check cycles
    if (detectCycles(wf.nodes, wf.edges)) {
      errors.push("Workflow contains cycles");
    }

    // Check all edge endpoints exist
    const nodeIds = new Set(wf.nodes.map(n => n.id));
    for (const e of wf.edges) {
      if (!nodeIds.has(e.from)) errors.push(`Edge references unknown node: ${e.from}`);
      if (!nodeIds.has(e.to)) errors.push(`Edge references unknown node: ${e.to}`);
    }

    // Check start nodes (no incoming edges)
    const hasIncoming = new Set(wf.edges.map(e => e.to));
    const startNodes = wf.nodes.filter(n => !hasIncoming.has(n.id));
    if (startNodes.length === 0) errors.push("Workflow has no start node (all nodes have incoming edges)");

    // Check end nodes (no outgoing edges)
    const hasOutgoing = new Set(wf.edges.map(e => e.from));
    const endNodes = wf.nodes.filter(n => !hasOutgoing.has(n.id));
    if (endNodes.length === 0) errors.push("Workflow has no end node (all nodes have outgoing edges)");

    // Check unreachable nodes
    try {
      const sorted = topologicalSort(wf.nodes, wf.edges);
      const reachable = new Set(sorted);
      for (const n of wf.nodes) {
        if (!reachable.has(n.id)) errors.push(`Node ${n.id} is unreachable`);
      }
    } catch (err) { console.error("[workflow-engine] Error:", err);
      // Already reported
    }

    return { valid: errors.length === 0, errors };
  }

  // ---- Execution ----

  async runWorkflow(workflowId: string, inputs: Record<string, unknown> = {}): Promise<WorkflowRun> {
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new Error(`Workflow ${workflowId} not found`);

    const validation = this.validateWorkflow(workflowId);
    if (!validation.valid) {
      throw new Error(`Workflow validation failed: ${validation.errors.join(", ")}`);
    }

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const run: WorkflowRun = {
      runId,
      workflowId,
      status: "running",
      inputs,
      outputs: {},
      nodeResults: {},
      startedAt: new Date().toISOString(),
    };

    // Initialize node results
    for (const n of wf.nodes) {
      run.nodeResults[n.id] = {
        nodeId: n.id,
        status: "pending",
        attempts: 0,
      };
    }

    this.runs.set(runId, run);
    this.saveRun(run);

    const abortController = new AbortController();
    this.activeExecutions.set(runId, abortController);

    try {
      await this._executeWorkflow(wf, run, abortController.signal);
      if (run.status !== 'cancelled') {
        run.status = "completed";
      }
      run.completedAt = new Date().toISOString();
    } catch (err: any) {
      if (run.status !== 'cancelled') {
        run.status = "failed";
        run.error = String(err.message || err);
      }
      run.completedAt = new Date().toISOString();
    } finally {
      this.activeExecutions.delete(runId);
      this.saveRun(run);
    }

    return run;
  }

  private async _executeWorkflow(wf: WorkflowDefinition, run: WorkflowRun, signal: AbortSignal): Promise<void> {
    const nodeMap = new Map(wf.nodes.map(n => [n.id, n]));
    const adj = buildAdjacency(wf.nodes, wf.edges);
    const revAdj = buildReverseAdjacency(wf.nodes, wf.edges);

    // Track completed nodes
    const completed = new Set<string>();
    const failed = new Set<string>();

    // Start with nodes that have no incoming edges
    const ready: string[] = [];
    for (const n of wf.nodes) {
      const incoming = revAdj.get(n.id) || [];
      if (incoming.length === 0) ready.push(n.id);
    }

    while (ready.length > 0 || this.hasRunningNodes(run)) {
      if (signal.aborted) throw new Error("Workflow cancelled");

      // Execute all ready nodes in parallel
      const batch = ready.splice(0);
      if (batch.length === 0) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }

      await Promise.all(batch.map(async (nodeId) => {
        if (signal.aborted) return;
        const node = nodeMap.get(nodeId);
        if (!node) return;

        const result = run.nodeResults[nodeId];
        result.status = "running";
        result.startedAt = new Date().toISOString();
        result.attempts++;

        const ctx: WorkflowContext = {
          runId: run.runId,
          workflowId: run.workflowId,
          inputs: run.inputs,
          outputs: run.outputs,
          nodeResults: run.nodeResults,
          variables: wf.variables ? Object.fromEntries(Object.entries(wf.variables).map(([k, v]) => [k, v.default])) : {},
          signal,
        };

        try {
          const executor = this.executors.get(node.type);
          if (!executor) {
            throw new Error(`No executor registered for node type: ${node.type}`);
          }

          const output = await this._executeWithTimeout(executor, node, ctx, node.timeoutMs || 120000);

          result.output = output;
          result.status = "completed";
          result.completedAt = new Date().toISOString();

          // Store output for downstream consumption
          if (node.name) {
            run.outputs[node.name] = output;
          }
          run.outputs[nodeId] = output;

          completed.add(nodeId);
        } catch (err: any) {
          if (signal.aborted) {
            result.status = 'cancelled';
            result.completedAt = new Date().toISOString();
            return;
          }
          if (result.attempts <= (node.retries || 0)) {
            // Retry
            result.status = "pending";
            ready.push(nodeId);
            if (node.retryDelayMs) {
              await new Promise(r => setTimeout(r, node.retryDelayMs));
            }
            return;
          }
          result.error = String(err.message || err);
          result.status = "failed";
          result.completedAt = new Date().toISOString();
          failed.add(nodeId);
        }

        this.saveRun(run);

        // Queue downstream nodes if all dependencies are completed
        for (const nextId of adj.get(nodeId) || []) {
          const deps = revAdj.get(nextId) || [];
          const allDepsDone = deps.every(d => completed.has(d) || failed.has(d));
          const anyDepFailed = deps.some(d => failed.has(d));
          const nextNode = nodeMap.get(nextId);

          if (allDepsDone && !completed.has(nextId) && !failed.has(nextId)) {
            // Check conditional edge
            const edge = wf.edges.find(e => e.from === nodeId && e.to === nextId);
            if (edge?.condition) {
              const conditionResult = this._evaluateCondition(edge.condition, run.outputs, run.inputs);
              if (!conditionResult) {
                // Skip this node
                run.nodeResults[nextId].status = "skipped";
                completed.add(nextId);
                continue;
              }
            }

            // For join nodes, wait until all parallel branches complete
            if (nextNode?.type === "join") {
              const joinDeps = revAdj.get(nextId) || [];
              const allJoinDepsDone = joinDeps.every(d => completed.has(d));
              if (!allJoinDepsDone) continue;
            }

            ready.push(nextId);
          }
        }
      }));
    }

    if (failed.size > 0) {
      throw new Error(`Workflow failed at nodes: ${Array.from(failed).join(", ")}`);
    }
  }

  private hasRunningNodes(run: WorkflowRun): boolean {
    return Object.values(run.nodeResults).some(r => r.status === "running");
  }

  private async _executeWithTimeout(
    executor: NodeExecutor,
    node: WorkflowNode,
    ctx: WorkflowContext,
    timeoutMs: number
  ): Promise<unknown> {
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Node ${node.id} timed out after ${timeoutMs}ms`)), timeoutMs);
      try {
        const result = await executor(node, ctx);
        clearTimeout(timer);
        resolve(result);
      } catch (err) { console.error("[workflow-engine] Error:", err);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  private _evaluateCondition(expr: string, outputs: Record<string, unknown>, inputs?: Record<string, unknown>): boolean {
    try {
      let evaluated = expr;
      // Replace outputs.xxx and inputs.xxx patterns first
      for (const [k, v] of Object.entries(outputs)) {
        evaluated = evaluated.replace(new RegExp(`outputs\\.${k}`, "g"), JSON.stringify(v));
      }
      if (inputs) {
        for (const [k, v] of Object.entries(inputs)) {
          evaluated = evaluated.replace(new RegExp(`inputs\\.${k}`, "g"), JSON.stringify(v));
        }
      }
      return !!new Function(`return (${evaluated})`)();
    } catch (err) { console.error("[workflow-engine] Error:", err);
      return false;
    }
  }

  cancelRun(runId: string): boolean {
    const controller = this.activeExecutions.get(runId);
    if (!controller) return false;
    controller.abort();
    const run = this.runs.get(runId);
    if (run) {
      run.status = "cancelled";
      run.completedAt = new Date().toISOString();
      this.saveRun(run);
    }
    this.activeExecutions.delete(runId);
    return true;
  }

  getRun(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  listRuns(workflowId?: string, status?: WorkflowRun["status"]): WorkflowRun[] {
    let all = Array.from(this.runs.values());
    if (workflowId) all = all.filter(r => r.workflowId === workflowId);
    if (status) all = all.filter(r => r.status === status);
    return all.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  }

  getStats(): { totalWorkflows: number; totalRuns: number; activeRuns: number; completedRuns: number; failedRuns: number } {
    const runs = Array.from(this.runs.values());
    return {
      totalWorkflows: this.workflows.size,
      totalRuns: runs.length,
      activeRuns: runs.filter(r => r.status === "running").length,
      completedRuns: runs.filter(r => r.status === "completed").length,
      failedRuns: runs.filter(r => r.status === "failed").length,
    };
  }
}
