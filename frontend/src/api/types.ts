/**
 * WeBrain API Shared Types
 */

export interface SystemHealth {
  status: "ok" | "degraded" | "down";
  component: string;
  modules: Record<string, boolean>;
}

export interface ModelEndpoint {
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  priority: number;
  timeout: number;
  healthy?: boolean;
}

export interface ModelConfig {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  endpoints: ModelEndpoint[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  isStreaming?: boolean;
  timestamp: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolResult {
  toolCallId: string;
  output: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  role?: string;
  systemPrompt?: string;
  modelConfig?: {
    baseUrl?: string;
    modelId?: string;
    temperature?: number;
    maxTokens?: number;
  };
  capabilities?: string[];
  tools?: string[];
  maxSteps?: number;
  status?: "idle" | "running" | "error";
  enabled: boolean;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentToolConfig {
  name: string;
  enabled: boolean;
  description?: string;
}

export interface Memory {
  id: string;
  level: "L1" | "L2" | "L3" | "L4";
  content: string;
  source: string;
  sessionId?: string;
  createdAt: string;
  vectorScore?: number;
}

export interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  connected: boolean;
  config?: Record<string, unknown>;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  icon?: string;
}

export interface WikiNote {
  id: string;
  title: string;
  content: string;
  tags: string[];
  links: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KgEntity {
  id: string;
  name: string;
  type: string;
  description?: string;
  mentionCount: number;
}

export interface KgRelation {
  id: string;
  source: string;
  target: string;
  type: string;
  confidence: number;
}

export interface CronJobData {
  id?: string;
  name: string;
  cron_expr: string;
  task_type: string;
  task_params?: Record<string, unknown>;
  enabled?: boolean;
  max_retries?: number;
  webhook_url?: string;
}

export interface CronJob {
  id: string;
  name: string;
  cron_expr: string;
  task_type: string;
  task_params: Record<string, unknown>;
  enabled: boolean;
  max_retries: number;
  webhook_url?: string;
  created_at: string;
  updated_at: string;
  last_run?: string;
  next_run?: string;
  run_count: number;
}

export interface GlobalConfig {
  version: string;
  debug: boolean;
  logLevel: string;
  maxConcurrentTools: number;
  toolTimeoutMs: number;
  requireConfirmation: boolean;
  whitelistMode: "strict" | "permissive";
  defaultWorkspace: string;
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  entry?: string;
  manifest?: {
    id: string;
    name: string;
    version: string;
    description?: string;
    permissions?: string[];
    entry?: string;
  };
}

export interface Skill {
  id: string;
  name: string;
  language: string;
  code: string;
  usageCount: number;
  successRate: number;
  triggers: string[];
  createdAt: string;
}

export interface SkillStats {
  totalSkills: number;
  totalInvocations: number;
  averageSuccessRate: number;
}

export interface ModelHealth {
  status: string;
  error?: string;
  endpoints: Array<{
    name: string;
    baseUrl: string;
    modelId: string;
    healthy: boolean;
    latency?: number;
  }>;
}

export interface CronRun {
  id: string;
  jobId: string;
  status: "success" | "failure" | "running";
  output?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface Notification {
  id: string;
  type: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  role: string;
  capabilities: string[];
  systemPrompt?: string;
  tools?: string[];
  variables?: Record<string, string>;
  createdAt: string;
}

export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  workspaceId?: string;
  nodes: Array<{
    id: string;
    type: string;
    label?: string;
    config?: Record<string, unknown>;
    toolName?: string;
    toolParams?: Record<string, unknown>;
    agentId?: string;
  }>;
  edges: Array<{ from: string; to: string; condition?: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
}
