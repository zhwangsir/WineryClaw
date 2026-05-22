/**
 * Channel Policy — v2.30 (ROADMAP V2 P0 #2 / M5.1).
 *
 * Per-channel rules that gate which inbound messages trigger auto-reply.
 * Applied BEFORE chat_engine is called, so a blocked message:
 *   - is still stored as an inbound row (audit trail preserved)
 *   - is NOT sent to the LLM
 *   - does NOT generate an outbound reply
 *
 * Policy fields are all optional — missing means "no constraint". An
 * empty policy (`{}`) is equivalent to "allow everything", matching the
 * pre-v2.30 behavior so legacy channels keep working unchanged.
 *
 * Storage: serialized JSON in the `channels.policy` column (added by
 * migration in channel-manager.initialize). All policy mutations go
 * through `channelManager.setPolicy()` so the cache + DB stay in sync.
 *
 * Decision flow (evaluatePolicy):
 *   1. senderBlock → block immediately ("sender blacklisted")
 *   2. senderAllow non-empty → must match (else "sender not whitelisted")
 *   3. keywordBlock → if message contains ANY block word → block
 *   4. keywordAllow non-empty → message must contain ONE → else block
 *   5. timeWindows non-empty → now must fall in one window → else block
 *   6. maxRepliesPerHour exceeded → block ("rate limited")
 *   7. otherwise allow; compute delayMs in [replyDelay.minMs, maxMs]
 */

export interface TimeWindow {
  /** "HH:MM" 24-hour local time, e.g. "09:00". */
  start: string;
  /** "HH:MM" 24-hour local time, e.g. "18:00". */
  end: string;
  /** Optional IANA timezone (e.g. "Asia/Shanghai"). Defaults to system tz.
   * Implementation note: full IANA evaluation requires Intl.DateTimeFormat;
   * v2.30 ships with "system tz" only. If tz is set we log a warning and
   * still evaluate in system tz — the field is reserved for future use. */
  tz?: string;
}

export interface ReplyDelay {
  /** Inclusive minimum delay before sending the reply, in milliseconds. */
  minMs: number;
  /** Inclusive maximum delay before sending the reply, in milliseconds. */
  maxMs: number;
}

export interface ChannelPolicy {
  /** Which agent handles this channel's replies. Overrides AutoReplyDeps
   * `defaultAgentId`. Empty / undefined → fall back to default. */
  agentId?: string;

  /** Block these senders outright (substring match, case-insensitive). */
  senderBlock?: string[];

  /** If non-empty, only these senders trigger reply (substring match,
   * case-insensitive). Empty / undefined → no whitelist (allow all). */
  senderAllow?: string[];

  /** Block messages whose content contains any of these substrings
   * (case-insensitive). */
  keywordBlock?: string[];

  /** If non-empty, only messages containing at least one of these
   * substrings trigger reply (case-insensitive). */
  keywordAllow?: string[];

  /** Active hours. Outside any listed window → block. Empty / undefined
   * → 24/7. Multiple windows OR together (e.g. work hours + weekends). */
  timeWindows?: TimeWindow[];

  /** Cap how many auto-replies this channel can send per rolling hour.
   * 0 / undefined → no cap. */
  maxRepliesPerHour?: number;

  /** Randomize delay before sending reply for human-like cadence.
   * Undefined → no artificial delay. */
  replyDelay?: ReplyDelay;
}

export interface PolicyDecision {
  /** Was the message allowed through? */
  allow: boolean;
  /** Human-readable reason — populated whether allow=true ("ok") or
   * allow=false ("sender blacklisted"). Stored in the audit ledger. */
  reason: string;
  /** Delay before sending the reply (ms). 0 unless replyDelay is set
   * and the message is allowed. */
  delayMs: number;
  /** Which agent should handle this channel — falls back to caller's
   * default if `policy.agentId` was unset. */
  agentId?: string;
}

/** "HH:MM" → minutes since midnight; -1 on invalid input. */
function parseHHMM(s: string): number {
  if (typeof s !== "string") return -1;
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(s.trim());
  if (!m) return -1;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h > 23) return -1;
  return h * 60 + mm;
}

function nowMinutesInDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

function isInWindow(window: TimeWindow, now: Date): boolean {
  const startMin = parseHHMM(window.start);
  const endMin = parseHHMM(window.end);
  if (startMin < 0 || endMin < 0) return false;
  const nowMin = nowMinutesInDay(now);
  if (startMin <= endMin) {
    // Normal range (09:00..18:00)
    return nowMin >= startMin && nowMin <= endMin;
  }
  // Overnight range (22:00..06:00): now is in [start, 23:59] OR [00:00, end]
  return nowMin >= startMin || nowMin <= endMin;
}

/**
 * Validate a policy object. Returns the sanitized policy on success or
 * an error string on failure. Caller (HTTP route) should surface the
 * error as 400 Bad Request.
 *
 * Sanitization:
 *  - Strings trimmed.
 *  - Arrays of strings filter out empty entries.
 *  - Time-window strings validated as HH:MM.
 *  - maxRepliesPerHour coerced to non-negative int.
 *  - replyDelay: minMs <= maxMs both non-negative.
 */
export function validatePolicy(
  raw: unknown
): { ok: true; policy: ChannelPolicy } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "policy must be an object" };
  }
  const r = raw as Record<string, unknown>;
  const out: ChannelPolicy = {};

  if (r.agentId !== undefined) {
    if (typeof r.agentId !== "string") return { ok: false, error: "agentId must be string" };
    out.agentId = r.agentId.trim() || undefined;
  }

  const stringArrayField = (
    key: "senderBlock" | "senderAllow" | "keywordBlock" | "keywordAllow"
  ): string | null => {
    const v = r[key];
    if (v === undefined) return null;
    if (!Array.isArray(v)) return `${key} must be an array of strings`;
    const arr = v
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    out[key] = arr;
    return null;
  };
  for (const key of ["senderBlock", "senderAllow", "keywordBlock", "keywordAllow"] as const) {
    const err = stringArrayField(key);
    if (err) return { ok: false, error: err };
  }

  if (r.timeWindows !== undefined) {
    if (!Array.isArray(r.timeWindows)) {
      return { ok: false, error: "timeWindows must be an array" };
    }
    const tws: TimeWindow[] = [];
    for (const w of r.timeWindows) {
      if (!w || typeof w !== "object") {
        return { ok: false, error: "timeWindow entries must be objects" };
      }
      const ww = w as Record<string, unknown>;
      if (typeof ww.start !== "string" || typeof ww.end !== "string") {
        return { ok: false, error: "timeWindow.start/end must be HH:MM strings" };
      }
      if (parseHHMM(ww.start) < 0 || parseHHMM(ww.end) < 0) {
        return { ok: false, error: "timeWindow.start/end must be valid HH:MM" };
      }
      const tw: TimeWindow = { start: ww.start, end: ww.end };
      if (typeof ww.tz === "string" && ww.tz.trim()) tw.tz = ww.tz.trim();
      tws.push(tw);
    }
    out.timeWindows = tws;
  }

  if (r.maxRepliesPerHour !== undefined) {
    if (typeof r.maxRepliesPerHour !== "number" || !Number.isFinite(r.maxRepliesPerHour)) {
      return { ok: false, error: "maxRepliesPerHour must be a finite number" };
    }
    out.maxRepliesPerHour = Math.max(0, Math.floor(r.maxRepliesPerHour));
  }

  if (r.replyDelay !== undefined) {
    if (r.replyDelay === null || typeof r.replyDelay !== "object") {
      return { ok: false, error: "replyDelay must be an object" };
    }
    const rd = r.replyDelay as Record<string, unknown>;
    if (typeof rd.minMs !== "number" || typeof rd.maxMs !== "number") {
      return { ok: false, error: "replyDelay.{minMs,maxMs} must be numbers" };
    }
    const minMs = Math.max(0, Math.floor(rd.minMs));
    const maxMs = Math.max(0, Math.floor(rd.maxMs));
    if (minMs > maxMs) {
      return { ok: false, error: "replyDelay.minMs must be <= maxMs" };
    }
    out.replyDelay = { minMs, maxMs };
  }

  return { ok: true, policy: out };
}

