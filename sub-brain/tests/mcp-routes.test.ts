import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerMCPRoutes } from "../src/server/mcp-routes.js";

function buildApp(mcpClient: any): FastifyInstance {
  const app = Fastify();
  registerMCPRoutes(app, { mcpClient });
  return app;
}

describe("registerMCPRoutes", () => {
  let connectServer: ReturnType<typeof vi.fn>;
  let listServers: ReturnType<typeof vi.fn>;
  let listTools: ReturnType<typeof vi.fn>;
  let callTool: ReturnType<typeof vi.fn>;
  let app: FastifyInstance;

  beforeEach(() => {
    connectServer = vi.fn();
    listServers = vi.fn();
    listTools = vi.fn();
    callTool = vi.fn();
    app = buildApp({ connectServer, listServers, listTools, callTool });
  });

  it("POST /mcp/connect passes body through to connectServer()", async () => {
    connectServer.mockResolvedValue({ ok: true, server: "my-server" });
    const cfg = { name: "my-server", url: "ws://localhost:9000" };

    const res = await app.inject({
      method: "POST",
      url: "/mcp/connect",
      payload: cfg,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, server: "my-server" });
    expect(connectServer).toHaveBeenCalledWith(cfg);
  });

  it("GET /mcp/servers returns wrapped server list", async () => {
    listServers.mockReturnValue([{ name: "a" }, { name: "b" }]);
    const res = await app.inject({ method: "GET", url: "/mcp/servers" });
    expect(res.json().servers).toHaveLength(2);
  });

  it("GET /mcp/tools returns wrapped tools list", async () => {
    listTools.mockReturnValue([{ name: "echo" }]);
    const res = await app.inject({ method: "GET", url: "/mcp/tools" });
    expect(res.json().tools).toHaveLength(1);
  });

  it("POST /mcp/:server/tool calls callTool with server/tool/params", async () => {
    callTool.mockResolvedValue({ output: 42 });

    const res = await app.inject({
      method: "POST",
      url: "/mcp/srv1/tool",
      payload: { tool: "echo", params: { msg: "hi" } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: { output: 42 } });
    expect(callTool).toHaveBeenCalledWith("srv1", "echo", { msg: "hi" });
  });

  it("POST /mcp/:server/tool defaults missing params to {}", async () => {
    callTool.mockResolvedValue("done");
    await app.inject({
      method: "POST",
      url: "/mcp/srv1/tool",
      payload: { tool: "noop" },
    });
    expect(callTool).toHaveBeenCalledWith("srv1", "noop", {});
  });

  it("POST /mcp/:server/tool returns ok:false + error on throw", async () => {
    callTool.mockRejectedValue(new Error("tool failed"));
    const res = await app.inject({
      method: "POST",
      url: "/mcp/srv1/tool",
      payload: { tool: "broken" },
    });
    expect(res.json()).toEqual({ ok: false, error: "tool failed" });
  });

  it("POST /mcp/:server/tool handles non-Error throws", async () => {
    callTool.mockRejectedValue("string err");
    const res = await app.inject({
      method: "POST",
      url: "/mcp/srv1/tool",
      payload: { tool: "x" },
    });
    expect(res.json().error).toBe("string err");
  });
});
