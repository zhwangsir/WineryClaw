/**
 * WebSocket endpoint + connection hub.
 *
 *   GET /ws  (upgrade) — bidirectional channel for tool execution + pings
 *
 * Encapsulates the Set<socket> that main.ts used to keep as a top-level
 * binding. `WebSocketHub` owns the set; routes add/remove, channel manager
 * fan-outs go via broadcast(). Importing `WebSocketHub` lets any subsystem
 * push updates to every connected UI without reaching into main.ts internals.
 *
 * Currently handled inbound actions:
 *   { action: "tool.execute", tool, params }
 *   { action: "ping" }
 *
 * Unknown actions are silently ignored (mirrors prior behavior).
 */

import type { FastifyInstance } from "fastify";
import type { ToolExecutor } from "../tools/tool-executor.js";

// Minimal subset of the WS socket shape we actually use. We avoid pulling in
// the @fastify/websocket types to keep deps light.
export interface WSLike {
  readyState: number;
  send(payload: string): void;
  on(event: "close" | "message", handler: (...args: unknown[]) => void): void;
}

const OPEN = 1; // ws.OPEN — readyState value for an open connection

export class WebSocketHub {
  private connections = new Set<WSLike>();

  add(socket: WSLike): void {
    this.connections.add(socket);
  }

  remove(socket: WSLike): void {
    this.connections.delete(socket);
  }

  size(): number {
    return this.connections.size;
  }

  /** Broadcast a message to every OPEN connection. Closed sockets are skipped. */
  broadcast(msg: unknown): void {
    const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const socket of this.connections) {
      if (socket.readyState === OPEN) {
        socket.send(payload);
      }
    }
  }
}

export interface WsRouteDeps {
  hub: WebSocketHub;
  toolExecutor: ToolExecutor;
}

interface IncomingMessage {
  action?: string;
  tool?: string;
  params?: Record<string, unknown>;
}

export function registerWsRoutes(app: FastifyInstance, deps: WsRouteDeps): void {
  app.get("/ws", { websocket: true }, (connection) => {
    // @fastify/websocket gives us a SocketStream — `.socket` is the raw WS.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const socket = (connection as any).socket as WSLike;

    deps.hub.add(socket);
    socket.on("close", () => deps.hub.remove(socket));

    socket.on("message", async (...args: unknown[]) => {
      const raw = args[0];
      try {
        const text =
          typeof raw === "string"
            ? raw
            : raw instanceof Buffer
              ? raw.toString("utf-8")
              : String(raw);
        const data = JSON.parse(text) as IncomingMessage;

        if (data.action === "tool.execute") {
          const result = await deps.toolExecutor.execute(
            String(data.tool ?? ""),
            data.params ?? {},
          );
          socket.send(JSON.stringify({ action: "tool.result", data: result }));
        } else if (data.action === "ping") {
          socket.send(JSON.stringify({ action: "pong" }));
        }
        // Unknown actions: silently ignored.
      } catch (err: unknown) {
        socket.send(JSON.stringify({ error: String(err) }));
      }
    });
  });
}
