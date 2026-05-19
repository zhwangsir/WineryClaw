/**
 * Browser automation routes (Playwright-backed).
 *
 *   POST /browser/launch              — launch the browser instance
 *   POST /browser/page                — open a new page (session) at url
 *   POST /browser/:id/navigate        — navigate session to url
 *   POST /browser/:id/click           — click a selector
 *   POST /browser/:id/type            — type text into a selector
 *   POST /browser/:id/screenshot      — capture screenshot (fullPage option)
 *   GET  /browser/sessions            — list active sessions
 *
 * Every action wraps the underlying call in try/catch and returns
 * { ok, error? } so the frontend never sees a 500.
 */

import type { FastifyInstance } from "fastify";
import type { PlaywrightBrowser } from "../browser/playwright-browser.js";

export interface BrowserRouteDeps {
  browser: PlaywrightBrowser;
}

interface LaunchBody {
  headless?: boolean;
}
interface PageBody {
  url?: string;
}
interface NavigateBody {
  url?: string;
}
interface ClickBody {
  selector?: string;
}
interface TypeBody {
  selector?: string;
  text?: string;
}
interface ScreenshotBody {
  fullPage?: boolean;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerBrowserRoutes(app: FastifyInstance, deps: BrowserRouteDeps): void {
  app.post("/browser/launch", async (request) => {
    const body = (request.body as LaunchBody) ?? {};
    try {
      await deps.browser.launch(body.headless !== false);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: errMsg(err) };
    }
  });

  app.post("/browser/page", async (request) => {
    const body = (request.body as PageBody) ?? {};
    try {
      const session = await deps.browser.newPage(String(body.url ?? ""));
      return { ok: true, session };
    } catch (err: unknown) {
      return { ok: false, error: errMsg(err) };
    }
  });

  app.post("/browser/:id/navigate", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as NavigateBody) ?? {};
    try {
      const session = await deps.browser.navigate(id, String(body.url ?? ""));
      return { ok: true, session };
    } catch (err: unknown) {
      return { ok: false, error: errMsg(err) };
    }
  });

  app.post("/browser/:id/click", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as ClickBody) ?? {};
    try {
      const session = await deps.browser.click(id, String(body.selector ?? ""));
      return { ok: true, session };
    } catch (err: unknown) {
      return { ok: false, error: errMsg(err) };
    }
  });

  app.post("/browser/:id/type", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as TypeBody) ?? {};
    try {
      const session = await deps.browser.type(
        id,
        String(body.selector ?? ""),
        String(body.text ?? ""),
      );
      return { ok: true, session };
    } catch (err: unknown) {
      return { ok: false, error: errMsg(err) };
    }
  });

  app.post("/browser/:id/screenshot", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as ScreenshotBody) ?? {};
    try {
      const screenshot = await deps.browser.screenshot(id, Boolean(body.fullPage));
      return { ok: true, screenshot };
    } catch (err: unknown) {
      return { ok: false, error: errMsg(err) };
    }
  });

  app.get("/browser/sessions", async () => ({
    sessions: await deps.browser.listSessions(),
  }));
}
