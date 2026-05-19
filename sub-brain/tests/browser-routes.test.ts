import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerBrowserRoutes } from "../src/server/browser-routes.js";
import type { PlaywrightBrowser } from "../src/browser/playwright-browser.js";

function makeFakeBrowser() {
  return {
    launch: vi.fn(async (_headless: boolean) => undefined),
    newPage: vi.fn(async (url: string) => ({ id: "s1", url })),
    navigate: vi.fn(async (id: string, url: string) => ({ id, url })),
    click: vi.fn(async (id: string, selector: string) => ({ id, lastAction: { kind: "click", selector } })),
    type: vi.fn(async (id: string, selector: string, text: string) => ({ id, lastAction: { kind: "type", selector, text } })),
    screenshot: vi.fn(async (_id: string, _fullPage: boolean) => "data:image/png;base64,FAKE"),
    listSessions: vi.fn(async () => [{ id: "s1", url: "https://x" }]),
  };
}

describe("browser routes", () => {
  let app: FastifyInstance;
  let browser: ReturnType<typeof makeFakeBrowser>;

  beforeEach(async () => {
    browser = makeFakeBrowser();
    app = Fastify();
    registerBrowserRoutes(app, { browser: browser as unknown as PlaywrightBrowser });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /browser/launch defaults headless=true", async () => {
    const res = await app.inject({ method: "POST", url: "/browser/launch", payload: {} });
    expect(res.json()).toEqual({ ok: true });
    expect(browser.launch).toHaveBeenCalledWith(true);
  });

  it("POST /browser/launch with headless=false forwards", async () => {
    await app.inject({ method: "POST", url: "/browser/launch", payload: { headless: false } });
    expect(browser.launch).toHaveBeenCalledWith(false);
  });

  it("POST /browser/launch wraps errors as ok=false", async () => {
    browser.launch.mockRejectedValueOnce(new Error("boot fail"));
    const res = await app.inject({ method: "POST", url: "/browser/launch", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: "boot fail" });
  });

  it("POST /browser/page returns session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser/page",
      payload: { url: "https://example.com" },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().session.url).toBe("https://example.com");
    expect(browser.newPage).toHaveBeenCalledWith("https://example.com");
  });

  it("POST /browser/:id/navigate forwards id + url", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser/abc/navigate",
      payload: { url: "https://target" },
    });
    expect(res.json().ok).toBe(true);
    expect(browser.navigate).toHaveBeenCalledWith("abc", "https://target");
  });

  it("POST /browser/:id/click forwards selector", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser/s1/click",
      payload: { selector: "button.submit" },
    });
    expect(res.json().ok).toBe(true);
    expect(browser.click).toHaveBeenCalledWith("s1", "button.submit");
  });

  it("POST /browser/:id/type forwards selector + text", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser/s1/type",
      payload: { selector: "input#q", text: "hello" },
    });
    expect(res.json().ok).toBe(true);
    expect(browser.type).toHaveBeenCalledWith("s1", "input#q", "hello");
  });

  it("POST /browser/:id/screenshot forwards fullPage flag", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser/s1/screenshot",
      payload: { fullPage: true },
    });
    expect(res.json().ok).toBe(true);
    expect(res.json().screenshot).toMatch(/^data:image/);
    expect(browser.screenshot).toHaveBeenCalledWith("s1", true);
  });

  it("POST /browser/:id/screenshot defaults fullPage to false when omitted", async () => {
    await app.inject({
      method: "POST",
      url: "/browser/s1/screenshot",
      payload: {},
    });
    expect(browser.screenshot).toHaveBeenCalledWith("s1", false);
  });

  it("GET /browser/sessions returns session list", async () => {
    const res = await app.inject({ method: "GET", url: "/browser/sessions" });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions).toEqual([{ id: "s1", url: "https://x" }]);
  });

  it("every action gracefully wraps errors (sample: navigate)", async () => {
    browser.navigate.mockRejectedValueOnce(new Error("page closed"));
    const res = await app.inject({
      method: "POST",
      url: "/browser/x/navigate",
      payload: { url: "y" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: "page closed" });
  });
});
