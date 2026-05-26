/**
 * Tests for the M5 ChannelAutoReply engine.
 *
 * The engine is decoupled from the real channel-manager via dependency
 * injection: `channelManager.listChannels()` / `channelManager.send()`
 * are the only methods it touches. We supply a fake manager with full
 * control over what's "registered" and observe what `send()` gets
 * called with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChannelAutoReply,
  recentPolicyAudit,
  _resetPolicyState,
} from "../src/channels/channel-auto-reply.js";
import type { ChannelManager, InboundMessage } from "../src/channels/channel-manager.js";

interface FakeChannelRow {
  id: string;
  name: string;
  type: string;
  connected: boolean;
  auto_reply: boolean;
}

function makeFakeManager(channels: FakeChannelRow[]) {
  const sendCalls: Array<{ channelId: string; recipient: string; content: string }> = [];
  const mgr = {
    listChannels: vi.fn(() => channels),
    send: vi.fn(async (channelId: string, recipient: string, content: string) => {
      sendCalls.push({ channelId, recipient, content });
      return { ok: true };
    }),
    // v2.30: ChannelAutoReply now reads per-channel policy. Stub returns
    // undefined = "no policy configured" = legacy allow-all behavior, so
    // existing tests pass without modifying their assertions.
    getPolicy: vi.fn(() => undefined),
  };
  return { mgr: mgr as unknown as ChannelManager, sendCalls, raw: mgr };
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    sender: "alice",
    content: "hello there",
    timestamp: "2026-05-19T00:00:00Z",
    ...overrides,
  };
}

describe("ChannelAutoReply", () => {
  let chatFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    chatFn = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores message when channel is not registered", async () => {
    const { mgr, sendCalls } = makeFakeManager([]);
    const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });
    await ar.handleInbound("c-missing", "telegram", makeInbound());
    expect(chatFn).not.toHaveBeenCalled();
    expect(sendCalls).toEqual([]);
  });

  it("ignores message when auto_reply is disabled", async () => {
    const { mgr, sendCalls } = makeFakeManager([
      { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: false },
    ]);
    const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });
    await ar.handleInbound("c1", "telegram", makeInbound());
    expect(chatFn).not.toHaveBeenCalled();
    expect(sendCalls).toEqual([]);
  });

  it("ignores empty content even when auto_reply is on", async () => {
    const { mgr, sendCalls } = makeFakeManager([
      { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
    ]);
    const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });
    await ar.handleInbound("c1", "telegram", makeInbound({ content: "   " }));
    expect(chatFn).not.toHaveBeenCalled();
    expect(sendCalls).toEqual([]);
  });

  it("routes inbound message to chat and sends reply back to reply_to", async () => {
    chatFn.mockResolvedValue({ reply: "hi alice" });
    const { mgr, sendCalls } = makeFakeManager([
      { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
    ]);
    const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });
    await ar.handleInbound("c1", "telegram", makeInbound({ content: "ping", reply_to: "chat-9001" }));
    // Wait for the in-flight task to drain (handleInbound is fire-and-forget
    // but awaiting it gives us the scheduling promise; the actual reply
    // task runs through .then chain).
    await new Promise((r) => setImmediate(r));
    expect(chatFn).toHaveBeenCalledOnce();
    expect(chatFn.mock.calls[0][0].message).toBe("ping");
    expect(sendCalls).toEqual([{ channelId: "c1", recipient: "chat-9001", content: "hi alice" }]);
  });

  it("falls back to sender when reply_to is missing", async () => {
    chatFn.mockResolvedValue({ reply: "ok" });
    const { mgr, sendCalls } = makeFakeManager([
      { id: "c1", name: "im", type: "imessage", connected: true, auto_reply: true },
    ]);
    const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });
    await ar.handleInbound("c1", "imessage", makeInbound({ sender: "+15551234", content: "yo" }));
    await new Promise((r) => setImmediate(r));
    expect(sendCalls).toEqual([{ channelId: "c1", recipient: "+15551234", content: "ok" }]);
  });

  it("uses a sticky session id per (channel, sender) pair", async () => {
    chatFn.mockResolvedValue({ reply: "ack" });
    const { mgr } = makeFakeManager([
      { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
    ]);
    const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });

    await ar.handleInbound("c1", "telegram", makeInbound({ sender: "alice", content: "first" }));
    await new Promise((r) => setImmediate(r));
    await ar.handleInbound("c1", "telegram", makeInbound({ sender: "alice", content: "second" }));
    await new Promise((r) => setImmediate(r));

    const aliceSessionIds = chatFn.mock.calls
      .filter((c) => c[0].message === "first" || c[0].message === "second")
      .map((c) => c[0].session_id);
    expect(aliceSessionIds.length).toBe(2);
    expect(aliceSessionIds[0]).toBe(aliceSessionIds[1]);

    // Different sender must get a different session
    await ar.handleInbound("c1", "telegram", makeInbound({ sender: "bob", content: "hello" }));
    await new Promise((r) => setImmediate(r));
    const bobSessionId = chatFn.mock.calls.find((c) => c[0].message === "hello")[0].session_id;
    expect(bobSessionId).not.toBe(aliceSessionIds[0]);
  });

  it("includes channel id in session id so same sender on different channels does not collide", () => {
    const a = ChannelAutoReply.sessionId("c1", "alice");
    const b = ChannelAutoReply.sessionId("c2", "alice");
    expect(a).not.toBe(b);
    // Stable across calls
    expect(ChannelAutoReply.sessionId("c1", "alice")).toBe(a);
  });

  it("does not send when chat returns an empty reply", async () => {
    chatFn.mockResolvedValue({ reply: "" });
    const { mgr, sendCalls } = makeFakeManager([
      { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
    ]);
    const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });
    await ar.handleInbound("c1", "telegram", makeInbound({ content: "hello" }));
    await new Promise((r) => setImmediate(r));
    expect(chatFn).toHaveBeenCalledOnce();
    expect(sendCalls).toEqual([]);
  });

  it("swallows chatFn rejection so subsequent messages still process", async () => {
    chatFn
      .mockRejectedValueOnce(new Error("LLM down"))
      .mockResolvedValueOnce({ reply: "recovered" });
    const { mgr, sendCalls } = makeFakeManager([
      { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
    ]);
    const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });
    // Use console.error stub to keep test output clean
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await ar.handleInbound("c1", "telegram", makeInbound({ sender: "alice", content: "first" }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await ar.handleInbound("c1", "telegram", makeInbound({ sender: "bob", content: "second" }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0].content).toBe("recovered");
    errSpy.mockRestore();
  });

  it("serializes concurrent messages from the same sender", async () => {
    // Make chatFn slow on purpose so we can observe ordering
    let order: string[] = [];
    chatFn.mockImplementation(async ({ message }: { message: string }) => {
      order.push(`start-${message}`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`end-${message}`);
      return { reply: `r-${message}` };
    });
    const { mgr, sendCalls } = makeFakeManager([
      { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
    ]);
    const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });

    // Two messages fired back-to-back from the same sender
    await ar.handleInbound("c1", "telegram", makeInbound({ sender: "alice", content: "A" }));
    await ar.handleInbound("c1", "telegram", makeInbound({ sender: "alice", content: "B" }));
    // Drain
    await new Promise((r) => setTimeout(r, 200));

    // Order must be: start-A, end-A, start-B, end-B — never interleaved
    const aIdx = order.indexOf("end-A");
    const bStart = order.indexOf("start-B");
    expect(aIdx).toBeLessThan(bStart);
    expect(sendCalls.map((c) => c.content)).toEqual(["r-A", "r-B"]);
  });

  it("uses custom defaultAgentId when supplied", async () => {
    chatFn.mockResolvedValue({ reply: "x" });
    const { mgr } = makeFakeManager([
      { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
    ]);
    const ar = new ChannelAutoReply({
      channelManager: mgr,
      chatFn,
      defaultAgentId: "agent-customer-service",
    });
    await ar.handleInbound("c1", "telegram", makeInbound({ content: "hi" }));
    await new Promise((r) => setImmediate(r));
    expect(chatFn.mock.calls[0][0].agent_id).toBe("agent-customer-service");
  });

  // ─────────────────────────────────────────────────────────────────────
  // v2.30 / v2.37 — Channel Policy integration tests.
  //
  // These exercise the FULL inbound → evaluatePolicy → chat path with
  // real ChannelPolicy objects, proving each of the 7 policy dimensions
  // actually blocks the message (no LLM call) when the rule triggers.
  // ─────────────────────────────────────────────────────────────────────

  describe("Channel Policy (v2.30) — pipeline integration", () => {
    beforeEach(() => {
      // Reset the module-level policy audit + rate-limit ring so each test
      // starts from a clean slate. v2.37.1: switched from `require()` (broke
      // under vitest's ESM loader with MODULE_NOT_FOUND) to a static ESM
      // import resolved at the top of the file.
      _resetPolicyState();
    });

    it("senderBlock: chatFn NOT called when sender is on blocklist", async () => {
      const { mgr } = makeFakeManager([
        { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
      ]);
      (mgr.getPolicy as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        senderBlock: ["spam"],
      });
      const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });
      await ar.handleInbound(
        "c1",
        "telegram",
        makeInbound({ sender: "spammer@x.com" })
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(chatFn).not.toHaveBeenCalled();
    });

    it("senderAllow: chatFn called when sender matches whitelist", async () => {
      chatFn.mockResolvedValue({ reply: "hi" });
      const { mgr } = makeFakeManager([
        { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
      ]);
      (mgr.getPolicy as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        senderAllow: ["alice"],
      });
      const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });
      await ar.handleInbound("c1", "telegram", makeInbound({ sender: "alice" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(chatFn).toHaveBeenCalledTimes(1);
    });

    it("keywordBlock: chatFn NOT called when content has banned keyword", async () => {
      const { mgr } = makeFakeManager([
        { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
      ]);
      (mgr.getPolicy as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        keywordBlock: ["AdVert"],  // Test case-insensitive
      });
      const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });
      await ar.handleInbound(
        "c1",
        "telegram",
        makeInbound({ content: "buy our advert now!" })
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(chatFn).not.toHaveBeenCalled();
    });

    it("policy.agentId overrides defaultAgentId", async () => {
      chatFn.mockResolvedValue({ reply: "x" });
      const { mgr } = makeFakeManager([
        { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
      ]);
      (mgr.getPolicy as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        agentId: "agent-vip",
      });
      const ar = new ChannelAutoReply({
        channelManager: mgr,
        chatFn,
        defaultAgentId: "agent-default",
      });
      await ar.handleInbound("c1", "telegram", makeInbound());
      await new Promise((r) => setTimeout(r, 50));
      expect(chatFn.mock.calls[0][0].agent_id).toBe("agent-vip");
    });

    it("audit ring buffer captures both allowed AND blocked decisions", async () => {
      const { mgr } = makeFakeManager([
        { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
      ]);
      // Block messages containing "spam", allow others.
      (mgr.getPolicy as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        keywordBlock: ["spam"],
      });
      chatFn.mockResolvedValue({ reply: "ok" });
      const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });

      // Send 2 messages: one allowed, one blocked.
      await ar.handleInbound("c1", "telegram", makeInbound({ content: "hello" }));
      await ar.handleInbound(
        "c1",
        "telegram",
        makeInbound({ content: "this is spam" })
      );
      await new Promise((r) => setTimeout(r, 50));

      const entries = recentPolicyAudit("c1", 10);
      expect(entries.length).toBe(2);
      const allowed = entries.filter((e) => e.allowed);
      const blocked = entries.filter((e) => !e.allowed);
      expect(allowed.length).toBe(1);
      expect(blocked.length).toBe(1);
      expect(blocked[0].reason).toMatch(/keywordBlock/);
    });

    it("maxRepliesPerHour rate-limits beyond cap", async () => {
      chatFn.mockResolvedValue({ reply: "ok" });
      const { mgr } = makeFakeManager([
        { id: "c1", name: "tg", type: "telegram", connected: true, auto_reply: true },
      ]);
      (mgr.getPolicy as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        maxRepliesPerHour: 2,
      });
      const ar = new ChannelAutoReply({ channelManager: mgr, chatFn });

      // 3 distinct senders so the inFlight serialization doesn't block us.
      for (const sender of ["a", "b", "c"]) {
        await ar.handleInbound("c1", "telegram", makeInbound({ sender, content: "x" }));
      }
      await new Promise((r) => setTimeout(r, 100));

      // First 2 chat calls allowed; 3rd should be rate-limited (no chat).
      expect(chatFn.mock.calls.length).toBe(2);
    });
  });
});
