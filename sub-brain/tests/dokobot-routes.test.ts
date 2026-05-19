import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerDokobotRoutes } from "../src/server/dokobot-routes.js";

function buildApp(dokobot: any): FastifyInstance {
  const app = Fastify();
  registerDokobotRoutes(app, { dokobot });
  return app;
}

describe("registerDokobotRoutes", () => {
  let browse: ReturnType<typeof vi.fn>;
  let search: ReturnType<typeof vi.fn>;
  let screenshot: ReturnType<typeof vi.fn>;
  let isAvailable: ReturnType<typeof vi.fn>;
  let app: FastifyInstance;

  beforeEach(() => {
    browse = vi.fn();
    search = vi.fn();
    screenshot = vi.fn();
    isAvailable = vi.fn();
    app = buildApp({ browse, search, screenshot, isAvailable });
  });

  it("POST /dokobot/browse forwards url + action", async () => {
    browse.mockResolvedValue({ ok: true, html: "<html/>" });
    const res = await app.inject({
      method: "POST",
      url: "/dokobot/browse",
      payload: { url: "https://example.com", action: "scrape" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, html: "<html/>" });
    expect(browse).toHaveBeenCalledWith("https://example.com", "scrape");
  });

  it("POST /dokobot/browse coerces missing fields to empty strings", async () => {
    browse.mockResolvedValue({ ok: true });
    await app.inject({ method: "POST", url: "/dokobot/browse", payload: {} });
    expect(browse).toHaveBeenCalledWith("", "");
  });

  it("POST /dokobot/search forwards query", async () => {
    search.mockResolvedValue({ results: [{ title: "x" }] });
    const res = await app.inject({
      method: "POST",
      url: "/dokobot/search",
      payload: { query: "weather" },
    });
    expect(res.json().results).toHaveLength(1);
    expect(search).toHaveBeenCalledWith("weather");
  });

  it("POST /dokobot/screenshot forwards url", async () => {
    screenshot.mockResolvedValue({ ok: true, path: "/tmp/s.png" });
    const res = await app.inject({
      method: "POST",
      url: "/dokobot/screenshot",
      payload: { url: "https://x.com" },
    });
    expect(res.json().ok).toBe(true);
    expect(screenshot).toHaveBeenCalledWith("https://x.com");
  });

  it("GET /dokobot/status reports {available:true} when isAvailable()=true", async () => {
    isAvailable.mockReturnValue(true);
    const res = await app.inject({ method: "GET", url: "/dokobot/status" });
    expect(res.json()).toEqual({ available: true });
  });

  it("GET /dokobot/status reports {available:false} when isAvailable()=false", async () => {
    isAvailable.mockReturnValue(false);
    const res = await app.inject({ method: "GET", url: "/dokobot/status" });
    expect(res.json()).toEqual({ available: false });
  });
});
