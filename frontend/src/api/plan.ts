/**
 * Plan execution API (M3).
 *
 * `POST /brain/plan/execute` runs a Plan task-by-task with verify + retry.
 * Accepts either a fresh user input (to plan + execute) or an existing
 * plan (e.g. one returned by a previous /chat call's `plan` field).
 */

import { api } from "./client";
import type { ChatPlan } from "./types";

export interface PlanTaskAttempt {
  attempt_idx: number;
  output: string;
  verification_passed: boolean;
  verification_reason: string;
  strategy: "default" | "augmented";
  duration_ms: number;
}

export interface PlanTaskResult {
  task_id: string;
  description: string;
  final_output: string;
  succeeded: boolean;
  attempts: PlanTaskAttempt[];
}

export interface PlanExecutionResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  plan_id?: string;
  plan?: ChatPlan;
  results?: PlanTaskResult[];
  total_attempts?: number;
  overall_success?: boolean;
  failed_task_ids?: string[];
}

export type PlanVerifyMode = "presence" | "llm";

export interface ExecutePlanParams {
  /** Provide one of: a complete plan or a user_input to plan-then-run. */
  plan?: ChatPlan;
  user_input?: string;
  session_id?: string;
  agent_id?: string;
  verify?: PlanVerifyMode;
}

export interface PlanStreamEvent {
  event: string;
  plan_id?: string;
  total_tasks?: number;
  task_id?: string;
  description?: string;
  attempt_idx?: number;
  attempt?: PlanTaskAttempt;
  succeeded?: boolean;
  attempts_count?: number;
  overall_success?: boolean;
  total_attempts?: number;
  failed_task_ids?: string[];
  result?: PlanExecutionResult;
  message?: string;
  session_id?: string;
}

export const planApi = {
  execute: (params: ExecutePlanParams) => api.post<PlanExecutionResult>("/brain/plan/execute", params),

  executeStream: (
    params: ExecutePlanParams,
    onEvent: (event: PlanStreamEvent) => void,
    onDone?: () => void,
    onError?: (err: Error) => void,
  ) => {
    const { client, url } = api.stream("/brain/plan/execute/stream", params as Record<string, unknown>);
    client.connect(url, (data) => {
      if (typeof data === "object" && data !== null) {
        onEvent(data as PlanStreamEvent);
      }
    }, onDone, onError);
    return client;
  },
};
