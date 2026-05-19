/**
 * Dokobot (web browsing automation) routes.
 *
 *   POST /dokobot/browse      — open a URL and run a named action
 *   POST /dokobot/search      — run a web search
 *   POST /dokobot/screenshot  — capture a screenshot of a URL
 *   GET  /dokobot/status      — availability flag
 */

import type { FastifyInstance } from "fastify";
import type { DokobotClient } from "../dokobot/dokobot-client.js";

export interface DokobotRouteDeps {
  dokobot: DokobotClient;
}

interface BrowseBody { url?: string; action?: string }
interface SearchBody { query?: string }
interface ScreenshotBody { url?: string }

export function registerDokobotRoutes(app: FastifyInstance, deps: DokobotRouteDeps): void {
  app.post("/dokobot/browse", async (request) => {
    const body = (request.body as BrowseBody) ?? {};
    return deps.dokobot.browse(String(body.url ?? ""), String(body.action ?? ""));
  });

  app.post("/dokobot/search", async (request) => {
    const body = (request.body as SearchBody) ?? {};
    return deps.dokobot.search(String(body.query ?? ""));
  });

  app.post("/dokobot/screenshot", async (request) => {
    const body = (request.body as ScreenshotBody) ?? {};
    return deps.dokobot.screenshot(String(body.url ?? ""));
  });

  app.get("/dokobot/status", async () => ({
    available: deps.dokobot.isAvailable(),
  }));
}
