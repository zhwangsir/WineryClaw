/**
 * Browser Tool — Playwright 浏览器自动化
 * 支持: 导航、点击、输入、截图、提取内容、执行 JS
 */

import { registry, ToolDefinition } from "./tool-registry.js";

let playwrightInstance: any = null;

async function getPlaywright() {
  if (!playwrightInstance) {
    const { chromium } = await import("playwright");
    playwrightInstance = chromium;
  }
  return playwrightInstance;
}

interface BrowserSession {
  browser: any;
  page: any;
  createdAt: number;
}

const sessions = new Map<string, BrowserSession>();
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function getOrCreateSession(sessionId: string): Promise<BrowserSession> {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.createdAt = Date.now();
    return existing;
  }

  const pw = await getPlaywright();
  const browser = await pw.launch({ headless: true });
  const page = await browser.newPage();
  const session: BrowserSession = { browser, page, createdAt: Date.now() };
  sessions.set(sessionId, session);
  return session;
}

async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    await session.browser.close();
  } catch (err) { console.error("[tool] Error:", err); }
  sessions.delete(sessionId);
}

// ─── Tool Definitions ────────────────────────────────────────────

const browserNavigateDef: ToolDefinition = {
  name: "browser_navigate",
  description: "Navigate to a URL in a browser session",
  category: "browser",
  parameters: [
    { name: "url", type: "string", description: "URL to navigate to", required: true },
    { name: "session_id", type: "string", description: "Browser session ID (reuse for multi-step)", default: "default" },
    { name: "wait_until", type: "string", description: "When to consider navigation done: load, domcontentloaded, networkidle", default: "domcontentloaded" },
    { name: "timeout", type: "number", description: "Navigation timeout in ms", default: 30000 },
  ],
};

async function browserNavigateExecute(params: Record<string, unknown>) {
  const url = String(params.url || "");
  const sessionId = String(params.session_id || "default");
  const waitUntil = String(params.wait_until || "domcontentloaded") as "load" | "domcontentloaded" | "networkidle";
  const timeout = Number(params.timeout || 30000);

  if (!url) return { error: "URL is required" };

  try {
    const session = await getOrCreateSession(sessionId);
    const resp = await session.page.goto(url, { waitUntil, timeout });
    const title = await session.page.title().catch(() => "");
    const finalUrl = session.page.url();

    return {
      status: resp?.status() || 0,
      title,
      url: finalUrl,
      session_id: sessionId,
    };
  } catch (err: any) {
    return { error: `Navigation failed: ${err.message}`, session_id: sessionId };
  }
}

const browserClickDef: ToolDefinition = {
  name: "browser_click",
  description: "Click an element by selector or text",
  category: "browser",
  parameters: [
    { name: "selector", type: "string", description: "CSS selector of the element", required: true },
    { name: "session_id", type: "string", description: "Browser session ID", default: "default" },
    { name: "timeout", type: "number", description: "Wait timeout in ms", default: 5000 },
  ],
};

async function browserClickExecute(params: Record<string, unknown>) {
  const selector = String(params.selector || "");
  const sessionId = String(params.session_id || "default");
  const timeout = Number(params.timeout || 5000);

  try {
    const session = await getOrCreateSession(sessionId);
    await session.page.waitForSelector(selector, { timeout });
    await session.page.click(selector);
    return { clicked: selector, session_id: sessionId };
  } catch (err: any) {
    return { error: `Click failed: ${err.message}`, session_id: sessionId };
  }
}

const browserTypeDef: ToolDefinition = {
  name: "browser_type",
  description: "Type text into an input field",
  category: "browser",
  parameters: [
    { name: "selector", type: "string", description: "CSS selector of the input", required: true },
    { name: "text", type: "string", description: "Text to type", required: true },
    { name: "session_id", type: "string", description: "Browser session ID", default: "default" },
    { name: "submit", type: "boolean", description: "Press Enter after typing", default: false },
  ],
};

async function browserTypeExecute(params: Record<string, unknown>) {
  const selector = String(params.selector || "");
  const text = String(params.text || "");
  const sessionId = String(params.session_id || "default");
  const submit = Boolean(params.submit);

  try {
    const session = await getOrCreateSession(sessionId);
    await session.page.fill(selector, text);
    if (submit) {
      await session.page.press(selector, "Enter");
    }
    return { typed: text, selector, session_id: sessionId };
  } catch (err: any) {
    return { error: `Type failed: ${err.message}`, session_id: sessionId };
  }
}

