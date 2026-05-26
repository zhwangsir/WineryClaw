import { describe, it, expect } from "vitest";
import { getJson, postJson } from "./fetch-helper";

const SUB_URL = "http://127.0.0.1:3456";

describe("Channels API", () => {
  it("should list channels", async () => {
    const resp = await getJson(`${SUB_URL}/channels/list`, 5000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("channels");
    expect(Array.isArray(resp.data.channels)).toBe(true);
  });

  it("should connect a test channel", async () => {
    const resp = await postJson(`${SUB_URL}/channels/connect`, {
      id: "test-api-channel",
      type: "webpush",
      name: "Test API Channel",
      config: { vapidPublicKey: "test", vapidPrivateKey: "test", vapidSubject: "mailto:test@test.com" },
    }, 5000);
    expect([200, 201, 409]).toContain(resp.status);
  });
});
