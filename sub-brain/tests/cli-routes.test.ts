import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerCLIRoutes } from "../src/server/cli-routes.js";

function buildApp(cli: any): FastifyInstance {
  const app = Fastify();
  registerCLIRoutes(app, { cli });
  return app;
}

describe("registerCLIRoutes", () => {
  let status: ReturnType<typeof vi.fn>;
  let chat: ReturnType<typeof vi.fn>;
  let exec: ReturnType<typeof vi.fn>;
  let app: FastifyInstance;

  beforeEach(() => {
    status = vi.fn();
    chat = vi.fn();
    exec = vi.fn();
    app = buildApp({ status, chat, exec });
  });

  describe("GET /cli/status", () => {
    it("returns CLI status text under {text}", async () => {
      status.mockResolvedValue("agents: 3 | tools: 12");

      const res = await app.inject({ method: "GET", url: "/cli/status" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ text: "agents: 3 | tools: 12" });
    });
  });

  describe("POST /cli/chat", () => {
    it("forwards message + session_id to cli.chat()", async () => {
      chat.mockResolvedValue("hello from cli");

      const res = await app.inject({
        method: "POST",
        url: "/cli/chat",
        payload: { message: "hi", session_id: "s1" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ reply: "hello from cli" });
      expect(chat).toHaveBeenCalledWith("hi", "s1");
    });

    it("passes undefined session_id when omitted", async () => {
      chat.mockResolvedValue("ok");
      await app.inject({
        method: "POST",
        url: "/cli/chat",
        payload: { message: "x" },
      });
      expect(chat).toHaveBeenCalledWith("x", undefined);
    });

    it("coerces missing message to empty string", async () => {
      chat.mockResolvedValue("");
      await app.inject({ method: "POST", url: "/cli/chat", payload: {} });
      expect(chat).toHaveBeenCalledWith("", undefined);
    });
  });

  describe("POST /cli/exec", () => {
    it("forwards tool + params to cli.exec() and returns wrapped result", async () => {
      exec.mockResolvedValue({ ok: true, output: 42 });

      const res = await app.inject({
        method: "POST",
        url: "/cli/exec",
        payload: { tool: "shell", params: { cmd: "ls" } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ result: { ok: true, output: 42 } });
      expect(exec).toHaveBeenCalledWith("shell", { cmd: "ls" });
    });

    it("defaults missing params to empty object", async () => {
      exec.mockResolvedValue("done");
      await app.inject({
        method: "POST",
        url: "/cli/exec",
        payload: { tool: "noop" },
      });
      expect(exec).toHaveBeenCalledWith("noop", {});
    });
  });
});
