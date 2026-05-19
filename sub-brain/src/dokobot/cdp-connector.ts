/**
 * CDP Connector — Chrome DevTools Protocol integration
 */

export interface CDPSession {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  on: (event: string, callback: (params: any) => void) => void;
  close: () => Promise<void>;
}

export async function connectCDP(wsUrl: string): Promise<CDPSession | null> {
  try {
    // Try chrome-remote-interface first
    const { default: CDP } = await import("chrome-remote-interface");
    const client = await CDP({ target: wsUrl });
    return {
      send: (method, params) => client.send(method, params),
      on: (event, cb) => client.on(event, cb),
      close: () => client.close(),
    };
  } catch (err) { console.error("[cdp-connector] Error:", err);
    // Fallback: try puppeteer
    try {
      const puppeteer = await import("puppeteer");
      const browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      return {
        send: async (method, params) => {
          if (method === "Page.navigate") {
            await page.goto(params?.url as string);
            return {};
          }
          if (method === "Runtime.evaluate") {
            const result = await page.evaluate(params?.expression as string);
            return { result: { value: result } };
          }
          if (method === "Page.captureScreenshot") {
            const data = await page.screenshot({ encoding: "base64" });
            return { data };
          }
          return {};
        },
        on: () => {},
        close: async () => { await browser.close(); },
      };
    } catch (err) { console.error("[cdp-connector] Error:", err);
      return null;
    }
  }
}
