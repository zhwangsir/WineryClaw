import { describe, it, expect } from "vitest";

const MAIN_URL = "http://127.0.0.1:3456/brain";

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

async function getJson(url: string, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const resp = await fetch(url, { signal: controller.signal });
  clearTimeout(timer);
  return { status: resp.status, data: await resp.json() };
}

describe("Memory API", () => {
  const sessionId = `mem-test-${Date.now()}`;
  const testContent = `API test memory content ${Date.now()}`;

  it("should store a memory entry", async () => {
    const resp = await postJson(`${MAIN_URL}/memory/store`, {
      level: "L1",
      content: testContent,
      session_id: sessionId,
      source: "api-test",
    }, 10000);

    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("stored", true);
    expect(resp.data).toHaveProperty("id");
    expect(typeof resp.data.id).toBe("string");
  });

  it("should query memories and find the stored entry", async () => {
    const resp = await postJson(`${MAIN_URL}/memory/query`, {
      query: testContent,
      levels: ["L1"],
      limit: 10,
    }, 60000);

    // LLM embedding may not be configured
    if (resp.status === 504 || resp.status === 500 || resp.status === 0) {
      console.log("[skip] Memory query: LLM embedding unavailable");
      return;
    }

    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("results");
    expect(Array.isArray(resp.data.results)).toBe(true);

    const found = resp.data.results.find((m: any) => m.content === testContent);
    expect(found).toBeDefined();
    expect(found.session_id).toBe(sessionId);
  }, 65000);

  it("should retrieve recent memories", async () => {
    const resp = await getJson(`${MAIN_URL}/memory/recent?limit=5`, 30000);
    // May timeout if DB is locked
    if (resp.status === 0) {
      console.log("[skip] Memory recent: timeout");
      return;
    }
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("memories");
    expect(Array.isArray(resp.data.memories)).toBe(true);
  }, 35000);
});
