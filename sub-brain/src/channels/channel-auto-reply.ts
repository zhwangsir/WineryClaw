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
import { evaluatePolicy } from "./channel-policy.js";

/** Per-channel rolling window of reply timestamps for rate-limit eval.
 * Bounded — we trim entries older than 1 hour on each evaluation. */
const recentReplyTimestamps = new Map<string, number[]>();

/** Audit ring buffer of recent policy decisions (last 200 per process)
 * for the /channels/:id/policy/audit endpoint. */
interface PolicyAuditEntry {
  ts: string;
  channelId: string;
  sender: string;
  contentPreview: string;
  allowed: boolean;
  reason: string;
  delayMs: number;
}
const policyAudit: PolicyAuditEntry[] = [];
const POLICY_AUDIT_MAX = 200;

/** Read-only access to recent policy decisions. Used by the
 * GET /channels/:id/policy/audit route. */
export function recentPolicyAudit(channelId?: string, limit = 50): PolicyAuditEntry[] {
  const all = channelId
    ? policyAudit.filter((e) => e.channelId === channelId)
    : policyAudit;
  return all.slice(-Math.max(1, Math.min(limit, POLICY_AUDIT_MAX))).reverse();
}

function pushPolicyAudit(entry: PolicyAuditEntry): void {
  policyAudit.push(entry);
  if (policyAudit.length > POLICY_AUDIT_MAX) {
    policyAudit.splice(0, policyAudit.length - POLICY_AUDIT_MAX);
  }
}

/** Exported for tests — reset the cross-instance audit + rate-limit state. */
export function _resetPolicyState(): void {
  policyAudit.length = 0;
  recentReplyTimestamps.clear();
}

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
    // v2.30 (M5.1): evaluate channel policy BEFORE calling chat engine.
    // A blocked message is still stored as inbound (already happened by
    // the time we get here), but consumes no LLM budget and produces no
    // outbound reply. The decision is recorded in the policy audit log.
    const policy = this.deps.channelManager.getPolicy(channelId);
    const recent = recentReplyTimestamps.get(channelId) ?? [];
    const decision = evaluatePolicy(policy, { sender: message.sender, content }, {
      recentReplyTimestamps: recent,
    });
    pushPolicyAudit({
      ts: new Date().toISOString(),
      channelId,
      sender: message.sender,
      contentPreview: content.slice(0, 120),
      allowed: decision.allow,
      reason: decision.reason,
      delayMs: decision.delayMs,
    });
    if (!decision.allow) {
      console.log(
        `[auto-reply] policy blocked ${channelId} from '${message.sender}': ${decision.reason}`
      );
      return;
    }

    // v2.37.1 — reserve the rate-limit slot AT decision-allow time, not
    // post-send. Previously we only pushed the timestamp after a successful
    // send(), which meant N concurrent inbound from different senders would
    // all see the same zero-count window and all slip through — the cap was
    // effectively a no-op under concurrency. Reserving up-front means a
    // failed chatFn/send "eats" a slot, but over-counting is safer than
    // under-counting for an outbound budget guard.
    const now = Date.now();
    const cutoff = now - 3_600_000;
    const trimmed = recent.filter((t) => t >= cutoff);
    trimmed.push(now);
    recentReplyTimestamps.set(channelId, trimmed);

    // Honor policy-mandated reply delay (human-like pacing).
    if (decision.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, decision.delayMs));
    }

    const sessionId = senderToSessionId(channelId, message.sender);
    // Policy.agentId overrides the dependency default — per-channel agent.
    const agentId = decision.agentId || this.deps.defaultAgentId || "agent-default";

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
        return;
      }
      // Rate-limit slot was already reserved at decision-allow time above;
      // a failed send consumes the slot (conservative over-count).
    } catch (err: any) {
      console.error(`[auto-reply] send threw for ${channelId}:`, err?.message || err);
    }
  }
}
