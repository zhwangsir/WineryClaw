import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerChannelsRoutes } from "../src/server/channels-routes.js";
import type { ChannelManager } from "../src/channels/channel-manager.js";

interface FakeChannel {
  id: string;
  type: string;
  enabled: boolean;
  messages: Array<{ from: string; content: string }>;
  receiving: boolean;
}

function makeFakeChannelManager() {
  const channels = new Map<string, FakeChannel>();

  const mgr = {
    connect: vi.fn(async (type: string, _config: Record<string, unknown>) => {
      const id = `c-${channels.size + 1}`;
      channels.set(id, { id, type, enabled: true, messages: [], receiving: false });
      return { ok: true, channel_id: id };
    }),
    send: vi.fn(async (_type: string, _recipient: string, _content: string) => ({ ok: true, sent: true })),
    disconnect: vi.fn(async (id: string) => {
      const ok = channels.delete(id);
      return ok ? { ok: true } : { ok: false, error: "not found" };
    }),
    listChannels: vi.fn(() => Array.from(channels.values())),
    healthCheck: vi.fn(async (id: string) => channels.has(id)),
    getMessages: vi.fn((id: string) => channels.get(id)?.messages ?? []),
    startReceiving: vi.fn(async (id: string) => {
      const c = channels.get(id);
      if (!c) return { ok: false, error: "not found" };
      c.receiving = true;
      return { ok: true };
    }),
    stopReceiving: vi.fn(async (id: string) => {
      const c = channels.get(id);
      if (!c) return { ok: false, error: "not found" };
      c.receiving = false;
      return { ok: true };
    }),
    toggle: vi.fn(async (id: string) => {
      const c = channels.get(id);
      if (!c) return { ok: false, error: "not found" };
      c.enabled = !c.enabled;
      return { ok: true, enabled: c.enabled };
    }),
    deleteChannel: vi.fn(async (id: string) => {
      const ok = channels.delete(id);
      return ok ? { ok: true } : { ok: false, error: "not found" };
    }),
    // M5 — auto-reply state per channel
    setAutoReply: vi.fn(async (id: string, enabled: boolean) => {
      const c = channels.get(id);
      if (!c) return { ok: false, error: "not found" };
      (c as any).auto_reply = enabled;
      return { ok: true, auto_reply: enabled };
    }),
    getAutoReply: vi.fn((id: string) => Boolean((channels.get(id) as any)?.auto_reply)),
  };

  return { mgr, channels };
}

