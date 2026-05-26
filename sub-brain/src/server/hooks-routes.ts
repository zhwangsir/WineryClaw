/**
 * Hooks-cross-process bridge.
 *
 * v2.12 — Axis 2 plugin-hook 跨进程化第一步:把 pre_llm_call /
 * post_llm_call 从 "unwired" 变成 "wired"。LLM call 物理发生在
 * main-brain Python,sub-brain TS 的 hookRegistry 跨不过进程边界,
 * 所以 main-brain 在 _chat_completion 前后 fire-and-forget POST 通知
 * 到这里,这里再调 hookRegistry 让插件作者写的 TS hook 跑起来。
 *
 * v2.15 — 接通最后一个 on_shutdown(Axis 2 8/8 完成)。main-brain
 * FastAPI lifespan shutdown 时 fire-and-forget POST 到 /hooks/process/shutdown,
 * 这里调用 hookRegistry.runShutdown() 让插件清理资源。
 *
 *   POST /hooks/llm/pre   — body { messages, model?, temperature?, agentId?, sessionId? }
 *                            → runs HookRegistry.runPreLLMCall
 *                            → returns { allowed, modified?, reason? }
 *   POST /hooks/llm/post  — body { context, response }
 *                            → runs HookRegistry.runPostLLMCall
 *                            → returns { ok: true }
 *   POST /hooks/session/start  — body { sessionId, meta? }
 *   POST /hooks/session/end    — body { sessionId, meta? }
 *   POST /hooks/process/shutdown — body {} (空体) — 触发 runShutdown
 */

import type { FastifyInstance } from "fastify";
import type { HookRegistry, LLMCallContext } from "../plugin-sdk/hooks.js";

export interface HooksRouteDeps {
  hookRegistry: HookRegistry;
}

interface PreLLMBody {
  messages?: Array<Record<string, unknown>>;
  model?: string;
  temperature?: number;
  agentId?: string;
  sessionId?: string;
}

interface PostLLMBody {
  context?: LLMCallContext;
  response?: unknown;
}

interface SessionBody {
  sessionId?: string;
  meta?: Record<string, unknown>;
}

export function registerHooksRoutes(app: FastifyInstance, deps: HooksRouteDeps): void {
  app.post("/hooks/llm/pre", async (request, reply) => {
    const body = (request.body as PreLLMBody) ?? {};
    if (!Array.isArray(body.messages)) {
      reply.code(400);
      return { allowed: false, error: "messages array required" };
    }
    const ctx: LLMCallContext = {
      messages: body.messages,
      model: body.model,
      temperature: body.temperature,
      agentId: body.agentId,
      sessionId: body.sessionId,
    };
    try {
      const result = await deps.hookRegistry.runPreLLMCall(ctx);
      // Echo possibly-mutated ctx fields so caller can apply.
      return {
        ...result,
        modified: result.modified
          ? result.modified
          : { messages: ctx.messages, temperature: ctx.temperature },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { allowed: true, reason: `hook-error (allow-through): ${message}` };
    }
  });

  app.post("/hooks/llm/post", async (request) => {
    const body = (request.body as PostLLMBody) ?? {};
    const ctx: LLMCallContext = (body.context as LLMCallContext) ?? { messages: [] };
    try {
      await deps.hookRegistry.runPostLLMCall(ctx, body.response);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  app.post("/hooks/session/start", async (request) => {
    const body = (request.body as SessionBody) ?? {};
    if (!body.sessionId) return { ok: false, error: "sessionId required" };
    try {
      await deps.hookRegistry.runSessionStart(body.sessionId, body.meta);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post("/hooks/session/end", async (request) => {
    const body = (request.body as SessionBody) ?? {};
    if (!body.sessionId) return { ok: false, error: "sessionId required" };
    try {
      await deps.hookRegistry.runSessionEnd(body.sessionId, body.meta);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * v2.15 (Axis 2 8/8): main-brain FastAPI lifespan shutdown 触发,
   * sub-brain 调用 hookRegistry.runShutdown() 让所有插件清理资源。
   *
   * 错误 swallow-and-log:即使某插件 shutdown hook 抛错也不能阻塞
   * main-brain 退出流程。
   */
  app.post("/hooks/process/shutdown", async () => {
    try {
      await deps.hookRegistry.runShutdown();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
