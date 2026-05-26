import { describe, it, expect } from "vitest";
import { postJson } from "./fetch-helper";

const MAIN_URL = "http://127.0.0.1:3456/brain";

async function isModelAvailable(): Promise<boolean> {
  try {
    const r = await postJson(`${MAIN_URL}/chat`, { message: "ping", session_id: "test-ping" }, 10000);
    return r.status === 200;
  } catch { return false; }
}

describe("Chat API", () => {
  it("should send a chat message", async () => {
    if (!(await isModelAvailable())) {
      console.log("[skip] Chat test: no LLM model configured");
      return;
    }
    const resp = await postJson(`${MAIN_URL}/chat`, {
      message: "Hello from test",
      session_id: "test-chat-session",
    }, 30000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("reply");
    expect(resp.data).toHaveProperty("session_id");
  }, 60000);

  it("should get chat history", async () => {
    if (!(await isModelAvailable())) {
      console.log("[skip] Chat test: no LLM model configured");
      return;
    }
    const resp = await postJson(`${MAIN_URL}/chat`, {
      message: "test history",
      session_id: "test-chat-session",
    }, 30000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("reply");
  }, 60000);
});
