import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../src/server/auth.js";

const TEST_KEY = "test-key-abc123";

function buildAppWithEverythingRoutes(): FastifyInstance {
  const app = Fastify();
  // Mount routes that match every code path inside registerAuth's hook.
  app.get("/health", async () => ({ ok: true }));
  app.get("/", async () => ({ root: true }));
  app.get("/assets/style.css", async () => "body{}");
  app.get("/tools", async () => ({ tools: [] }));
  app.post("/tools/execute", async () => ({ result: 1 }));
  return app;
}

describe("registerAuth", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.WEBRAIN_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.WEBRAIN_API_KEY;
    } else {
      process.env.WEBRAIN_API_KEY = originalKey;
    }
  });

  it("when WEBRAIN_API_KEY is unset, auth is a no-op (no hook installed)", async () => {
    delete process.env.WEBRAIN_API_KEY;

    const app = buildAppWithEverythingRoutes();
    registerAuth(app);

    const res = await app.inject({ method: "GET", url: "/tools" });
    expect(res.statusCode).toBe(200);
  });

  it("when WEBRAIN_API_KEY is empty string, auth is a no-op", async () => {
    process.env.WEBRAIN_API_KEY = "";

    const app = buildAppWithEverythingRoutes();
    registerAuth(app);

    const res = await app.inject({ method: "GET", url: "/tools" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects requests with missing Authorization header", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;

    const app = buildAppWithEverythingRoutes();
    registerAuth(app);

    const res = await app.inject({ method: "GET", url: "/tools" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("Unauthorized");
  });

  it("rejects requests with wrong API key", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;

    const app = buildAppWithEverythingRoutes();
    registerAuth(app);

    const res = await app.inject({
      method: "GET",
      url: "/tools",
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts requests with correct Bearer token", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;

    const app = buildAppWithEverythingRoutes();
    registerAuth(app);

    const res = await app.inject({
      method: "GET",
      url: "/tools",
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts raw API key without Bearer prefix (lenient match)", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;

    const app = buildAppWithEverythingRoutes();
    registerAuth(app);

    const res = await app.inject({
      method: "GET",
      url: "/tools",
      headers: { authorization: TEST_KEY },
    });
    expect(res.statusCode).toBe(200);
  });

  it("/health is public — no auth required even when key is set", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;

    const app = buildAppWithEverythingRoutes();
    registerAuth(app);

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("/ is public", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;

    const app = buildAppWithEverythingRoutes();
    registerAuth(app);

    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
  });

  it("/assets/* is public (SPA static files)", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;

    const app = buildAppWithEverythingRoutes();
    registerAuth(app);

    const res = await app.inject({ method: "GET", url: "/assets/style.css" });
    expect(res.statusCode).toBe(200);
  });

  it("browser page navigation (Accept: text/html) bypasses auth — SPA routing", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;

    const app = buildAppWithEverythingRoutes();
    registerAuth(app);

    const res = await app.inject({
      method: "GET",
      url: "/tools",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(res.statusCode).toBe(200);
  });
});