const browserScreenshotDef: ToolDefinition = {
  name: "browser_screenshot",
  description: "Take a screenshot of the current page or an element",
  category: "browser",
  parameters: [
    { name: "session_id", type: "string", description: "Browser session ID", default: "default" },
    { name: "selector", type: "string", description: "CSS selector to screenshot a specific element (optional)", default: "" },
    { name: "full_page", type: "boolean", description: "Screenshot full page", default: false },
  ],
};

async function browserScreenshotExecute(params: Record<string, unknown>) {
  const sessionId = String(params.session_id || "default");
  const selector = String(params.selector || "");
  const fullPage = Boolean(params.full_page);

  try {
    const session = await getOrCreateSession(sessionId);
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

    const screenshotDir = path.join(os.homedir(), ".webrain", "screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });

    const filename = `screenshot-${Date.now()}.png`;
    const filepath = path.join(screenshotDir, filename);

    if (selector) {
      const el = await session.page.$(selector);
      if (!el) return { error: `Element not found: ${selector}` };
      await el.screenshot({ path: filepath });
    } else {
      await session.page.screenshot({ path: filepath, fullPage });
    }

    return {
      path: filepath,
      filename,
      session_id: sessionId,
    };
  } catch (err: any) {
    return { error: `Screenshot failed: ${err.message}`, session_id: sessionId };
  }
}

const browserExtractDef: ToolDefinition = {
  name: "browser_extract",
  description: "Extract text content from the current page or specific elements",
  category: "browser",
  parameters: [
    { name: "session_id", type: "string", description: "Browser session ID", default: "default" },
    { name: "selector", type: "string", description: "CSS selector (optional, extracts whole page if empty)", default: "" },
    { name: "max_length", type: "number", description: "Max characters to return", default: 8000 },
  ],
};

async function browserExtractExecute(params: Record<string, unknown>) {
  const sessionId = String(params.session_id || "default");
  const selector = String(params.selector || "");
  const maxLength = Number(params.max_length || 8000);

  try {
    const session = await getOrCreateSession(sessionId);
    let content = "";

    if (selector) {
      const elements = await session.page.$$eval(selector, (els: any[]) =>
        els.map((el) => el.textContent || "").join("\n\n"),
      );
      content = elements.join("\n\n");
    } else {
      // Extract readable content
      content = await session.page.evaluate(() => {
        const article = document.querySelector("article, main, [role='main']");
        if (article) return article.textContent || "";
        const paragraphs = Array.from(document.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li"));
        return paragraphs.map((p) => p.textContent).join("\n\n");
      });
    }

    content = content.replace(/\s+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
    const truncated = content.length > maxLength;
    if (truncated) {
      content = content.slice(0, maxLength) + "\n\n[Content truncated...]";
    }

    return { content, length: content.length, truncated, session_id: sessionId };
  } catch (err: any) {
    return { error: `Extract failed: ${err.message}`, session_id: sessionId };
  }
}

const browserEvaluateDef: ToolDefinition = {
  name: "browser_evaluate",
  description: "Execute JavaScript in the browser context",
  category: "browser",
  parameters: [
    { name: "script", type: "string", description: "JavaScript code to execute", required: true },
    { name: "session_id", type: "string", description: "Browser session ID", default: "default" },
  ],
};

async function browserEvaluateExecute(params: Record<string, unknown>) {
  const script = String(params.script || "");
  const sessionId = String(params.session_id || "default");

  try {
    const session = await getOrCreateSession(sessionId);
    const result = await session.page.evaluate((code: string) => {
      try {
        return { success: true, result: eval(code) };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }, script);
    return { ...result, session_id: sessionId };
  } catch (err: any) {
    return { error: `Evaluate failed: ${err.message}`, session_id: sessionId };
  }
}

const browserCloseDef: ToolDefinition = {
  name: "browser_close",
  description: "Close a browser session",
  category: "browser",
  parameters: [
    { name: "session_id", type: "string", description: "Browser session ID to close", default: "default" },
  ],
};

async function browserCloseExecute(params: Record<string, unknown>) {
  const sessionId = String(params.session_id || "default");
  await closeSession(sessionId);
  return { closed: true, session_id: sessionId };
}

// ─── Cleanup old sessions periodically ───────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT_MS) {
      closeSession(id).catch(() => {});
    }
  }
}, 60000);

// ─── Registration ────────────────────────────────────────────────

export function registerBrowserTools(): void {
  registry.register(browserNavigateDef, browserNavigateExecute);
  registry.register(browserClickDef, browserClickExecute);
  registry.register(browserTypeDef, browserTypeExecute);
  registry.register(browserScreenshotDef, browserScreenshotExecute);
  registry.register(browserExtractDef, browserExtractExecute);
  registry.register(browserEvaluateDef, browserEvaluateExecute);
  registry.register(browserCloseDef, browserCloseExecute);
}