describe("channels routes", () => {
  let app: FastifyInstance;
  let mgr: ReturnType<typeof makeFakeChannelManager>["mgr"];

  beforeEach(async () => {
    const fake = makeFakeChannelManager();
    mgr = fake.mgr;
    app = Fastify();
    registerChannelsRoutes(app, { channelManager: mgr as unknown as ChannelManager });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /channels/connect delegates and returns ok", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/channels/connect",
      payload: { channel: "telegram", config: { token: "t" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, channel_id: "c-1" });
    expect(mgr.connect).toHaveBeenCalledWith("telegram", { token: "t" });
  });

  it("POST /channels/connect maps throws to 500", async () => {
    mgr.connect.mockRejectedValueOnce(new Error("token rejected"));
    const res = await app.inject({
      method: "POST",
      url: "/channels/connect",
      payload: { channel: "telegram" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("token rejected");
  });

  it("POST /channels/send forwards channel/recipient/content", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/channels/send",
      payload: { channel: "telegram", recipient: "@user", content: "hi" },
    });
    expect(res.json().ok).toBe(true);
    expect(mgr.send).toHaveBeenCalledWith("telegram", "@user", "hi");
  });

  it("POST /channels/disconnect forwards channel_id", async () => {
    await app.inject({
      method: "POST",
      url: "/channels/connect",
      payload: { channel: "telegram" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/channels/disconnect",
      payload: { channel_id: "c-1" },
    });
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /channels returns list", async () => {
    await app.inject({ method: "POST", url: "/channels/connect", payload: { channel: "telegram" } });
    const res = await app.inject({ method: "GET", url: "/channels" });
    expect(res.json().channels).toHaveLength(1);
  });

  it("GET /channels/list compat alias returns same shape", async () => {
    const r1 = await app.inject({ method: "GET", url: "/channels" });
    const r2 = await app.inject({ method: "GET", url: "/channels/list" });
    expect(r1.json()).toEqual(r2.json());
  });

  it("GET /channels/:id/health returns ok+healthy", async () => {
    await app.inject({ method: "POST", url: "/channels/connect", payload: { channel: "telegram" } });
    const res = await app.inject({ method: "GET", url: "/channels/c-1/health" });
    expect(res.json()).toEqual({ ok: true, healthy: true });
  });

  it("GET /channels/:id/messages returns cached messages", async () => {
    await app.inject({ method: "POST", url: "/channels/connect", payload: { channel: "telegram" } });
    const res = await app.inject({ method: "GET", url: "/channels/c-1/messages" });
    expect(res.json()).toEqual({ messages: [] });
  });

  it("POST /channels/:id/receive/start flips receiving=true", async () => {
    await app.inject({ method: "POST", url: "/channels/connect", payload: { channel: "telegram" } });
    const res = await app.inject({ method: "POST", url: "/channels/c-1/receive/start", payload: {} });
    expect(res.json()).toEqual({ ok: true });
    expect(mgr.startReceiving).toHaveBeenCalledWith("c-1");
  });

  it("POST /channels/:id/receive/stop flips receiving=false", async () => {
    await app.inject({ method: "POST", url: "/channels/connect", payload: { channel: "telegram" } });
    await app.inject({ method: "POST", url: "/channels/c-1/receive/start", payload: {} });
    const res = await app.inject({ method: "POST", url: "/channels/c-1/receive/stop", payload: {} });
    expect(res.json()).toEqual({ ok: true });
  });

  it("POST /channels/:id/toggle flips enabled", async () => {
    await app.inject({ method: "POST", url: "/channels/connect", payload: { channel: "telegram" } });
    const r1 = await app.inject({ method: "POST", url: "/channels/c-1/toggle", payload: {} });
    expect(r1.json().enabled).toBe(false);
    const r2 = await app.inject({ method: "POST", url: "/channels/c-1/toggle", payload: {} });
    expect(r2.json().enabled).toBe(true);
  });

  it("DELETE /channels/:id removes", async () => {
    await app.inject({ method: "POST", url: "/channels/connect", payload: { channel: "telegram" } });
    const res = await app.inject({ method: "DELETE", url: "/channels/c-1" });
    expect(res.json()).toEqual({ ok: true });
  });

  // M5 — auto-reply toggle
  it("POST /channels/:id/auto-reply sets enabled=true", async () => {
    await app.inject({ method: "POST", url: "/channels/connect", payload: { channel: "telegram" } });
    const res = await app.inject({
      method: "POST",
      url: "/channels/c-1/auto-reply",
      payload: { enabled: true },
    });
    expect(res.json()).toEqual({ ok: true, auto_reply: true });
    expect(mgr.setAutoReply).toHaveBeenCalledWith("c-1", true);
  });

  it("POST /channels/:id/auto-reply with missing/false body defaults to disabled", async () => {
    await app.inject({ method: "POST", url: "/channels/connect", payload: { channel: "telegram" } });
    const res = await app.inject({
      method: "POST",
      url: "/channels/c-1/auto-reply",
      payload: {},
    });
    expect(res.json()).toEqual({ ok: true, auto_reply: false });
    expect(mgr.setAutoReply).toHaveBeenCalledWith("c-1", false);
  });

  it("GET /channels/:id/auto-reply reports current state", async () => {
    await app.inject({ method: "POST", url: "/channels/connect", payload: { channel: "telegram" } });
    await app.inject({
      method: "POST",
      url: "/channels/c-1/auto-reply",
      payload: { enabled: true },
    });
    const res = await app.inject({ method: "GET", url: "/channels/c-1/auto-reply" });
    expect(res.json()).toEqual({ ok: true, auto_reply: true });
  });
});
