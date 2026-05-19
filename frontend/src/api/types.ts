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

export interface RagSource {
  doc_path: string;
  chunk_idx: number;
  score: number;
}

export interface PlanTask {
  id: string;
  description: string;
  requires_tool?: boolean;
  tool_hint?: string;
  expected_output?: string;
}

export interface ChatPlan {
  plan_id: string;
  user_input: string;
  tasks: PlanTask[];
  confidence: number;
  reasoning: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  ragSources?: RagSource[];
  plan?: ChatPlan;
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
  // M-Memory-1 fields surfaced by /memory/recent and /memory/query
  importance?: number;            // 0.0 - 1.0, decays per half-life
  last_accessed_at?: string;      // ISO; resets on retrieve
  access_count?: number;
  effective_importance?: number;  // server-computed decayed value (for query rows)
  provenance_source?: string;     // "chat" | "consolidation_l1_l2" | etc
  provenance_refs?: string;       // JSON-encoded list of source memory IDs
  superseded_by?: string | null;  // when L1 was rolled into an L2
  conflict_group?: string | null; // when in a contradiction set
  is_current?: number;            // 0 | 1
  final_score?: number;           // server-computed blended rank score
}

// M-Memory-1: returned by /memory/conflicts and /memory/{id}
export interface ConflictGroup {
  conflict_group: string;
  memories: Memory[];
  current_id: string | null;
}

export interface MemoryLineage {
  ok: boolean;
  memory: Memory;
  sources: Memory[];
  supersedes: Memory[];
  superseded_by: Memory | null;
  error?: string;
}

export interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  connected: boolean;
  /** M5: when true, inbound messages are auto-routed through chat
   * and a reply is sent back through the same channel. */
  auto_reply?: boolean;
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
