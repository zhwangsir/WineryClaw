/**
 * Playwright Browser Automation
 * 替代 CDP 预留，提供完整的浏览器控制能力
 * Browser automation tools (navigate, click, type, scroll, vision, dialog)
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";

export interface BrowserSession {
  id: string;
  url?: string;
  title?: string;
  screenshot?: string;
  content?: string;
}

export class PlaywrightBrowser {
  private browser?: Browser;
  private context?: BrowserContext;
  private pages = new Map<string, Page>();
  private sessionCounter = 0;

  async launch(headless = true): Promise<void> {
    this.browser = await chromium.launch({ headless });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    });
    console.log("[browser] Playwright launched");
  }

  async close(): Promise<void> {
    for (const page of this.pages.values()) {
      try { await page.close(); } catch (err) { console.error("[playwright-browser] Error:", err); console.error("[cleanup] Error:", err); }
    }
    this.pages.clear();
    if (this.context) { try { await this.context.close(); } catch (err) { console.error("[playwright-browser] Error:", err); console.error("[cleanup] Error:", err); } }
    if (this.browser) { try { await this.browser.close(); } catch (err) { console.error("[playwright-browser] Error:", err); console.error("[cleanup] Error:", err); } }
    console.log("[browser] Playwright closed");
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (!this.context) {
      try {
        await this.launch(true);
      } catch (err) { console.error("[playwright-browser] Error:", err);
        throw new Error("Browser not available. Playwright may not be installed.");
      }
    }
    return this.context!;
  }

  async newPage(url?: string): Promise<BrowserSession> {
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    this.sessionCounter++;
    const id = `browser-${this.sessionCounter}`;
    this.pages.set(id, page);
    if (url) {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    }
    return this._buildSession(id, page);
  }

  async navigate(sessionId: string, url: string): Promise<BrowserSession> {
    const page = this._getPage(sessionId);
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    return this._buildSession(sessionId, page);
  }

  async click(sessionId: string, selector: string): Promise<BrowserSession> {
    const page = this._getPage(sessionId);
    await page.click(selector, { timeout: 10000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    return this._buildSession(sessionId, page);
  }

  async type(sessionId: string, selector: string, text: string): Promise<BrowserSession> {
    const page = this._getPage(sessionId);
    await page.fill(selector, text, { timeout: 10000 });
    return this._buildSession(sessionId, page);
  }

  async scroll(sessionId: string, direction: "up" | "down" | "top" | "bottom" = "down", amount = 500): Promise<BrowserSession> {
    const page = this._getPage(sessionId);
    if (direction === "top") {
      await page.evaluate(() => window.scrollTo(0, 0));
    } else if (direction === "bottom") {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    } else {
      const y = direction === "up" ? -amount : amount;
      await page.evaluate((y) => window.scrollBy(0, y), y);
    }
    return this._buildSession(sessionId, page);
  }

  async screenshot(sessionId: string, fullPage = false): Promise<{ base64: string }> {
    const page = this._getPage(sessionId);
    const buffer = await page.screenshot({ fullPage, type: "png" });
    return { base64: buffer.toString("base64") };
  }

  async getText(sessionId: string): Promise<string> {
    const page = this._getPage(sessionId);
    return page.evaluate(() => document.body.innerText);
  }

  async getHtml(sessionId: string): Promise<string> {
    const page = this._getPage(sessionId);
    return page.content();
  }

  async search(sessionId: string, keyword: string): Promise<{ found: boolean; count: number; highlights: string[] }> {
    const page = this._getPage(sessionId);
    const results = await page.evaluate((kw) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const matches: string[] = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent?.toLowerCase().includes(kw.toLowerCase())) {
          matches.push(node.textContent.trim());
        }
      }
      return matches;
    }, keyword);
    return { found: results.length > 0, count: results.length, highlights: results.slice(0, 10) };
  }

  async closePage(sessionId: string): Promise<void> {
    const page = this.pages.get(sessionId);
    if (page) {
      await page.close();
      this.pages.delete(sessionId);
    }
  }

  async listSessions(): Promise<Array<{ id: string; url: string; title: string }>> {
    const sessions: Array<{ id: string; url: string; title: string }> = [];
    for (const [id, page] of this.pages) {
      try {
        sessions.push({ id, url: page.url(), title: await page.title() });
      } catch (err) { console.error("[playwright-browser] Error:", err);
        sessions.push({ id, url: page.url(), title: "(unavailable)" });
      }
    }
    return sessions;
  }

  private _getPage(sessionId: string): Page {
    const page = this.pages.get(sessionId);
    if (!page) throw new Error(`Browser session not found: ${sessionId}`);
    return page;
  }

  private async _buildSession(id: string, page: Page): Promise<BrowserSession> {
    return {
      id,
      url: page.url(),
      title: await page.title().catch(() => undefined),
    };
  }
}