/**
 * Evaluate a policy against an inbound message. Pure function — no I/O.
 * `recentReplyTimestamps` is the caller-tracked sliding window of when
 * this channel sent replies in the last hour, used for rate limiting.
 *
 * Returns `PolicyDecision` with allow / reason / delayMs / agentId.
 */
export function evaluatePolicy(
  policy: ChannelPolicy | undefined | null,
  message: { sender: string; content: string },
  options: {
    now?: Date;
    recentReplyTimestamps?: number[];
    rng?: () => number;
  } = {}
): PolicyDecision {
  const now = options.now ?? new Date();
  const rng = options.rng ?? Math.random;

  if (!policy || typeof policy !== "object") {
    return { allow: true, reason: "no policy configured", delayMs: 0 };
  }

  const senderLower = (message.sender || "").toLowerCase();
  const contentLower = (message.content || "").toLowerCase();

  // 1. senderBlock — earliest exit
  if (policy.senderBlock && policy.senderBlock.length > 0) {
    for (const banned of policy.senderBlock) {
      if (senderLower.includes(banned.toLowerCase())) {
        return {
          allow: false,
          reason: `sender '${message.sender}' blocked by senderBlock`,
          delayMs: 0,
          agentId: policy.agentId,
        };
      }
    }
  }

  // 2. senderAllow — if list non-empty, must match
  if (policy.senderAllow && policy.senderAllow.length > 0) {
    let ok = false;
    for (const allowed of policy.senderAllow) {
      if (senderLower.includes(allowed.toLowerCase())) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      return {
        allow: false,
        reason: `sender '${message.sender}' not in senderAllow whitelist`,
        delayMs: 0,
        agentId: policy.agentId,
      };
    }
  }

  // 3. keywordBlock
  if (policy.keywordBlock && policy.keywordBlock.length > 0) {
    for (const bad of policy.keywordBlock) {
      if (contentLower.includes(bad.toLowerCase())) {
        return {
          allow: false,
          reason: `content matched keywordBlock entry '${bad}'`,
          delayMs: 0,
          agentId: policy.agentId,
        };
      }
    }
  }

  // 4. keywordAllow
  if (policy.keywordAllow && policy.keywordAllow.length > 0) {
    let ok = false;
    for (const good of policy.keywordAllow) {
      if (contentLower.includes(good.toLowerCase())) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      return {
        allow: false,
        reason: "content matched none of keywordAllow",
        delayMs: 0,
        agentId: policy.agentId,
      };
    }
  }

  // 5. timeWindows
  if (policy.timeWindows && policy.timeWindows.length > 0) {
    let inAny = false;
    for (const w of policy.timeWindows) {
      if (isInWindow(w, now)) {
        inAny = true;
        break;
      }
    }
    if (!inAny) {
      return {
        allow: false,
        reason: "outside configured timeWindows",
        delayMs: 0,
        agentId: policy.agentId,
      };
    }
  }

  // 6. rate limit
  if (policy.maxRepliesPerHour && policy.maxRepliesPerHour > 0) {
    const cutoff = now.getTime() - 3_600_000;
    const recent = (options.recentReplyTimestamps ?? []).filter((t) => t >= cutoff);
    if (recent.length >= policy.maxRepliesPerHour) {
      return {
        allow: false,
        reason: `rate limit reached (${recent.length}/${policy.maxRepliesPerHour} in last hour)`,
        delayMs: 0,
        agentId: policy.agentId,
      };
    }
  }

  // 7. allow + compute delay
  let delayMs = 0;
  if (policy.replyDelay) {
    const { minMs, maxMs } = policy.replyDelay;
    if (maxMs > minMs) {
      delayMs = Math.floor(minMs + rng() * (maxMs - minMs + 1));
    } else {
      delayMs = minMs;
    }
  }
  return {
    allow: true,
    reason: "ok",
    delayMs,
    agentId: policy.agentId,
  };
}
