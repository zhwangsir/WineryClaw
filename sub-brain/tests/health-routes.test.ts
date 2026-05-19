import { describe, it, expect, beforeEach, vi } from "vitest";

const axiosGet = vi.fn();
vi.mock("axios", () => ({
  default: { get: axiosGet },
}));

const { registerHealthRoutes } = await import("../src/server/health-routes.js");
const Fastify = (await import("fastify")).default;

function buildApp(deps: Parameters<typeof registerHealthRoutes>[1]) {
  const app = Fastify();
  registerHealthRoutes(app, deps);
  return app;
}

describe("registerHealthRoutes", () => {
  beforeEach(() => {
    axiosGet.mockReset();
  });

  describe("GET /health", () => {
    it("returns ok status + module map with sandbox=true when docker is available", async () => {
      const app = buildApp({
        dockerAvailable: true,
        mainBrainUrl: "http://localhost:18790",
        mainBrainAxiosConfig: () => ({}),
      });

      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body.component).toBe("sub-brain");
      expect(body.modules.sandbox).toBe(true);
    });

    it("reports sandbox=false when docker not available", async () => {
      const app = buildApp({
        dockerAvailable: false,
        mainBrainUrl: "http://localhost:18790",
        mainBrainAxiosConfig: () => ({}),
      });

      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.json().modules.sandbox).toBe(false);
    });

    it("lists all expected module flags", async () => {
      const app = buildApp({
        dockerAvailable: true,
        mainBrainUrl: "http://x",
        mainBrainAxiosConfig: () => ({}),
      });

      const res = await app.inject({ method: "GET", url: "/health" });
      const mods = res.json().modules;
      for (const key of [
        "tools", "channels", "plugins", "ecosystem", "dokobot",
        "modelConfig", "layeredConfig", "identity", "agents",
        "browser", "sandbox", "skills", "mcp", "cli", "hooks",
      ]) {
        expect(mods).toHaveProperty(key);
      }
    });
  });

  describe("GET /health/models", () => {
    it("proxies to main brain and returns its body", async () => {
      axiosGet.mockResolvedValueOnce({
        data: { status: "ok", endpoints: [{ name: "lmstudio", up: true }] },
      });

      const app = buildApp({
        dockerAvailable: true,
        mainBrainUrl: "http://localhost:18790",
        mainBrainAxiosConfig: () => ({}),
      });

      const res = await app.inject({ method: "GET", url: "/health/models" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body.endpoints).toHaveLength(1);
      expect(axiosGet).toHaveBeenCalledTimes(1);
      expect(axiosGet.mock.calls[0][0]).toBe("http://localhost:18790/health/models");
    });

    it("forwards mainBrainAxiosConfig (e.g. UDS socketPath) into the axios call", async () => {
      axiosGet.mockResolvedValueOnce({ data: { status: "ok", endpoints: [] } });

      const app = buildApp({
        dockerAvailable: true,
        mainBrainUrl: "http://localhost",
        mainBrainAxiosConfig: () => ({ socketPath: "/tmp/test.sock" }),
      });

      await app.inject({ method: "GET", url: "/health/models" });
      const passedConfig = axiosGet.mock.calls[0][1];
      expect(passedConfig.socketPath).toBe("/tmp/test.sock");
      expect(passedConfig.timeout).toBe(10000);
    });

    it("returns {status:unknown, error, endpoints:[]} when main brain unreachable", async () => {
      axiosGet.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const app = buildApp({
        dockerAvailable: true,
        mainBrainUrl: "http://localhost:18790",
        mainBrainAxiosConfig: () => ({}),
      });

      const res = await app.inject({ method: "GET", url: "/health/models" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("unknown");
      expect(body.error).toBe("ECONNREFUSED");
      expect(body.endpoints).toEqual([]);
    });

    it("survives non-Error thrown values", async () => {
      axiosGet.mockRejectedValueOnce("string failure");

      const app = buildApp({
        dockerAvailable: true,
        mainBrainUrl: "http://x",
        mainBrainAxiosConfig: () => ({}),
      });

      const res = await app.inject({ method: "GET", url: "/health/models" });
      expect(res.json().error).toBe("string failure");
    });
  });
});
