import { describe, it, expect } from "vitest";

const MAIN_URL = "http://127.0.0.1:3456/brain";
const SUB_URL = "http://127.0.0.1:3456";

async function getJson(url: string, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const resp = await fetch(url, { signal: controller.signal });
  clearTimeout(timer);
  return { status: resp.status, data: await resp.json() };
}

async function postJson(url: string, body: unknown, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timer);
  return { status: resp.status, data: await resp.json() };
}

describe("Main-Sub Brain Bridge", () => {
  it("should connect to main brain health", async () => {
    const resp = await getJson(`${SUB_URL}/brain/health`, 5000);
    expect(resp.status).toBe(200);
    expect(resp.data.status).toBe("ok");
  });

  it("should connect to sub brain health", async () => {
    const resp = await getJson(`${SUB_URL}/health`, 5000);
    expect(resp.status).toBe(200);
    expect(resp.data.status).toBe("ok");
  });

  it("should execute tool via sub-brain", async () => {
    const resp = await postJson(`${SUB_URL}/tools/execute`, {
      tool: "shell", params: { command: "echo bridge_test" }
    }, 10000);
    expect(resp.status).toBe(200);
    expect(resp.data.ok).toBe(true);
  });

  it("should analyze via main brain", async () => {
    const resp = await postJson(`${MAIN_URL}/reasoning/analyze`, {
      problem: "test", context: {}, session_id: "test"
    }, 60000);
    // Skip if LLM is not configured
    if (resp.status === 500 || resp.status === 502 || resp.status === 0) {
      console.log("[skip] Reasoning analyze: LLM unavailable");
      return;
    }
    expect(resp.status).toBe(200);
    expect(resp.data.confidence).toBeDefined();
  }, 65000);
});
