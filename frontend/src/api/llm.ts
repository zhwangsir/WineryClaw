/**
 * LLM router stats + health API (M4a).
 *
 * `GET /brain/llm/stats` returns the in-memory snapshot the router has
 * accumulated from real traffic + background probes. `POST /brain/llm/
 * health/recheck` forces a fresh out-of-band probe (optionally for one
 * named endpoint) without waiting for the next monitor tick.
 */

import { api } from "./client";

export interface LLMEndpointStats {
  name: string;
  base_url: string;
  model_id: string;
  provider: string;
  priority: number;
  healthy: boolean;
  success_count: number;
  failure_count: number;
  avg_latency_ms: number;
  last_latency_ms: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error: string | null;
  unhealthy_since: number | null;
}

export interface LLMStats {
  ok: boolean;
  status: "healthy" | "degraded" | "down" | "unknown";
  total_count: number;
  healthy_count: number;
  monitor_running: boolean;
  endpoints: LLMEndpointStats[];
  error?: string;
}

export interface LLMRecheckResult {
  ok: boolean;
  probed: boolean;
  endpoint?: LLMEndpointStats;
  endpoints?: Record<string, { healthy: boolean; last_error: string | null }>;
  healthy?: boolean;
  error?: string;
}

export const llmApi = {
  stats: () => api.get<LLMStats>("/brain/llm/stats"),
  recheck: (name?: string) => api.post<LLMRecheckResult>("/brain/llm/health/recheck", name ? { name } : {}),
};
