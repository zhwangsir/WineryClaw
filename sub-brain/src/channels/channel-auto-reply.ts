/**
 * Channel Auto-Reply Engine (M5 + M7a).
 *
 * Subscribes to inbound channel messages and, for channels with
 * `auto_reply` enabled, routes them into the main-brain chat engine and
 * sends the response back through the same channel.
 *
 * M7a enhancement: persistent reply queue + retry + dead-letter queue.
 * When `deps.queue` is provided, inbound messages are written to SQLite
 * and a worker loop processes them asynchronously. When `queue` is absent,
 * the legacy in-memory Promise-chain behavior is preserved for tests.
 */

import crypto from "node:crypto";
import type { ChannelManager, InboundMessage } from "./channel-manager.js";
import type { PersistentReplyQueue } from "./persistent-reply-queue.js";

export interface AutoReplyDeps {
  channelManager: ChannelManager;
  chatFn: (params: { message: string; session_id: string; agent_id: string }) => Promise<{ reply: string }>;
  defaultAgentId?: string;
  queue?: PersistentReplyQueue;
}

function senderToSessionId(channelId: string, sender: string): string {
  const h = crypto.createHash("sha256").update(`${channelId}:${sender}`).digest("hex").slice(0, 12);
  return `ch-${channelId}-${h}`;
}

export class ChannelAutoReply {
  private inFlight = new Map<string, Promise<void>>();
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private deps: AutoReplyDeps) {}

  static sessionId(channelId: string, sender: string): string {
    return senderToSessionId(channelId, sender);
  }

  /** Start the background worker loop (idempotent). Only needed when a
   * persistent queue is in use; no-op otherwise. */
  startWorker(pollIntervalMs = 5000): void {
    if (!this.deps.queue) return;
    if (this.workerTimer) return;
    this.stopped = false;
    this.workerTimer = setInterval(() => {
      this.drainQueue().catch((err) => {
        console.error("[auto-reply] queue drain error:", err);
      });
    }, pollIntervalMs);
    // Immediate first drain so we don't wait pollIntervalMs for the first message
    this.drainQueue().catch((err) => console.error("[auto-reply] initial drain error:", err));
  }

  /** Stop the background worker loop. */
  stopWorker(): void {
    this.stopped = true;
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  handleInbound = async (
    channelId: string,
    _channelType: string,
    message: InboundMessage,
  ): Promise<void> => {
    const channel = this.deps.channelManager.listChannels().find((c) => c.id === channelId);
    if (!channel) return;
    if (!channel.auto_reply) return;
    const content = (message.content || "").trim();
    if (!content) return;

    const sessionId = senderToSessionId(channelId, message.sender);
    const agentId = channel.agent_id || this.deps.defaultAgentId || "agent-default";
    const delayMs = channel.reply_delay_ms || 0;

    const replyTo = message.reply_to;

    if (this.deps.queue) {
      // Persistent queue path (M7a)
      // TODO: reply_to should be stored in the queue row so drainQueue
      // can pass it through to runReply. Currently the queue schema does
      // not have a reply_to column.
      this.deps.queue.enqueue({
        channel_id: channelId,
        sender: message.sender,
        content,
        session_id: sessionId,
        agent_id: agentId,
      });
      return;
    }

    // Legacy in-memory path (tests / backward compat)
    const lockKey = `${channelId}:${message.sender}`;
    const previous = this.inFlight.get(lockKey) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return this.runReply(channelId, message.sender, content, sessionId, agentId, replyTo);
    });
    this.inFlight.set(lockKey, next);

    next
      .catch((err) => {
        console.error(`[auto-reply] reply task failed for ${lockKey}:`, err);
      })
      .finally(() => {
        if (this.inFlight.get(lockKey) === next) {
          this.inFlight.delete(lockKey);
        }
      });
  };

  private async drainQueue(): Promise<void> {
    if (!this.deps.queue || this.stopped) return;
    // Process up to 10 messages per tick to avoid blocking the event loop
    for (let i = 0; i < 10; i++) {
      const row = this.deps.queue.dequeue();
      if (!row) break;
      try {
        // M5.1: honour per-channel reply delay from current channel config
        const channel = this.deps.channelManager.listChannels().find((c) => c.id === row.channel_id);
        const delayMs = channel?.reply_delay_ms || 0;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        await this.runReply(row.channel_id, row.sender, row.content, row.session_id, row.agent_id);
        this.deps.queue.markSuccess(row.id);
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        console.error(`[auto-reply] queue item ${row.id} failed:`, errorMsg);
        this.deps.queue.markFailed(row.id, errorMsg);
      }
    }
  }

  private async runReply(
    channelId: string,
    sender: string,
    content: string,
    sessionId: string,
    agentId: string,
    replyTo?: string,
  ): Promise<void> {
    let reply: string;
    try {
      const res = await this.deps.chatFn({ message: content, session_id: sessionId, agent_id: agentId });
      reply = (res?.reply || "").trim();
    } catch (err: any) {
      console.error(`[auto-reply] chatFn failed for ${channelId}:`, err?.message || err);
      throw err; // Let caller decide retry / DLQ
    }
    if (!reply) {
      return;
    }

    const recipient = replyTo || sender;
    try {
      const sendResult = await this.deps.channelManager.send(channelId, recipient, reply);
      if (!sendResult.ok) {
        throw new Error(sendResult.error || "send failed");
      }
    } catch (err: any) {
      console.error(`[auto-reply] send threw for ${channelId}:`, err?.message || err);
      throw err; // Let caller decide retry / DLQ
    }
  }
}
