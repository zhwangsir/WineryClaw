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
import { ChannelAutoReply } from "../src/channels/channel-auto-reply.js";
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
});
