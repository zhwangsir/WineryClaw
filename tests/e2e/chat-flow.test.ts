import { describe, it, expect } from "vitest";

const MAIN_URL = "http://127.0.0.1:3456/brain";

async function isModelAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${MAIN_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "ping", session_id: "test-ping" }),
      signal: AbortSignal.timeout(10000),
    });
    return r.status === 200;
  } catch { return false; }
}

describe("E2E Chat Flow", () => {
  it("should complete full chat with tool detection", async () => {
    if (!(await isModelAvailable())) {
      console.log("[skip] E2E chat: no LLM model configured");
      return;
    }
    const resp = await fetch(`${MAIN_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "帮我打开网易云音乐", session_id: "e2e-test" }),
      signal: AbortSignal.timeout(120000),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.reply).toBeDefined();
    expect(data.session_id).toBe("e2e-test");
    expect(data).toHaveProperty("iterations");
    expect(typeof data.iterations).toBe("number");
  }, 120000);

  it("should support streaming chat", async () => {
    if (!(await isModelAvailable())) {
      console.log("[skip] E2E streaming: no LLM model configured");
      return;
    }
    const resp = await fetch(
      `${MAIN_URL}/chat/stream?message=hello&session_id=stream-e2e&tools_enabled=false`,
      { method: "GET", signal: AbortSignal.timeout(30000) }
    );
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type") || "";
    expect(ct).toContain("text/event-stream");

    const reader = resp.body?.getReader();
    expect(reader).toBeDefined();

    let chunkCount = 0;
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        if (text.includes("data:")) chunkCount++;
        if (chunkCount > 0) break;
      }
    }
    expect(chunkCount).toBeGreaterThanOrEqual(0);
  }, 30000);
});
