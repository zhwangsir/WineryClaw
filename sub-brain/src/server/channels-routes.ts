/**
 * Channel (messaging adapter) routes.
 *
 *   POST   /channels/connect              — connect to a channel (Telegram/Discord/etc)
 *   POST   /channels/send                 — send a message
 *   POST   /channels/disconnect           — close a connection
 *   GET    /channels                      — list connected channels
 *   GET    /channels/list                 — compat alias
 *   GET    /channels/:id/health           — health check
 *   GET    /channels/:id/messages         — fetched messages cache
 *   POST   /channels/:id/receive/start    — begin polling/listening
 *   POST   /channels/:id/receive/stop     — stop receiving
 *   POST   /channels/:id/toggle           — toggle enabled flag
 *   POST   /channels/:id/auto-reply       — set auto-reply flag (M5)
 *   GET    /channels/:id/auto-reply       — query auto-reply flag (M5)
 *   POST   /channels/:id/inject-inbound   — replay/inject an inbound message
 *   DELETE /channels/:id                  — remove channel config
 */

import type { FastifyInstance } from "fastify";
import type { ChannelManager } from "../channels/channel-manager.js";

export interface ChannelsRouteDeps {
  channelManager: ChannelManager;
}

interface ConnectBody {
  channel?: string;
  config?: Record<string, unknown>;
}

interface SendBody {
  channel?: string;
  recipient?: string;
  content?: string;
}

interface DisconnectBody {
  channel_id?: string;
}

export function registerChannelsRoutes(app: FastifyInstance, deps: ChannelsRouteDeps): void {
  app.post("/channels/connect", async (request, reply) => {
    try {
      const body = (request.body as ConnectBody) ?? {};
      return await deps.channelManager.connect(
        String(body.channel ?? ""),
        body.config ?? {},
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Channel connection failed";
      return reply.code(500).send({ ok: false, error: msg });
    }
  });

  app.post("/channels/send", async (request) => {
    const body = (request.body as SendBody) ?? {};
    return deps.channelManager.send(
      String(body.channel ?? ""),
      String(body.recipient ?? ""),
      String(body.content ?? ""),
    );
  });

  app.post("/channels/disconnect", async (request) => {
    const body = (request.body as DisconnectBody) ?? {};
    return deps.channelManager.disconnect(String(body.channel_id ?? ""));
  });

  const listHandler = async () => ({ channels: deps.channelManager.listChannels() });
  app.get("/channels", listHandler);
  app.get("/channels/list", listHandler); // compat

  app.get("/channels/:id/health", async (request) => {
    const { id } = request.params as { id: string };
    return { ok: true, healthy: await deps.channelManager.healthCheck(id) };
  });

  app.get("/channels/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    return { messages: deps.channelManager.getMessages(id) };
  });

  app.post("/channels/:id/receive/start", async (request) => {
    const { id } = request.params as { id: string };
    return deps.channelManager.startReceiving(id);
  });

  app.post("/channels/:id/receive/stop", async (request) => {
    const { id } = request.params as { id: string };
    return deps.channelManager.stopReceiving(id);
  });

  app.post("/channels/:id/toggle", async (request) => {
    const { id } = request.params as { id: string };
    return deps.channelManager.toggle(id);
  });

  // M5 — auto-reply (inbound → chat → outbound) toggle.
  app.post("/channels/:id/auto-reply", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { enabled?: boolean }) ?? {};
    const enabled = body.enabled === true;
    return deps.channelManager.setAutoReply(id, enabled);
  });

  app.get("/channels/:id/auto-reply", async (request) => {
    const { id } = request.params as { id: string };
    return { ok: true, auto_reply: deps.channelManager.getAutoReply(id) };
  });

  // M5.1 (v2.30) — per-channel policy: agent_id, sender/keyword allow/block,
  // time windows, rate limit, reply delay. Applied BEFORE chat_engine on
  // every inbound message; blocked messages still land in the messages
  // table (audit trail) but do not consume LLM budget.
  app.get("/channels/:id/policy", async (request, reply) => {
    const { id } = request.params as { id: string };
    const policy = deps.channelManager.getPolicy(id);
    if (policy === undefined) {
      // Could be either "channel not found" or "no policy set". Check
      // existence so the UI can distinguish 404 from empty-but-valid.
      const exists = deps.channelManager
        .listChannels()
        .some((c) => c.id === id);
      if (!exists) {
        return reply.code(404).send({ ok: false, error: "Channel not found" });
      }
      return { ok: true, policy: null };
    }
    return { ok: true, policy };
  });

  app.put("/channels/:id/policy", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { policy?: unknown };
    const result = await deps.channelManager.setPolicy(id, body.policy ?? body);
    if (!result.ok) {
      if (/not found/i.test(result.error ?? "")) {
        return reply.code(404).send({ ok: false, error: result.error });
      }
      return reply.code(400).send({ ok: false, error: result.error });
    }
    return { ok: true, policy: result.policy };
  });

  app.delete("/channels/:id/policy", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await deps.channelManager.setPolicy(id, null);
    if (!result.ok) {
      return reply.code(404).send({ ok: false, error: result.error });
    }
    return { ok: true, policy: null };
  });

  app.get("/channels/:id/policy/audit", async (request) => {
    const { id } = request.params as { id: string };
    const qs = (request.query as { limit?: string }) ?? {};
    const limit = qs.limit ? Math.max(1, Math.min(parseInt(qs.limit, 10) || 50, 200)) : 50;
    // Dynamic import keeps channels-routes.ts free of a heavy direct
    // import of the auto-reply module just for the audit accessor.
    const mod = await import("../channels/channel-auto-reply.js");
    const entries = mod.recentPolicyAudit(id, limit);
    return { ok: true, count: entries.length, entries };
  });

  // POST /channels/:id/inject-inbound — replay or simulate an inbound
  // message. Used by smoke tests (Round C5) to exercise the
  // inbound→auto-reply pipeline against a "memory" channel without
  // needing real credentials. Also useful for admins to retry a message
  // that was missed during a polling-worker outage.
  app.post("/channels/:id/inject-inbound", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as {
      sender?: string;
      content?: string;
      timestamp?: string;
      reply_to?: string;
    }) ?? {};
    const sender = String(body.sender ?? "test-sender");
    const content = String(body.content ?? "");
    if (!content) {
      return reply.code(400).send({ ok: false, error: "content is required" });
    }
    const message = {
      sender,
      content,
      timestamp: body.timestamp ?? new Date().toISOString(),
      reply_to: body.reply_to,
    };
    const result = deps.channelManager.simulateInbound(id, message);
    // Round E2: surface unknown-channel as HTTP 404 rather than
    // 200+{ok:false}. Admin tooling (curl --fail, monitoring scripts,
    // shell automation that branches on $? after HTTP status) needs
    // the status code to reflect reality. The body still carries
    // {ok:false, error:...} for callers that want the structured
    // shape; only the HTTP code changes.
    if (!result.ok && /not found/i.test(result.error ?? "")) {
      return reply.code(404).send(result);
    }
    return result;
  });

  app.delete("/channels/:id", async (request) => {
    const { id } = request.params as { id: string };
    return deps.channelManager.deleteChannel(id);
  });
}
