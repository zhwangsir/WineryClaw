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

  // ── Round O2 — path-normalization bypass defense ──────────────────

  it("accepts x-webrain-token alternative header", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;
    const app = buildAppWithEverythingRoutes();
    registerAuth(app);
    const res = await app.inject({
      method: "GET",
      url: "/tools",
      headers: { "x-webrain-token": TEST_KEY },
    });
    expect(res.statusCode).toBe(200);
  });

  it("WEBRAIN_API_TOKEN env var works as alias", async () => {
    delete process.env.WEBRAIN_API_KEY;
    process.env.WEBRAIN_API_TOKEN = "alias-key-xyz";
    try {
      const app = buildAppWithEverythingRoutes();
      registerAuth(app);
      // wrong key → 401
      const denied = await app.inject({
        method: "GET",
        url: "/tools",
        headers: { authorization: "Bearer wrong" },
      });
      expect(denied.statusCode).toBe(401);
      // right key → 200
      const ok = await app.inject({
        method: "GET",
        url: "/tools",
        headers: { authorization: "Bearer alias-key-xyz" },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      delete process.env.WEBRAIN_API_TOKEN;
    }
  });

  it("/api/tools requires auth (prefix strip on the auth side)", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;
    const app = buildAppWithEverythingRoutes();
    // Mount also at /api/tools so we can hit it directly without main.ts's prefix rewrite.
    app.get("/api/tools", async () => ({ tools: [] }));
    registerAuth(app);
    const denied = await app.inject({ method: "GET", url: "/api/tools" });
    expect(denied.statusCode).toBe(401);
  });

  it("denies double-slash bypass (//tools)", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;
    const app = buildAppWithEverythingRoutes();
    registerAuth(app);
    // Fastify itself routes //tools the same as /tools — verify our hook
    // also collapses // so the auth check matches the eventual route.
    const res = await app.inject({ method: "GET", url: "//tools" });
    expect(res.statusCode).toBe(401);
  });

  it("denies case-variant bypass (/TOOLS)", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;
    const app = buildAppWithEverythingRoutes();
    app.get("/TOOLS", async () => ({ tools: [] }));
    registerAuth(app);
    const res = await app.inject({ method: "GET", url: "/TOOLS" });
    expect(res.statusCode).toBe(401);
  });

  it("denies dot-segment bypass (/api/./tools)", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;
    const app = buildAppWithEverythingRoutes();
    registerAuth(app);
    const res = await app.inject({ method: "GET", url: "/api/./tools" });
    // Should be 401 (auth rejected) — even though Fastify might 404 the
    // dot-segment route, our guard must classify it as protected.
    expect([401, 404]).toContain(res.statusCode);
    // The critical assertion: it must NOT be 200.
    expect(res.statusCode).not.toBe(200);
  });

  it("/metrics is public", async () => {
    process.env.WEBRAIN_API_KEY = TEST_KEY;
    const app = buildAppWithEverythingRoutes();
    app.get("/metrics", async () => "# HELP\n");
    registerAuth(app);
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
  });
});
