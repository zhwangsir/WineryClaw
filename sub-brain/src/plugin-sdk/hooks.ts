/**
 * Plugin SDK — Lifecycle Hooks
 *
 * Hooks that ACTUALLY FIRE today (verified by call-site grep):
 *   - on_startup      — main.ts:129 calls hookRegistry.runStartup()
 *   - pre_tool_call   — tool-executor.ts calls hookRegistry.runPreToolCall()
 *   - post_tool_call  — tool-executor.ts calls hookRegistry.runPostToolCall()
 *
 * Hooks declared but NOT WIRED end-to-end (interface preserved for forward
 * compatibility; runtime calls remain no-ops):
 *   - pre_llm_call / post_llm_call  — LLM calls happen in main-brain Python,
 *     out of reach of this sub-brain TS hookRegistry. To wire, need
 *     cross-process RPC from main-brain.
 *   - on_session_start / on_session_end — chat session lifecycle currently
 *     lives in main-brain Python.
 *   - on_shutdown — process termination not yet wrapped.
 *
 * `HOOK_STATUS` below is the source of truth — `/hooks/registry` HTTP
 * endpoint surfaces it so plugin authors / UI can show which hooks are
 * actually safe to use.
 */

export type HookType =
  | "pre_tool_call"
  | "post_tool_call"
  | "pre_llm_call"
  | "post_llm_call"
  | "on_session_start"
  | "on_session_end"
  | "on_startup"
  | "on_shutdown";

/** Runtime status per hook type. "wired" = real call site triggers it. */
export type HookWiredStatus = "wired" | "unwired";

export const HOOK_STATUS: Record<HookType, HookWiredStatus> = {
  pre_tool_call: "wired",
  post_tool_call: "wired",
  on_startup: "wired",
  // v2.12 (Axis 2): cross-process bridge via /hooks/llm/{pre,post} +
  // /hooks/session/{start,end} — main-brain Python POSTs into sub-brain
  // before/after _chat_completion, sub-brain dispatches to plugin hooks.
  pre_llm_call: "wired",
  post_llm_call: "wired",
  on_session_start: "wired",
  on_session_end: "wired",
  // v2.15 (Axis 2 8/8): main-brain FastAPI lifespan shutdown 触发
  // POST /hooks/process/shutdown,sub-brain 跑 runShutdown 通知所有插件。
  on_shutdown: "wired",
};

export interface ToolCallContext {
  tool: string;
  params: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  userId?: string;
}

export interface LLMCallContext {
  messages: Array<Record<string, unknown>>;
  model?: string;
  temperature?: number;
  agentId?: string;
  sessionId?: string;
}

export interface HookResult {
  allowed: boolean;
  modified?: Record<string, unknown>;
  error?: string;
  reason?: string;
}

export type PreToolCallHook = (ctx: ToolCallContext) => Promise<HookResult>;
export type PostToolCallHook = (ctx: ToolCallContext, result: unknown) => Promise<HookResult>;
export type PreLLMCallHook = (ctx: LLMCallContext) => Promise<HookResult>;
export type PostLLMCallHook = (ctx: LLMCallContext, response: unknown) => Promise<HookResult>;
export type SessionHook = (sessionId: string, meta?: Record<string, unknown>) => Promise<void>;

export interface PluginHooks {
  pre_tool_call?: PreToolCallHook[];
  post_tool_call?: PostToolCallHook[];
  pre_llm_call?: PreLLMCallHook[];
  post_llm_call?: PostLLMCallHook[];
  on_session_start?: SessionHook[];
  on_session_end?: SessionHook[];
  on_startup?: Array<() => Promise<void>>;
  on_shutdown?: Array<() => Promise<void>>;
}

export class HookRegistry {
  private hooks: PluginHooks = {
    pre_tool_call: [],
    post_tool_call: [],
    pre_llm_call: [],
    post_llm_call: [],
    on_session_start: [],
    on_session_end: [],
    on_startup: [],
    on_shutdown: [],
  };

  register(type: HookType, handler: any): void {
    const arr = this.hooks[type] as any[];
    if (arr) arr.push(handler);
  }

  unregister(type: HookType, handler: any): void {
    const arr = this.hooks[type] as any[];
    if (!arr) return;
    const idx = arr.indexOf(handler);
    if (idx >= 0) arr.splice(idx, 1);
  }

  async runPreToolCall(ctx: ToolCallContext): Promise<HookResult> {
    for (const hook of this.hooks.pre_tool_call || []) {
      const result = await hook(ctx);
      if (!result.allowed) return result;
      if (result.modified) ctx.params = { ...ctx.params, ...result.modified };
    }
    return { allowed: true };
  }

  async runPostToolCall(ctx: ToolCallContext, result: unknown): Promise<unknown> {
    for (const hook of this.hooks.post_tool_call || []) {
      await hook(ctx, result);
    }
    return result;
  }

  async runPreLLMCall(ctx: LLMCallContext): Promise<HookResult> {
    for (const hook of this.hooks.pre_llm_call || []) {
      const result = await hook(ctx);
      if (!result.allowed) return result;
      if (result.modified) {
        const mod = result.modified as any;
        if (mod.messages) ctx.messages = mod.messages;
        if (mod.temperature !== undefined) ctx.temperature = mod.temperature;
      }
    }
    return { allowed: true };
  }

  async runPostLLMCall(ctx: LLMCallContext, response: unknown): Promise<unknown> {
    for (const hook of this.hooks.post_llm_call || []) {
      await hook(ctx, response);
    }
    return response;
  }

  async runSessionStart(sessionId: string, meta?: Record<string, unknown>): Promise<void> {
    for (const hook of this.hooks.on_session_start || []) {
      await hook(sessionId, meta);
    }
  }

  async runSessionEnd(sessionId: string, meta?: Record<string, unknown>): Promise<void> {
    for (const hook of this.hooks.on_session_end || []) {
      await hook(sessionId, meta);
    }
  }

  async runStartup(): Promise<void> {
    for (const hook of this.hooks.on_startup || []) {
      await hook();
    }
  }

  async runShutdown(): Promise<void> {
    for (const hook of this.hooks.on_shutdown || []) {
      await hook();
    }
  }
}

export const hookRegistry = new HookRegistry();
