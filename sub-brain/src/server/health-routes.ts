/**
 * Health endpoints.
 *
 *   GET /health           — sub-brain self status + per-module availability
 *   GET /health/models    — proxy to main-brain model-availability endpoint
 *
 * Follows the registerXxxRoutes(app, deps) pattern established by
 * skillhub-routes.ts. Pure deps injection; no module-level state read.
 */

import type { FastifyInstance } from "fastify";

export interface HealthRouteDeps {
  /** Whether docker is reachable at startup (drives `modules.sandbox`). */
  dockerAvailable: boolean;
  /** Main brain URL — UDS placeholder "http://localhost" or TCP "http://127.0.0.1:18790". */
  mainBrainUrl: string;
  /** Returns axios config (e.g. {socketPath: '/tmp/...'}) for UDS-aware calls. */
  mainBrainAxiosConfig: () => Record<string, unknown>;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  // Sub-brain self status — flat module-availability report.
  app.get("/health", async () => ({
    status: "ok",
    component: "sub-brain",
    modules: {
      tools: true,
      channels: true,
      plugins: true,
      ecosystem: true,
      dokobot: true,
      modelConfig: true,
      layeredConfig: true,
      identity: true,
      agents: true,
      browser: true,
      sandbox: deps.dockerAvailable,
      skills: true,
      mcp: true,
      cli: true,
      hooks: true,
    },
  }));

  // Proxy to main-brain model health.
  app.get("/health/models", async () => {
    try {
      const axios = (await import("axios")).default;
      const resp = await axios.get(
        `${deps.mainBrainUrl}/health/models`,
        { timeout: 10000, ...deps.mainBrainAxiosConfig() },
      );
      return resp.data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "unknown", error: message, endpoints: [] };
    }
  });
}
