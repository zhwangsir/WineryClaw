/**
 * Dokobot Browser Automation — 委托给 PlaywrightBrowser
 * 不再维护独立的 CDP 连接，所有浏览器操作复用 PlaywrightBrowser
 */

import { PlaywrightBrowser } from "../browser/playwright-browser.js";

export class DokobotClient {
  private browser?: PlaywrightBrowser;

  constructor(browser?: PlaywrightBrowser) {
    this.browser = browser;
  }

  setBrowser(browser: PlaywrightBrowser): void {
    this.browser = browser;
  }

  async browse(url: string, action?: string): Promise<unknown> {
    // Prefer Playwright if available
    if (this.browser) {
      try {
        const sessions = await this.browser.listSessions();
        let sessionId: string | undefined;

        if (sessions.length === 0) {
          // No active session, create one
          const session = await this.browser.newPage(url);
          sessionId = session.id;
        } else {
          // Reuse first session
          sessionId = sessions[0].id;
          await this.browser.navigate(sessionId, url);
        }

        if (!sessionId) {
          throw new Error("Failed to create browser session");
        }

        if (action === "screenshot") {
          const shot = await this.browser.screenshot(sessionId);
          return { ok: true, url, action: "screenshot", screenshot: shot.base64 };
        }

        const content = await this.browser.getHtml(sessionId);
        const text = await this.browser.getText(sessionId);
        return {
          ok: true,
          url,
          action: action || "read",
          content,
          text: text.slice(0, 5000), // Truncate for response size
          title: "Web page content",
        };
      } catch (err: any) {
        console.error("[dokobot] Playwright browse failed, falling back to HTTP:", err.message);
        return this._browseHTTP(url, action);
      }
    }

    return this._browseHTTP(url, action);
  }

  private async _browseHTTP(url: string, action?: string): Promise<unknown> {
    try {
      const axios = (await import("axios")).default;
      const response = await axios.get(url, {
        timeout: 30000,
        maxContentLength: 5 * 1024 * 1024,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      return {
        ok: true,
        url,
        action: action || "read",
        content: typeof response.data === "string" ? response.data : JSON.stringify(response.data),
        title: "Web page content (HTTP fallback)",
      };
    } catch (err: any) {
      return { ok: false, url, error: err.message };
    }
  }

  async search(query: string): Promise<unknown> {
    try {
      const { execSync } = await import("child_process");
      const output = execSync(`dokobot search "${query}"`, { encoding: "utf-8", timeout: 60000 });
      return { ok: true, query, results: output };
    } catch (err) { console.error("[dokobot-client] Error:", err);
      return { ok: false, query, error: "Dokobot search CLI not available." };
    }
  }

  async screenshot(url: string): Promise<unknown> {
    return this.browse(url, "screenshot");
  }

  isAvailable(): boolean {
    return !!this.browser;
  }
}
