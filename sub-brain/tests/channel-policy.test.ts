/**
 * v2.30 — ChannelPolicy unit tests (ROADMAP V2 P0 #2 / M5.1).
 *
 * Covers:
 *   - validatePolicy: shape rejection, sanitization, time-window parsing
 *   - evaluatePolicy: senderBlock/Allow, keywordBlock/Allow, time windows,
 *     rate limiting, replyDelay, agentId override, empty policy = allow
 */

import { describe, it, expect } from "vitest";
import {
  validatePolicy,
  evaluatePolicy,
  type ChannelPolicy,
} from "../src/channels/channel-policy.js";

describe("validatePolicy", () => {
  it("rejects non-object input", () => {
    expect(validatePolicy(null).ok).toBe(false);
    expect(validatePolicy("hello").ok).toBe(false);
    expect(validatePolicy(42).ok).toBe(false);
  });

  it("accepts empty object", () => {
    const r = validatePolicy({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy).toEqual({});
  });

  it("trims and drops empty strings from sender/keyword arrays", () => {
    const r = validatePolicy({
      senderBlock: ["spam@x.com", "  ", "   evil  "],
      keywordAllow: ["", "urgent"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.senderBlock).toEqual(["spam@x.com", "evil"]);
      expect(r.policy.keywordAllow).toEqual(["urgent"]);
    }
  });

  it("rejects non-string entries in sender/keyword arrays as filtered", () => {
    const r = validatePolicy({ senderBlock: ["ok", 42, null, "again"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy.senderBlock).toEqual(["ok", "again"]);
  });

  it("validates HH:MM time-window strings", () => {
    expect(validatePolicy({ timeWindows: [{ start: "09:00", end: "18:00" }] }).ok).toBe(true);
    expect(validatePolicy({ timeWindows: [{ start: "9:00", end: "18:00" }] }).ok).toBe(true);
    expect(validatePolicy({ timeWindows: [{ start: "24:00", end: "18:00" }] }).ok).toBe(false);
    expect(validatePolicy({ timeWindows: [{ start: "abc", end: "18:00" }] }).ok).toBe(false);
    expect(validatePolicy({ timeWindows: [{ start: "09:60", end: "18:00" }] }).ok).toBe(false);
  });

  it("coerces maxRepliesPerHour to non-negative int", () => {
    const r = validatePolicy({ maxRepliesPerHour: 3.7 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy.maxRepliesPerHour).toBe(3);
    expect(validatePolicy({ maxRepliesPerHour: -5 }).ok).toBe(true);
    const neg = validatePolicy({ maxRepliesPerHour: -5 });
    if (neg.ok) expect(neg.policy.maxRepliesPerHour).toBe(0);
    expect(validatePolicy({ maxRepliesPerHour: Infinity }).ok).toBe(false);
  });

  it("requires replyDelay.minMs <= maxMs", () => {
    expect(validatePolicy({ replyDelay: { minMs: 100, maxMs: 500 } }).ok).toBe(true);
    expect(validatePolicy({ replyDelay: { minMs: 500, maxMs: 100 } }).ok).toBe(false);
    expect(validatePolicy({ replyDelay: { minMs: -1, maxMs: 100 } }).ok).toBe(true); // coerced to 0
    expect(validatePolicy({ replyDelay: { minMs: 100 } }).ok).toBe(false); // missing maxMs
  });

  it("trims agentId and treats empty as undefined", () => {
    const r = validatePolicy({ agentId: "  agent-x  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy.agentId).toBe("agent-x");
    const e = validatePolicy({ agentId: "   " });
    if (e.ok) expect(e.policy.agentId).toBeUndefined();
  });

  it("rejects non-string agentId", () => {
    expect(validatePolicy({ agentId: 42 }).ok).toBe(false);
  });
});

describe("evaluatePolicy", () => {
  const baseMsg = { sender: "alice@example.com", content: "hello world" };
  // Pin a deterministic clock at 14:30 local time so time-window tests
  // are stable across CI timezones.
  const now = new Date();
  now.setHours(14, 30, 0, 0);

  it("returns allow when no policy is configured", () => {
    const d = evaluatePolicy(undefined, baseMsg, { now });
    expect(d.allow).toBe(true);
    expect(d.delayMs).toBe(0);
  });

  it("returns allow on empty policy object", () => {
    const d = evaluatePolicy({}, baseMsg, { now });
    expect(d.allow).toBe(true);
  });

  it("blocks senderBlock match (case-insensitive substring)", () => {
    const p: ChannelPolicy = { senderBlock: ["EXAMPLE.COM"] };
    const d = evaluatePolicy(p, baseMsg, { now });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/senderBlock/);
  });

  it("blocks when senderAllow set and sender doesn't match", () => {
    const p: ChannelPolicy = { senderAllow: ["bob"] };
    const d = evaluatePolicy(p, baseMsg, { now });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/whitelist/);
  });

  it("allows when senderAllow matches", () => {
    const p: ChannelPolicy = { senderAllow: ["alice"] };
    const d = evaluatePolicy(p, baseMsg, { now });
    expect(d.allow).toBe(true);
  });

  it("senderBlock beats senderAllow (early exit)", () => {
    const p: ChannelPolicy = { senderAllow: ["alice"], senderBlock: ["alice"] };
    const d = evaluatePolicy(p, baseMsg, { now });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/senderBlock/);
  });

  it("blocks keywordBlock match in content (case-insensitive)", () => {
    const p: ChannelPolicy = { keywordBlock: ["WORLD"] };
    const d = evaluatePolicy(p, baseMsg, { now });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/keywordBlock/);
  });

  it("blocks when keywordAllow set but no match", () => {
    const p: ChannelPolicy = { keywordAllow: ["urgent"] };
    const d = evaluatePolicy(p, baseMsg, { now });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/keywordAllow/);
  });

  it("allows when keywordAllow matches one entry", () => {
    const p: ChannelPolicy = { keywordAllow: ["hello", "urgent"] };
    const d = evaluatePolicy(p, baseMsg, { now });
    expect(d.allow).toBe(true);
  });

  it("blocks when outside all time windows", () => {
    // now = 14:30; only window is 22:00-06:00 (overnight) — should block.
    const overnight: ChannelPolicy = { timeWindows: [{ start: "22:00", end: "06:00" }] };
    const d = evaluatePolicy(overnight, baseMsg, { now });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/timeWindows/);
  });

  it("allows when inside a normal time window", () => {
    const work: ChannelPolicy = { timeWindows: [{ start: "09:00", end: "18:00" }] };
    const d = evaluatePolicy(work, baseMsg, { now });
    expect(d.allow).toBe(true);
  });

  it("allows when inside an overnight window (start > end)", () => {
    const lateNight = new Date();
    lateNight.setHours(23, 30, 0, 0);
    const p: ChannelPolicy = { timeWindows: [{ start: "22:00", end: "06:00" }] };
    expect(evaluatePolicy(p, baseMsg, { now: lateNight }).allow).toBe(true);

    const earlyMorning = new Date();
    earlyMorning.setHours(3, 0, 0, 0);
    expect(evaluatePolicy(p, baseMsg, { now: earlyMorning }).allow).toBe(true);

    const mid = new Date();
    mid.setHours(12, 0, 0, 0);
    expect(evaluatePolicy(p, baseMsg, { now: mid }).allow).toBe(false);
  });

  it("allows if ANY of multiple time windows match", () => {
    const p: ChannelPolicy = {
      timeWindows: [
        { start: "06:00", end: "09:00" },
        { start: "14:00", end: "15:00" }, // matches 14:30
      ],
    };
    const d = evaluatePolicy(p, baseMsg, { now });
    expect(d.allow).toBe(true);
  });

  it("rate limits when recent replies reach maxRepliesPerHour", () => {
    const p: ChannelPolicy = { maxRepliesPerHour: 3 };
    const t = now.getTime();
    const recent = [t - 10_000, t - 20_000, t - 30_000];
    const d = evaluatePolicy(p, baseMsg, { now, recentReplyTimestamps: recent });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/rate limit/);
  });

  it("rate-limit ignores stale timestamps > 1h old", () => {
    const p: ChannelPolicy = { maxRepliesPerHour: 3 };
    const t = now.getTime();
    const recent = [t - 4_000_000, t - 3_700_000, t - 3_600_001];
    const d = evaluatePolicy(p, baseMsg, { now, recentReplyTimestamps: recent });
    expect(d.allow).toBe(true);
  });

  it("emits delayMs within [minMs, maxMs] when replyDelay is set", () => {
    const p: ChannelPolicy = { replyDelay: { minMs: 100, maxMs: 500 } };
    // Deterministic RNG to pin the result.
    const d = evaluatePolicy(p, baseMsg, { now, rng: () => 0.5 });
    expect(d.allow).toBe(true);
    expect(d.delayMs).toBeGreaterThanOrEqual(100);
    expect(d.delayMs).toBeLessThanOrEqual(500);
  });

  it("replyDelay edge case: minMs == maxMs returns exact value", () => {
    const p: ChannelPolicy = { replyDelay: { minMs: 200, maxMs: 200 } };
    const d = evaluatePolicy(p, baseMsg, { now });
    expect(d.delayMs).toBe(200);
  });

  it("passes through agentId on both allow and block decisions", () => {
    const p: ChannelPolicy = { agentId: "agent-vip", senderBlock: ["alice"] };
    expect(evaluatePolicy(p, baseMsg, { now }).agentId).toBe("agent-vip");
    const ok: ChannelPolicy = { agentId: "agent-other" };
    expect(evaluatePolicy(ok, baseMsg, { now }).agentId).toBe("agent-other");
  });
});
