import { describe, it, expect, vi } from "vitest";
import { WebSocketHub, type WSLike } from "../src/server/ws-routes.js";

/**
 * The /ws route handler itself needs a live WebSocket upgrade which is
 * non-trivial to simulate inside Fastify.inject(). We get the most coverage
 * by exercising WebSocketHub directly + verifying message handling logic
 * through a minimal fake socket.
 *
 * For the route registration smoke test, we just confirm it doesn't throw.
 */

function makeFakeSocket(readyState = 1) {
  return {
    readyState,
    sent: [] as string[],
    handlers: new Map<string, (...args: unknown[]) => void>(),
    send(payload: string) {
      this.sent.push(payload);
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
    },
    close() {
      this.handlers.get("close")?.();
    },
    deliver(message: string) {
      this.handlers.get("message")?.(message);
    },
  };
}

describe("WebSocketHub", () => {
  it("starts empty", () => {
    const hub = new WebSocketHub();
    expect(hub.size()).toBe(0);
  });

  it("add() grows the set, remove() shrinks it", () => {
    const hub = new WebSocketHub();
    const s1 = makeFakeSocket() as unknown as WSLike;
    const s2 = makeFakeSocket() as unknown as WSLike;
    hub.add(s1);
    hub.add(s2);
    expect(hub.size()).toBe(2);
    hub.remove(s1);
    expect(hub.size()).toBe(1);
  });

  it("add() is idempotent (Set semantics — same socket twice = one entry)", () => {
    const hub = new WebSocketHub();
    const s = makeFakeSocket() as unknown as WSLike;
    hub.add(s);
    hub.add(s);
    expect(hub.size()).toBe(1);
  });

  it("broadcast(obj) serializes to JSON and sends to all OPEN sockets", () => {
    const hub = new WebSocketHub();
    const s1 = makeFakeSocket(1);
    const s2 = makeFakeSocket(1);
    hub.add(s1 as unknown as WSLike);
    hub.add(s2 as unknown as WSLike);

    hub.broadcast({ event: "tick", n: 1 });

    expect(s1.sent).toEqual(['{"event":"tick","n":1}']);
    expect(s2.sent).toEqual(['{"event":"tick","n":1}']);
  });

  it("broadcast(string) passes the string through verbatim", () => {
    const hub = new WebSocketHub();
    const s = makeFakeSocket(1);
    hub.add(s as unknown as WSLike);

    hub.broadcast("hello");

    expect(s.sent).toEqual(["hello"]);
  });

  it("broadcast() skips closed sockets (readyState != 1)", () => {
    const hub = new WebSocketHub();
    const open = makeFakeSocket(1);
    const closing = makeFakeSocket(2);
    const closed = makeFakeSocket(3);
    hub.add(open as unknown as WSLike);
    hub.add(closing as unknown as WSLike);
    hub.add(closed as unknown as WSLike);

    hub.broadcast({ m: "x" });

    expect(open.sent).toHaveLength(1);
    expect(closing.sent).toHaveLength(0);
    expect(closed.sent).toHaveLength(0);
  });

  it("broadcast() to empty hub is a no-op (no throws)", () => {
    const hub = new WebSocketHub();
    expect(() => hub.broadcast({ ok: true })).not.toThrow();
  });
});

describe("registerWsRoutes", () => {
  it("registers /ws route on the app without throwing", async () => {
    const Fastify = (await import("fastify")).default;
    const websocket = (await import("@fastify/websocket")).default;
    const { registerWsRoutes } = await import("../src/server/ws-routes.js");

    const app = Fastify();
    await app.register(websocket);

    const hub = new WebSocketHub();
    const toolExecutor = {
      execute: vi.fn(async () => ({ ok: true, result: null })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    expect(() => registerWsRoutes(app, { hub, toolExecutor })).not.toThrow();
    await app.ready();

    // Route printer should now know about /ws
    const routes = app.printRoutes();
    expect(routes).toContain("ws");

    await app.close();
  });
});
