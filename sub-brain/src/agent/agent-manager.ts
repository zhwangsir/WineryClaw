/**
 * Agent Manager — 多 Agent 系统 + 协作 + 模板 + 工作流 + 沙箱
 * Agent 创建、隔离路由、跨 Agent 协作、Agent Card、Task 生命周期
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { AgentHarness } from "./agent-harness.js";
import {
  AgentCollaborationEngine,
  A2AMessage,
  A2AMessageType,
  ConsensusProposal,
  AgentConversation,
  CollaborationStats,
} from "./collaboration-engine.js";
import { AgentTemplateEngine, AgentTemplate, TemplateInstanceOptions } from "./template-engine.js";
import {
  WorkflowEngine,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowNode,
  WorkflowEdge,
  NodeExecutor,
  WorkflowContext,
} from "./workflow-engine.js";
import { AgentSandbox, SandboxPolicy, SandboxSession, SandboxAuditLog } from "./agent-sandbox.js";
import { AgentFileSystem, AGENTS_DIR } from "./agent-filesystem.js";

export interface AgentCard {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  modelConfig: Record<string, unknown>;
  tools: string[];
  channels: string[];
  owner: string;
  workspaceId: string;
  status: "idle" | "running" | "error";
  harnessEnabled?: boolean;
  // Phase 2 extensions
  role?: string;
  systemPrompt?: string;
  maxSteps?: number;
  toolPermissions?: { allow?: string[]; deny?: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface AgentTask {
  taskId: string;
  agentId: string;
  type: string;
  payload: Record<string, unknown>;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  result?: unknown;
  error?: string;
  contextId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskExecutionOptions {
  mainBrainUrl?: string;
  subBrainUrl?: string;
}

const AGENT_DIR = join(homedir(), ".webrain", "agents");
const TASKS_PATH = join(AGENT_DIR, "tasks.json");
const AGENTS_JSON_LEGACY = join(AGENT_DIR, "agents.json");

export class AgentManager {
  private agents = new Map<string, AgentCard>();
  private tasks = new Map<string, AgentTask>();
  private activeTimers = new Map<string, NodeJS.Timeout>();
  private harnesses = new Map<string, AgentHarness>();
  private options: TaskExecutionOptions;
  private fs: AgentFileSystem;

  // Phase 2 engines
  collaboration: AgentCollaborationEngine;
  templates: AgentTemplateEngine;
  workflows: WorkflowEngine;
  sandbox: AgentSandbox;

  constructor(options: TaskExecutionOptions = {}) {
    this.options = {
      mainBrainUrl: options.mainBrainUrl || "http://127.0.0.1:18790",
      subBrainUrl: options.subBrainUrl || "http://127.0.0.1:9797",
    };

    // Initialize file system
    this.fs = new AgentFileSystem();

    // Initialize engines
    this.collaboration = new AgentCollaborationEngine((id) => this.agents.get(id));
    this.templates = new AgentTemplateEngine();
    this.workflows = new WorkflowEngine();
    this.sandbox = new AgentSandbox();

    // Wire workflow executors to real implementations
    this._wireWorkflowExecutors();

    this.load();
    if (this.agents.size === 0) {
      this.createDefaultAgent();
    }
  }

  private _wireWorkflowExecutors(): void {
    // Wire tool executor to real sub-brain tools
    this.workflows.registerExecutor("tool", async (node, ctx) => {
      const toolName = node.toolName;
      const toolParams = { ...node.toolParams };
      // Substitute context variables
      for (const [k, v] of Object.entries(ctx.outputs)) {
        for (const [pk, pv] of Object.entries(toolParams)) {
          if (typeof pv === "string" && pv.includes(`{{${k}}}`)) {
            toolParams[pk] = pv.replace(new RegExp(`{{${k}}}`, "g"), JSON.stringify(v));
          }
        }
      }
      const axios = (await import("axios")).default;
      const resp = await axios.post(`${this.options.subBrainUrl}/api/tools/execute`, {
        tool: toolName,
        params: toolParams,
      }, { timeout: 60000 });
      return resp.data;
    });

    // Wire agent executor to delegate to agent
    this.workflows.registerExecutor("agent", async (node, ctx) => {
      const agentId = node.agentId;
      if (!agentId) throw new Error("Agent node missing agentId");
      const agent = this.agents.get(agentId);
      if (!agent) throw new Error(`Agent ${agentId} not found`);

      // Create a task for this agent
      const task = this.createTask(agentId, node.config["taskType"] as string || "custom", {
        ...node.config,
        workflowContext: ctx,
      }, ctx.runId);
      this.startTask(task.taskId);

      // Wait for task completion with timeout
      const result = await this._waitForTask(task.taskId, 120000);
      return result;
    });

    // Wire LLM executor to main brain
    this.workflows.registerExecutor("llm", async (node, ctx) => {
      const prompt = node.prompt || "";
      // Substitute variables
      let resolvedPrompt = prompt;
      for (const [k, v] of Object.entries(ctx.outputs)) {
        resolvedPrompt = resolvedPrompt.replace(new RegExp(`{{${k}}}`, "g"), JSON.stringify(v));
      }
      for (const [k, v] of Object.entries(ctx.inputs)) {
        resolvedPrompt = resolvedPrompt.replace(new RegExp(`{{${k}}}`, "g"), JSON.stringify(v));
      }

      const axios = (await import("axios")).default;
      const resp = await axios.post(`${this.options.mainBrainUrl}/reasoning/analyze`, {
        prompt: resolvedPrompt,
        depth: node.modelConfig?.["depth"] || 1,
      }, { timeout: 120000, ...this._mainBrainAxiosConfig() });
      return resp.data;
    });

    // Wire memory executor to main brain
    this.workflows.registerExecutor("memory", async (node) => {
      const action = node.memoryAction || "search";
      const axios = (await import("axios")).default;
      if (action === "store") {
        const resp = await axios.post(`${this.options.mainBrainUrl}/memory`, {
          level: node.memoryParams?.["level"] || "L2",
          content: node.memoryParams?.["content"],
          tags: node.memoryParams?.["tags"] || [],
        }, { timeout: 30000, ...this._mainBrainAxiosConfig() });
        return resp.data;
      } else {
        const resp = await axios.post(`${this.options.mainBrainUrl}/memory/search`, {
          query: node.memoryParams?.["query"] || "",
          top_k: node.memoryParams?.["top_k"] || 5,
        }, { timeout: 30000, ...this._mainBrainAxiosConfig() });
        return resp.data;
      }
    });
  }

  private async _waitForTask(taskId: string, timeoutMs: number): Promise<unknown> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const task = this.tasks.get(taskId);
      if (!task) throw new Error("Task disappeared");
      if (task.status === "completed") return task.result;
      if (task.status === "failed") throw new Error(task.error || "Task failed");
      if (task.status === "cancelled") throw new Error("Task cancelled");
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error("Task timeout");
  }

  // ---- Persistence ----

  private load(): void {
    // Migrate from legacy agents.json if present
    if (existsSync(AGENTS_JSON_LEGACY)) {
      const result = this.fs.migrateFromJson(AGENTS_JSON_LEGACY);
      if (result.migrated > 0) {
        console.log(`[agent] Migrated ${result.migrated} agents to folder structure`);
      }
      if (result.errors.length > 0) {
        console.warn("[agent] Migration errors:", result.errors);
      }
    }

    // Load from folder structure
    try {
      const cards = this.fs.listAgents();
      for (const card of cards) {
        this.agents.set(card.id, card);
        if (!this.sandbox.getPolicy(card.id)) {
          this.sandbox.createDefaultPolicy(card.id);
        }
      }
    } catch (err) { console.error("[agent-manager] Error:", err);
      console.error("[agent] Load from file system failed:", err);
    }

    // Load tasks (still JSON)
    try {
      if (existsSync(TASKS_PATH)) {
        const list: AgentTask[] = JSON.parse(readFileSync(TASKS_PATH, "utf-8"));
        for (const t of list) this.tasks.set(t.taskId, t);
      }
    } catch (err) { console.error("[agent-manager] Error:", err);
      console.error("[agent] Task load failed:", err);
    }
  }

  private saveTasks(): void {
    if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });
    writeFileSync(TASKS_PATH, JSON.stringify(Array.from(this.tasks.values()), null, 2));
  }

  private saveAgent(card: AgentCard): void {
    const existing = this.fs.loadAgent(card.id);
    const files = existing || {
      card,
      systemPrompt: this.fs.buildSystemPrompt(card.id, {}) || "",
      tools: [],
    };
    files.card = card;
    this.fs.saveAgent(files);
  }

  private createDefaultAgent(): void {
    const files = this.fs.createDefaultAgent();
    this.agents.set(files.card.id, files.card);
    this.sandbox.createDefaultPolicy(files.card.id);
  }

  // ---- Agent CRUD ----

  createAgent(card: Omit<AgentCard, "id" | "createdAt" | "updatedAt" | "status">): AgentCard {
    const agent: AgentCard = {
      ...card,
      id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: "idle",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.agents.set(agent.id, agent);

    // Create folder with default system.md and tools
    const defaultTools = [
      { name: "execute_shell", enabled: true, description: "Execute local shell commands" },
      { name: "read_file", enabled: true, description: "Read file contents" },
      { name: "write_file", enabled: true, description: "Write files" },
      { name: "http_request", enabled: true, description: "HTTP requests" },
      { name: "browse_web", enabled: true, description: "Browse web pages" },
    ];
    const systemPrompt = `# ${agent.name}\n\n${agent.name} is a helpful AI assistant.\n\n## Available Tools\n{{tools}}\n\n## Relevant Memories\n{{memory}}\n`;
    this.fs.saveAgent({ card: agent, systemPrompt, tools: defaultTools });

    // Auto-create sandbox policy for new agent
    this.sandbox.createDefaultPolicy(agent.id);

    return agent;
  }

  getAgent(id: string): AgentCard | undefined {
    return this.agents.get(id);
  }

  listAgents(workspaceId?: string): AgentCard[] {
    const all = Array.from(this.agents.values());
    return workspaceId ? all.filter(a => a.workspaceId === workspaceId) : all;
  }

  updateAgentStatus(id: string, status: AgentCard["status"]): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = status;
      agent.updatedAt = new Date().toISOString();
      this.saveAgent(agent);
    }
  }

  updateAgent(id: string, updates: Partial<Omit<AgentCard, "id" | "createdAt">>): AgentCard | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;
    Object.assign(agent, updates, { updatedAt: new Date().toISOString() });
    this.saveAgent(agent);
    return agent;
  }

  deleteAgent(id: string): boolean {
    // Prevent deleting the last agent
    if (this.agents.size <= 1) {
      console.warn("[agent] Cannot delete the last agent");
      return false;
    }

    for (const task of this.tasks.values()) {
      if (task.agentId === id && task.status === "in_progress") {
        this.cancelTask(task.taskId);
      }
    }
    const ok = this.agents.delete(id);
    if (ok) {
      this.fs.deleteAgent(id);
      this.sandbox.deletePolicy(id);
      this.saveTasks();
    }
    return ok;
  }

  // ---- Agent File System accessors ----

  getAgentFiles(id: string) {
    return this.fs.loadAgent(id);
  }

  updateAgentSystemPrompt(id: string, content: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    const files = this.fs.loadAgent(id);
    if (!files) return false;
    files.systemPrompt = content;
    this.fs.saveAgent(files);
    agent.updatedAt = new Date().toISOString();
    return true;
  }

  updateAgentTools(id: string, tools: { name: string; enabled: boolean; description?: string }[]): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    const files = this.fs.loadAgent(id);
    if (!files) return false;
    files.tools = tools;
    files.card.tools = tools.filter((t) => t.enabled).map((t) => t.name);
    this.fs.saveAgent(files);
    this.agents.set(id, files.card);
    return true;
  }

  buildSystemPrompt(agentId: string, vars: { memory?: string; tools?: string } = {}): string | undefined {
    return this.fs.buildSystemPrompt(agentId, vars);
  }

  getEnabledTools(agentId: string): string[] {
    return this.fs.getEnabledTools(agentId);
  }

  // ---- Task Lifecycle ----

  createTask(agentId: string, type: string, payload: Record<string, unknown>, contextId: string): AgentTask {
    const task: AgentTask = {
      taskId: `task-${Date.now()}`,
      agentId,
      type,
      payload,
      status: "pending",
      contextId,
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.taskId, task);
    this.saveTasks();
    return task;
  }

  startTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status !== "pending") return;

    task.status = "in_progress";
    task.startedAt = new Date().toISOString();
    this.saveTasks();

    this.updateAgentStatus(task.agentId, "running");

    this._executeTask(task).catch((err) => {
      console.error(`[agent] Task ${taskId} execution error:`, err);
      this.failTask(taskId, String(err.message || err));
    });
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status !== "pending" && task.status !== "in_progress") return false;

    const timer = this.activeTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(taskId);
    }

    task.status = "cancelled";
    task.completedAt = new Date().toISOString();
    this.saveTasks();

    const agentTasks = this.listTasks(task.agentId);
    const hasActive = agentTasks.some(t => t.status === "in_progress");
    if (!hasActive) {
      this.updateAgentStatus(task.agentId, "idle");
    }

    return true;
  }

  completeTask(taskId: string, result: unknown): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = "completed";
      task.result = result;
      task.completedAt = new Date().toISOString();
      this.saveTasks();
      this._clearTimer(taskId);
      this._maybeSetAgentIdle(task.agentId);
    }
  }

  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = "failed";
      task.error = error;
      task.result = { error };
      task.completedAt = new Date().toISOString();
      this.saveTasks();
      this._clearTimer(taskId);
      this.updateAgentStatus(task.agentId, "error");
    }
  }

  private _clearTimer(taskId: string): void {
    const timer = this.activeTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(taskId);
    }
  }

  private _maybeSetAgentIdle(agentId: string): void {
    const agentTasks = this.listTasks(agentId);
    const hasActive = agentTasks.some(t => t.status === "in_progress");
    if (!hasActive) {
      this.updateAgentStatus(agentId, "idle");
    }
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(agentId?: string): AgentTask[] {
    const all = Array.from(this.tasks.values());
    return agentId ? all.filter(t => t.agentId === agentId) : all;
  }

  // ---- Harness ----

  async runTaskWithHarness(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: "Task not found" };
    const agent = this.agents.get(task.agentId);
    if (!agent) return { ok: false, error: "Agent not found" };
    if (!agent.harnessEnabled) return { ok: false, error: "Harness not enabled" };

    let harness = this.harnesses.get(agent.id);
    if (!harness) {
      harness = new AgentHarness(agent, {
        mainBrainUrl: this.options.mainBrainUrl,
        subBrainUrl: this.options.subBrainUrl,
      });
      this.harnesses.set(agent.id, harness);
    }

    try {
      await harness.run(task, agent);
      const state = harness.getState();
      if (state.status === "done") {
        const lastResult = state.stepResults[state.stepResults.length - 1];
        this.completeTask(taskId, lastResult?.output || { completed: true });
      } else if (state.status === "error") {
        this.failTask(taskId, state.lastError || "Harness execution failed");
      }
      return { ok: true };
    } catch (err: any) {
      this.failTask(taskId, String(err.message || err));
      return { ok: false, error: String(err.message || err) };
    }
  }

  getHarnessState(agentId: string): { ok: boolean; state?: ReturnType<AgentHarness["getState"]>; error?: string } {
    const harness = this.harnesses.get(agentId);
    if (!harness) return { ok: false, error: "No harness found" };
    return { ok: true, state: harness.getState() };
  }

  pauseHarness(agentId: string): { ok: boolean; error?: string } {
    const harness = this.harnesses.get(agentId);
    if (!harness) return { ok: false, error: "No harness found" };
    harness.pause();
    return { ok: true };
  }

  bindSubagent(agentId: string, subagentId: string, role: string, capabilities: string[]): { ok: boolean; binding?: any; error?: string } {
    const agent = this.agents.get(agentId);
    if (!agent) return { ok: false, error: "Agent not found" };
    let harness = this.harnesses.get(agentId);
    if (!harness) {
      harness = new AgentHarness(agent, {
        mainBrainUrl: this.options.mainBrainUrl,
        subBrainUrl: this.options.subBrainUrl,
      });
      this.harnesses.set(agentId, harness);
    }
    const binding = harness.bindSubagent({ subagentId, role, capabilities });
    return { ok: true, binding };
  }

  // ---- Task Execution ----

  private async _executeTask(task: AgentTask): Promise<void> {
    const agent = this.agents.get(task.agentId);
    if (!agent) throw new Error(`Agent not found: ${task.agentId}`);

    // Check sandbox permissions for tools
    if (task.type === "tool") {
      const toolName = task.payload.tool as string;
      const access = this.sandbox.checkToolAccess(agent.id, toolName);
      if (!access.allowed) {
        throw new Error(`Sandbox blocked tool ${toolName}: ${access.reason}`);
      }
    }

    const { type, payload } = task;
    let result: unknown;

    switch (type) {
      case "chat": {
        result = await this._callMainBrain("/chat", {
          message: payload.message || payload.prompt || "",
          session_id: task.contextId,
          use_tools: payload.use_tools !== false,
        });
        break;
      }
      case "reason": {
        result = await this._callMainBrain("/reasoning/analyze", {
          prompt: payload.prompt || payload.message || "",
          depth: payload.depth || 2,
        });
        break;
      }
      case "tool": {
        const toolName = payload.tool as string;
        const toolParams = payload.params as Record<string, unknown> || {};
        result = await this._callSubBrain("/tools/execute", { tool: toolName, params: toolParams });
        break;
      }
      case "memory": {
        if (payload.action === "store") {
          result = await this._callMainBrain("/memory", {
            level: payload.level || "l2",
            content: payload.content,
            tags: payload.tags || [],
          });
        } else {
          result = await this._callMainBrain("/memory/search", {
            query: payload.query,
            top_k: payload.top_k || 5,
          });
        }
        break;
      }
      case "custom": {
        const skillCode = payload.code as string;
        const language = payload.language as string || "javascript";
        if (skillCode) {
          result = await this._executeCustomCode(skillCode, language, payload.params as Record<string, unknown> || {});
        } else {
          throw new Error("Custom task missing 'code' payload");
        }
        break;
      }
      default: {
        throw new Error(`Unknown task type: ${type}`);
      }
    }

    this.completeTask(task.taskId, result);
  }

  private _mainBrainAxiosConfig(): any {
    const uds = process.env.WEBRAIN_MAIN_BRAIN_UDS || "/tmp/webrain-main.sock";
    const useUds = !process.env.WEBRAIN_MAIN_BRAIN_UDS && !process.env.WEBRAIN_MAIN_BRAIN_PORT;
    return useUds ? { socketPath: uds } : {};
  }

  private async _callMainBrain(path: string, body: Record<string, unknown>): Promise<unknown> {
    const axios = (await import("axios")).default;
    const url = `${this.options.mainBrainUrl}${path}`;
    const resp = await axios.post(url, body, { timeout: 120000, ...this._mainBrainAxiosConfig() });
    return resp.data;
  }

  private async _callSubBrain(path: string, body: Record<string, unknown>): Promise<unknown> {
    const axios = (await import("axios")).default;
    const url = `${this.options.subBrainUrl}/api${path}`;
    const resp = await axios.post(url, body, { timeout: 60000 });
    return resp.data;
  }

  private async _executeCustomCode(code: string, language: string, params: Record<string, unknown>): Promise<unknown> {
    const paramJson = JSON.stringify(params).replace(/"/g, '\\"');
    const { execSync } = await import("child_process");

    if (language === "python") {
      const wrapped = `import json\nparams = json.loads("${paramJson}")\n${code}`;
      return execSync(`python3 -c "${wrapped.replace(/"/g, '\\"')}"`, { encoding: "utf-8", timeout: 30000 });
    } else {
      const wrapped = `const params = ${JSON.stringify(params)};\n${code}`;
      return execSync(`node -e "${wrapped.replace(/"/g, '\\"')}"`, { encoding: "utf-8", timeout: 30000 });
    }
  }

  // ---- Cross-agent Collaboration (A2A) ----

  async delegateTask(fromAgentId: string, toAgentId: string, type: string, payload: Record<string, unknown>): Promise<AgentTask> {
    const contextId = `ctx-${fromAgentId}-${toAgentId}-${Date.now()}`;
    const task = this.createTask(toAgentId, type, payload, contextId);
    const fromAgent = this.agents.get(fromAgentId);
    if (fromAgent) {
      console.log(`[a2a] ${fromAgentId} delegated task ${task.taskId} to ${toAgentId}`);
    }
    return task;
  }

  // Convenience wrappers around collaboration engine
  async broadcast(from: string, topic: string, payload: Record<string, unknown>): Promise<A2AMessage> {
    return this.collaboration.broadcast(from, topic, payload);
  }

  async sendMessage(from: string, to: string, topic: string, payload: Record<string, unknown>): Promise<A2AMessage> {
    return this.collaboration.sendDirect(from, to, topic, payload);
  }

  async request(from: string, to: string, action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    return this.collaboration.request(from, to, action, params, timeoutMs);
  }

  async respond(requestId: string, from: string, to: string, ok: boolean, result?: unknown, error?: string): Promise<A2AMessage> {
    return this.collaboration.respond(requestId, from, to, ok, result, error);
  }

  async delegate(from: string, to: string, taskType: string, payload: Record<string, unknown>, contextId: string): Promise<{ taskId: string; result: Promise<unknown> }> {
    return this.collaboration.delegate(from, to, taskType, payload, contextId);
  }

  // ---- Consensus ----

  createProposal(proposerId: string, topic: string, description: string, quorum: number, timeoutSec?: number): ConsensusProposal {
    return this.collaboration.createProposal(proposerId, topic, description, quorum, timeoutSec);
  }

  vote(agentId: string, proposalId: string, vote: "yes" | "no" | "abstain", reason?: string): { ok: boolean; proposal?: ConsensusProposal; error?: string } {
    return this.collaboration.castVote(agentId, proposalId, vote, reason);
  }

  getProposal(id: string): ConsensusProposal | undefined {
    return this.collaboration.getProposal(id);
  }

  listProposals(status?: ConsensusProposal["status"]): ConsensusProposal[] {
    return this.collaboration.listProposals(status);
  }

  closeProposal(proposalId: string): { ok: boolean; proposal?: ConsensusProposal; error?: string } {
    return this.collaboration.closeProposal(proposalId);
  }

  // ---- Conversations ----

  getConversation(id: string): AgentConversation | undefined {
    return this.collaboration.getConversation(id);
  }

  listConversations(agentId?: string): AgentConversation[] {
    return this.collaboration.listConversations(agentId);
  }

  getMessages(filter?: Parameters<AgentCollaborationEngine["getMessages"]>[0]): A2AMessage[] {
    return this.collaboration.getMessages(filter);
  }

  getCollaborationStats(): CollaborationStats {
    return this.collaboration.getStats();
  }

  // ---- Templates ----

  listTemplates(category?: string, tag?: string): AgentTemplate[] {
    return this.templates.list(category, tag);
  }

  getTemplate(id: string): AgentTemplate | undefined {
    return this.templates.get(id);
  }

  createTemplate(tpl: Omit<AgentTemplate, "id" | "createdAt" | "updatedAt" | "isBuiltIn">): AgentTemplate {
    return this.templates.create(tpl);
  }

  deleteTemplate(id: string): boolean {
    return this.templates.delete(id);
  }

  instantiateTemplate(tplId: string, options?: TemplateInstanceOptions): { ok: boolean; card?: Record<string, unknown>; error?: string } {
    return this.templates.instantiate(tplId, options);
  }

  getTemplateCategories(): string[] {
    return this.templates.getCategories();
  }

  getTemplateTags(): string[] {
    return this.templates.getTags();
  }

  // ---- Workflows ----

  createWorkflow(def: Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">): { ok: boolean; workflow?: WorkflowDefinition; error?: string } {
    return this.workflows.createWorkflow(def);
  }

  getWorkflow(id: string): WorkflowDefinition | undefined {
    return this.workflows.getWorkflow(id);
  }

  listWorkflows(workspaceId?: string): WorkflowDefinition[] {
    return this.workflows.listWorkflows(workspaceId);
  }

  updateWorkflow(id: string, updates: Partial<Omit<WorkflowDefinition, "id" | "createdAt">>): { ok: boolean; workflow?: WorkflowDefinition; error?: string } {
    return this.workflows.updateWorkflow(id, updates);
  }

  deleteWorkflow(id: string): boolean {
    return this.workflows.deleteWorkflow(id);
  }

  validateWorkflow(id: string): { valid: boolean; errors: string[] } {
    return this.workflows.validateWorkflow(id);
  }

  async runWorkflow(workflowId: string, inputs?: Record<string, unknown>): Promise<WorkflowRun> {
    return this.workflows.runWorkflow(workflowId, inputs);
  }

  cancelWorkflowRun(runId: string): boolean {
    return this.workflows.cancelRun(runId);
  }

  getWorkflowRun(runId: string): WorkflowRun | undefined {
    return this.workflows.getRun(runId);
  }

  listWorkflowRuns(workflowId?: string, status?: WorkflowRun["status"]): WorkflowRun[] {
    return this.workflows.listRuns(workflowId, status);
  }

  // ---- Sandbox ----

  createSandboxPolicy(agentId: string, policy?: Partial<SandboxPolicy>): SandboxPolicy {
    if (policy) {
      const existing = this.sandbox.getPolicy(agentId);
      if (existing) {
        return this.sandbox.updatePolicy(agentId, policy)!;
      }
    }
    return this.sandbox.createDefaultPolicy(agentId);
  }

  getSandboxPolicy(agentId: string): SandboxPolicy | undefined {
    return this.sandbox.getPolicy(agentId);
  }

  updateSandboxPolicy(agentId: string, updates: Partial<SandboxPolicy>): SandboxPolicy | undefined {
    return this.sandbox.updatePolicy(agentId, updates);
  }

  createSandboxSession(agentId: string): SandboxSession {
    return this.sandbox.createSession(agentId);
  }

  getSandboxStats(): { totalPolicies: number; activeSessions: number; totalAuditLogs: number; blockedActions: number } {
    return this.sandbox.getStats();
  }

  getSandboxAuditLogs(agentId?: string, limit?: number): SandboxAuditLog[] {
    return this.sandbox.getAuditLogs(agentId, limit);
  }

  // ---- Stats ----

  getStats(): Record<string, unknown> {
    const tasks = Array.from(this.tasks.values());
    return {
      agents: {
        total: this.agents.size,
        byStatus: {
          idle: Array.from(this.agents.values()).filter(a => a.status === "idle").length,
          running: Array.from(this.agents.values()).filter(a => a.status === "running").length,
          error: Array.from(this.agents.values()).filter(a => a.status === "error").length,
        },
      },
      tasks: {
        total: tasks.length,
        pending: tasks.filter(t => t.status === "pending").length,
        inProgress: tasks.filter(t => t.status === "in_progress").length,
        completed: tasks.filter(t => t.status === "completed").length,
        failed: tasks.filter(t => t.status === "failed").length,
      },
      collaboration: this.collaboration.getStats(),
      templates: this.templates.getStats(),
      workflows: this.workflows.getStats(),
      sandbox: this.sandbox.getStats(),
    };
  }
}
