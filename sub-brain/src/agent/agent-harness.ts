/**
 * Agent Harness — 自主决策循环 + 运行时计划引擎
 *
 * 核心概念:
 * - Plan: 将任务分解为有序的 Step
 * - Step: 单个执行单元 (llm_call | tool_call | subagent_call | memory_read | memory_write | wait)
 * - Loop: observe → plan → execute → observe → ... → done
 * - State Machine: idle → planning → executing → observing → (done | replanning)
 */

import type { AgentCard, AgentTask } from "./agent-manager";

export type StepType =
  | "llm_call"
  | "tool_call"
  | "subagent_call"
  | "memory_read"
  | "memory_write"
  | "wait"
  | "done";

export interface PlanStep {
  stepId: string;
  type: StepType;
  description: string;
  params: Record<string, unknown>;
  dependsOn?: string[];
  timeoutMs?: number;
}

export interface RuntimePlan {
  planId: string;
  taskId: string;
  agentId: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: "planning" | "executing" | "paused" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface StepResult {
  stepId: string;
  status: "success" | "error" | "timeout" | "skipped";
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface HarnessState {
  agentId: string;
  status: "idle" | "planning" | "executing" | "observing" | "done" | "error";
  currentPlan?: RuntimePlan;
  stepResults: StepResult[];
  context: Record<string, unknown>;
  lastError?: string;
}

export interface HarnessOptions {
  mainBrainUrl: string;
  subBrainUrl: string;
  maxStepsPerPlan: number;
  maxReplanCount: number;
  defaultStepTimeoutMs: number;
  enableAutoReplan: boolean;
}

export interface SubagentBinding {
  subagentId: string;
  role: string;
  capabilities: string[];
  bindingId: string;
}

export class AgentHarness {
  private state: HarnessState;
  private options: HarnessOptions;
  private subagents: Map<string, SubagentBinding> = new Map();
  private replanCount = 0;
  private abortController: AbortController | null = null;

  constructor(agent: AgentCard, options: Partial<HarnessOptions> = {}) {
    this.options = {
      mainBrainUrl: options.mainBrainUrl || "http://127.0.0.1:18790",
      subBrainUrl: options.subBrainUrl || "http://127.0.0.1:9797",
      maxStepsPerPlan: options.maxStepsPerPlan || 20,
      maxReplanCount: options.maxReplanCount || 3,
      defaultStepTimeoutMs: options.defaultStepTimeoutMs || 30000,
      enableAutoReplan: options.enableAutoReplan !== false,
    };
    this.state = {
      agentId: agent.id,
      status: "idle",
      stepResults: [],
      context: {},
    };
  }

  // ─── Subagent Binding ───────────────────────────────────────────

  bindSubagent(binding: Omit<SubagentBinding, "bindingId">): SubagentBinding {
    const full: SubagentBinding = {
      ...binding,
      bindingId: `bind-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    };
    this.subagents.set(full.bindingId, full);
    return full;
  }

  unbindSubagent(bindingId: string): boolean {
    return this.subagents.delete(bindingId);
  }

  listSubagents(): SubagentBinding[] {
    return Array.from(this.subagents.values());
  }

  // ─── Core Decision Loop ─────────────────────────────────────────

  async run(task: AgentTask, agent: AgentCard): Promise<void> {
    if (this.state.status === "executing" || this.state.status === "planning") {
      throw new Error(`Harness for agent ${agent.id} is already running`);
    }

    this.abortController = new AbortController();
    this.replanCount = 0;
    this.state.stepResults = [];
    this.state.lastError = undefined;

    try {
      // Phase 1: Create initial plan
      this.state.status = "planning";
      const plan = await this._createPlan(task, agent);
      this.state.currentPlan = plan;

      // Phase 2: Execute loop
      while (plan.status === "executing" || plan.status === "planning") {
        if (this.abortController.signal.aborted) {
          plan.status = "paused";
          break;
        }

        // Execute current step
        this.state.status = "executing";
        const step = plan.steps[plan.currentStepIndex];
        if (!step) {
          plan.status = "completed";
          break;
        }

        const result = await this._executeStep(step, task, agent);
        this.state.stepResults.push(result);

        // Observe and decide next action
        this.state.status = "observing";
        const shouldContinue = await this._observeAndDecide(plan, result, agent);

        if (!shouldContinue) {
          const pStatus = plan.status as string;
          if (pStatus !== "completed" && pStatus !== "failed") {
            plan.status = "completed";
          }
          break;
        }

        // Check if we need replanning
        if (result.status === "error" && this.options.enableAutoReplan && this.replanCount < this.options.maxReplanCount) {
          this.replanCount++;
          this.state.status = "planning";
          const newPlan = await this._replan(plan, result, agent);
          this.state.currentPlan = newPlan;
          continue;
        }

        // Move to next step
        plan.currentStepIndex++;
        if (plan.currentStepIndex >= plan.steps.length) {
          plan.status = "completed";
        }

        plan.updatedAt = new Date().toISOString();
      }

      this.state.status = plan.status === "completed" ? "done" : plan.status === "failed" ? "error" : "idle";
    } catch (err: any) {
      this.state.status = "error";
      this.state.lastError = String(err.message || err);
      if (this.state.currentPlan) {
        this.state.currentPlan.status = "failed";
      }
    }
  }

  pause(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.state.currentPlan) {
      this.state.currentPlan.status = "paused";
    }
    this.state.status = "idle";
  }

  getState(): HarnessState {
    return { ...this.state };
  }

  // ─── Plan Generation ────────────────────────────────────────────

  private async _createPlan(task: AgentTask, agent: AgentCard): Promise<RuntimePlan> {
    const planId = `plan-${Date.now()}`;

    // Build system prompt for planning
    const systemPrompt = this._buildPlannerPrompt(agent);
    const userPrompt = this._buildTaskPrompt(task);

    // Ask LLM to generate plan
    const planResponse = await this._callLLM(systemPrompt, userPrompt, agent);
    const rawPlan = this._extractPlanFromLLMResponse(planResponse);

    const plan: RuntimePlan = {
      planId,
      taskId: task.taskId,
      agentId: agent.id,
      steps: this._normalizeSteps(rawPlan, planId),
      currentStepIndex: 0,
      status: "executing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return plan;
  }

  private async _replan(currentPlan: RuntimePlan, failedResult: StepResult, agent: AgentCard): Promise<RuntimePlan> {
    const systemPrompt = this._buildReplanPrompt(agent);
    const history = this.state.stepResults.map(r =>
      `- Step ${r.stepId}: ${r.status}${r.error ? ` (error: ${r.error})` : ''}`
    ).join("\n");
    const userPrompt = `The following step failed:\nStep: ${failedResult.stepId}\nError: ${failedResult.error || "Unknown error"}\n\nExecution history:\n${history}\n\nPlease provide a new plan to recover from this error and complete the task.`;

    const planResponse = await this._callLLM(systemPrompt, userPrompt, agent);
    const rawPlan = this._extractPlanFromLLMResponse(planResponse);

    const newPlan: RuntimePlan = {
      planId: `plan-${Date.now()}-replan`,
      taskId: currentPlan.taskId,
      agentId: agent.id,
      steps: this._normalizeSteps(rawPlan, currentPlan.planId),
      currentStepIndex: 0,
      status: "executing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return newPlan;
  }

  private _buildPlannerPrompt(agent: AgentCard): string {
    const caps = agent.capabilities.join(", ");
    const tools = agent.tools.join(", ");
    const subagents = this.listSubagents().map(s => `${s.subagentId}(${s.role})`).join(", ");

    return `You are an AI planning engine for an autonomous agent. Given a task, break it down into a sequence of executable steps.

Available step types:
- llm_call: Call the language model for reasoning or generation
- tool_call: Execute a tool (e.g., shell, file_read, http_request)
- subagent_call: Delegate to a subagent
- memory_read: Read from memory store
- memory_write: Write to memory store
- wait: Pause for external input
- done: Mark task as complete

Agent capabilities: ${caps}
Available tools: ${tools}
${subagents ? `Available subagents: ${subagents}` : ""}

Rules:
1. Maximum ${this.options.maxStepsPerPlan} steps
2. Each step must have a clear description and params
3. Use "dependsOn" to specify step dependencies
4. End with a "done" step

Respond with a JSON array of steps like:
[
  {"type": "llm_call", "description": "Analyze the request", "params": {"prompt": "..."}},
  {"type": "tool_call", "description": "Execute search", "params": {"tool": "http_request", "params": {"url": "..."}}},
  {"type": "done", "description": "Task complete", "params": {}}
]`;
  }

  private _buildReplanPrompt(agent: AgentCard): string {
    return `You are a recovery planner. A step in the current plan failed. Review the error and execution history, then provide a new plan to recover and complete the task.

Rules:
1. Consider alternative approaches
2. Skip steps that are already completed successfully
3. Add verification steps after recovery
4. Maximum ${this.options.maxStepsPerPlan} steps

Respond with a JSON array of steps.`;
  }

  private _buildTaskPrompt(task: AgentTask): string {
    return `Task type: ${task.type}\nPayload: ${JSON.stringify(task.payload, null, 2)}\nContext ID: ${task.contextId}\n\nGenerate a step-by-step plan to complete this task.`;
  }

  private _extractPlanFromLLMResponse(response: unknown): Array<Partial<PlanStep>> {
    try {
      if (typeof response === "string") {
        // Try to extract JSON from markdown code blocks
        const match = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) {
          return JSON.parse(match[1]);
        }
        return JSON.parse(response);
      }
      if (Array.isArray(response)) return response as Array<Partial<PlanStep>>;
      if (typeof response === "object" && response !== null) {
        const obj = response as Record<string, unknown>;
        if (Array.isArray(obj.steps)) return obj.steps as Array<Partial<PlanStep>>;
        if (Array.isArray(obj.plan)) return obj.plan as Array<Partial<PlanStep>>;
      }
      return [];
    } catch (err) { console.error("[agent-harness] Error:", err);
      return [];
    }
  }

  private _normalizeSteps(raw: Array<Partial<PlanStep>>, planId: string): PlanStep[] {
    return raw
      .filter(s => s.type)
      .slice(0, this.options.maxStepsPerPlan)
      .map((s, i) => ({
        stepId: s.stepId || `${planId}-step-${i}`,
        type: s.type as StepType,
        description: s.description || `${s.type} step`,
        params: s.params || {},
        dependsOn: s.dependsOn,
        timeoutMs: s.timeoutMs || this.options.defaultStepTimeoutMs,
      }));
  }

  // ─── Step Execution ─────────────────────────────────────────────

  private async _executeStep(step: PlanStep, task: AgentTask, agent: AgentCard): Promise<StepResult> {
    const startedAt = new Date().toISOString();
    const resultBase: Partial<StepResult> = {
      stepId: step.stepId,
      startedAt,
    };

    try {
      let output: unknown;

      switch (step.type) {
        case "llm_call": {
          const prompt = String(step.params.prompt || step.params.message || "");
          const system = String(step.params.system || "");
          output = await this._callLLM(system, prompt, agent);
          break;
        }

        case "tool_call": {
          const toolName = String(step.params.tool || "");
          const toolParams = (step.params.params || step.params.arguments || {}) as Record<string, unknown>;
          output = await this._callTool(toolName, toolParams);
          break;
        }

        case "subagent_call": {
          const subagentId = String(step.params.subagentId || "");
          const subTask = step.params.task as Record<string, unknown> || {};
          output = await this._callSubagent(subagentId, subTask, agent);
          break;
        }

        case "memory_read": {
          const query = String(step.params.query || "");
          const topK = Number(step.params.top_k || 5);
          output = await this._callMemory("read", { query, top_k: topK });
          break;
        }

        case "memory_write": {
          const level = String(step.params.level || "l2");
          const content = String(step.params.content || "");
          output = await this._callMemory("write", { level, content, tags: step.params.tags || [] });
          break;
        }

        case "wait": {
          const duration = Number(step.params.duration || 1000);
          await new Promise(r => setTimeout(r, Math.min(duration, 30000)));
          output = { waited: duration };
          break;
        }

        case "done": {
          output = { completed: true };
          break;
        }

        default: {
          throw new Error(`Unknown step type: ${step.type}`);
        }
      }

      return {
        ...resultBase,
        status: "success",
        output,
        completedAt: new Date().toISOString(),
      } as StepResult;
    } catch (err: any) {
      return {
        ...resultBase,
        status: "error",
        error: String(err.message || err),
        completedAt: new Date().toISOString(),
      } as StepResult;
    }
  }

  private async _observeAndDecide(plan: RuntimePlan, lastResult: StepResult, agent: AgentCard): Promise<boolean> {
    // If step failed critically, check if we should stop
    if (lastResult.status === "error") {
      const isCritical = this._isCriticalError(lastResult.error || "");
      if (isCritical || this.replanCount >= this.options.maxReplanCount) {
        plan.status = "failed";
        return false;
      }
      // Non-critical errors allow replanning in the main loop
      return true;
    }

    // If last step was "done", stop
    const currentStep = plan.steps[plan.currentStepIndex];
    if (currentStep?.type === "done") {
      plan.status = "completed";
      return false;
    }

    return true;
  }

  private _isCriticalError(error: string): boolean {
    const criticalPatterns = [
      "authentication failed",
      "unauthorized",
      "forbidden",
      "not found",
      "connection refused",
      "network error",
      "timeout",
    ];
    const lower = error.toLowerCase();
    return criticalPatterns.some(p => lower.includes(p));
  }

  // ─── External Calls ─────────────────────────────────────────────

  private _mainBrainAxiosConfig(): any {
    const uds = process.env.WEBRAIN_MAIN_BRAIN_UDS || "/tmp/webrain-main.sock";
    const useUds = !process.env.WEBRAIN_MAIN_BRAIN_UDS && !process.env.WEBRAIN_MAIN_BRAIN_PORT;
    return useUds ? { socketPath: uds } : {};
  }

  private async _callLLM(system: string, user: string, agent: AgentCard): Promise<unknown> {
    const axios = (await import("axios")).default;
    const url = `${this.options.mainBrainUrl}/chat`;
    const resp = await axios.post(
      url,
      {
        message: user,
        system,
        session_id: `harness-${agent.id}`,
        model_config: agent.modelConfig,
      },
      { timeout: 120000, signal: this.abortController?.signal, ...this._mainBrainAxiosConfig() },
    );
    return resp.data;
  }

  private async _callTool(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    const axios = (await import("axios")).default;
    const url = `${this.options.subBrainUrl}/api/tools/execute`;
    const resp = await axios.post(
      url,
      { tool: toolName, params },
      { timeout: 60000, signal: this.abortController?.signal },
    );
    return resp.data;
  }

  private async _callSubagent(subagentId: string, task: Record<string, unknown>, agent: AgentCard): Promise<unknown> {
    // Find binding
    const binding = Array.from(this.subagents.values()).find(b => b.subagentId === subagentId);
    if (!binding) {
      throw new Error(`Subagent ${subagentId} not bound to harness`);
    }

    // Delegate via sub-brain agent manager
    const axios = (await import("axios")).default;
    const url = `${this.options.subBrainUrl}/api/agents/delegate`;
    const resp = await axios.post(
      url,
      {
        from_agent_id: agent.id,
        to_agent_id: subagentId,
        type: task.type || "chat",
        payload: task,
      },
      { timeout: 120000, signal: this.abortController?.signal },
    );
    return resp.data;
  }

  private async _callMemory(action: "read" | "write", params: Record<string, unknown>): Promise<unknown> {
    const axios = (await import("axios")).default;
    const path = action === "read" ? "/memory/search" : "/memory";
    const url = `${this.options.mainBrainUrl}${path}`;
    const resp = await axios.post(url, params, { timeout: 30000, ...this._mainBrainAxiosConfig() });
    return resp.data;
  }
}
