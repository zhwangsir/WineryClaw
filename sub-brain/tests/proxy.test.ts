import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock axios before importing the module under test so the dynamic
// `await import("axios")` inside registerBrainProxy picks up our stub.
const axiosMock = vi.fn();
vi.mock("axios", () => ({
  default: axiosMock,
}));

const { registerBrainProxy } = await import("../src/server/proxy.js");
const Fastify = (await import("fastify")).default;

function buildApp() {
  const app = Fastify();
  return app;
}

describe("registerBrainProxy", () => {
  beforeEach(() => {
    axiosMock.mockReset();
  });

  it("strips the /brain prefix when forwarding the URL", async () => {
    const app = buildApp();
    registerBrainProxy(app, "http://localhost:18790", false, "/tmp/x.sock");

    axiosMock.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { ok: true },
    });

    const res = await app.inject({ method: "GET", url: "/brain/memory/recent" });

    expect(axiosMock).toHaveBeenCalledTimes(1);
    const config = axiosMock.mock.calls[0][0];
    expect(config.url).toBe("http://localhost:18790/memory/recent");
    expect(config.method).toBe("GET");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("forwards request body for POST", async () => {
    const app = buildApp();
    registerBrainProxy(app, "http://localhost:18790", false, "/tmp/x.sock");

    axiosMock.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { ok: true },
    });

    await app.inject({
      method: "POST",
      url: "/brain/kg/entities",
      payload: { name: "Alice" },
      headers: { "content-type": "application/json" },
    });

    const config = axiosMock.mock.calls[0][0];
    expect(config.method).toBe("POST");
    expect(config.data).toEqual({ name: "Alice" });
    expect(config.url).toBe("http://localhost:18790/kg/entities");
  });

  it("uses UDS socketPath when useUds=true", async () => {
    const app = buildApp();
    registerBrainProxy(app, "http://localhost", true, "/tmp/webrain-main.sock");

    axiosMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {},
    });

    await app.inject({ method: "GET", url: "/brain/health" });

    const config = axiosMock.mock.calls[0][0];
    expect(config.socketPath).toBe("/tmp/webrain-main.sock");
  });

  it("does NOT set socketPath when useUds=false", async () => {
    const app = buildApp();
    registerBrainProxy(app, "http://localhost:18790", false, "/tmp/should-be-ignored.sock");

    axiosMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {},
    });

    await app.inject({ method: "GET", url: "/brain/health" });

    const config = axiosMock.mock.calls[0][0];
    expect(config.socketPath).toBeUndefined();
  });

  it("propagates upstream error status and body", async () => {
    const app = buildApp();
    registerBrainProxy(app, "http://localhost:18790", false, "/tmp/x.sock");

    axiosMock.mockRejectedValueOnce({
      response: { status: 404, data: { error: "not found" } },
      message: "Request failed with status code 404",
    });

    const res = await app.inject({ method: "GET", url: "/brain/missing" });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not found" });
  });

  it("returns 500 with err.message when upstream has no response", async () => {
    const app = buildApp();
    registerBrainProxy(app, "http://localhost:18790", false, "/tmp/x.sock");

    axiosMock.mockRejectedValueOnce({ message: "ECONNREFUSED" });

    const res = await app.inject({ method: "GET", url: "/brain/anything" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "ECONNREFUSED" });
  });

  it("requests stream responseType when Accept includes text/event-stream", async () => {
    const app = buildApp();
    registerBrainProxy(app, "http://localhost:18790", false, "/tmp/x.sock");

    // Minimal "stream-like" object: pipe is a function so the branch triggers.
    const fakeStream = { pipe: vi.fn() };
    axiosMock.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      data: fakeStream,
    });

    await app.inject({
      method: "GET",
      url: "/brain/chat/stream",
      headers: { accept: "text/event-stream" },
    });

    const config = axiosMock.mock.calls[0][0];
    expect(config.responseType).toBe("stream");
    expect(fakeStream.pipe).toHaveBeenCalled();
  });
});
