/**
 * Channel Auto-Reply Engine (M5).
 *
 * Subscribes to inbound channel messages and, for channels with
 * `auto_reply` enabled, routes them into the main-brain chat engine and
 * sends the response back through the same channel.
 *
 * Design points:
 *  - The engine is wired in via `channelManager.setInboundHandler(...)`,
 *    so channel-manager itself stays oblivious to chat-engine semantics.
 *  - Per-sender sticky session_id: each remote contact gets a stable
 *    session so chat history accumulates correctly across messages.
 *  - Fire-and-forget reply send: a transient send failure logs but does
 *    not block subsequent inbound messages.
 *  - Loop prevention: empty content is skipped. The bot's own outbound
 *    messages never reach this path (storeMessage with direction
 *    "outbound" doesn't fire the inbound handler), so message loops
 *    from the bot replying to itself are impossible by construction.
 *  - In-flight tracking: a sender → Promise map prevents two concurrent
 *    replies stomping on each other when messages arrive faster than
 *    the LLM responds.
 */

import crypto from "node:crypto";
import type { ChannelManager, InboundMessage } from "./channel-manager.js";

export interface AutoReplyDeps {
  /** Channel manager to look up channels and send outbound replies. */
  channelManager: ChannelManager;
  /** Async function that turns an inbound user message into a reply.
   * In production this hits main-brain `/chat`; tests inject a stub. */
  chatFn: (params: { message: string; session_id: string; agent_id: string }) => Promise<{ reply: string }>;
  /** Default agent id to drive auto-replies. */
  defaultAgentId?: string;
}

/** Per-sender sticky session id. Sender strings can contain weird chars
 * (display names with spaces, emoji, etc.), so we hash to keep the id
 * URL-safe and bounded in length. */
function senderToSessionId(channelId: string, sender: string): string {
  const h = crypto.createHash("sha256").update(`${channelId}:${sender}`).digest("hex").slice(0, 12);
  return `ch-${channelId}-${h}`;
}

export class ChannelAutoReply {
  private inFlight = new Map<string, Promise<void>>();

  constructor(private deps: AutoReplyDeps) {}

  /** Public for tests; in production the handler is `handleInbound`. */
  static sessionId(channelId: string, sender: string): string {
    return senderToSessionId(channelId, sender);
  }

  /** Bound inbound handler — pass directly to
   * `channelManager.setInboundHandler(autoReply.handleInbound)`. */
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

    // Coalesce: if a previous reply for the same sender is still
    // in-flight, queue this one to start after it finishes. Without
    // this, two messages arriving 200ms apart would both spawn LLM
    // calls and produce out-of-order replies.
    const lockKey = `${channelId}:${message.sender}`;
    const previous = this.inFlight.get(lockKey) ?? Promise.resolve();
    const next = previous.then(() => this.runReply(channelId, message, content));
    this.inFlight.set(lockKey, next);

    next
      .catch((err) => {
        console.error(`[auto-reply] reply task failed for ${lockKey}:`, err);
      })
      .finally(() => {
        // Only clear if no newer task replaced us
        if (this.inFlight.get(lockKey) === next) {
          this.inFlight.delete(lockKey);
        }
      });
  };

  private async runReply(channelId: string, message: InboundMessage, content: string): Promise<void> {
    const sessionId = senderToSessionId(channelId, message.sender);
    const agentId = this.deps.defaultAgentId || "agent-default";

    let reply: string;
    try {
      const res = await this.deps.chatFn({ message: content, session_id: sessionId, agent_id: agentId });
      reply = (res?.reply || "").trim();
    } catch (err: any) {
      console.error(`[auto-reply] chatFn failed for ${channelId}:`, err?.message || err);
      return;
    }
    if (!reply) {
      // LLM produced nothing — don't waste a channel message slot
      return;
    }

    const recipient = message.reply_to || message.sender;
    try {
      const sendResult = await this.deps.channelManager.send(channelId, recipient, reply);
      if (!sendResult.ok) {
        console.error(`[auto-reply] send failed for ${channelId}:`, sendResult.error);
      }
    } catch (err: any) {
      console.error(`[auto-reply] send threw for ${channelId}:`, err?.message || err);
    }
  }
}
