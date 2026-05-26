import { describe, it, expect } from "vitest";
import { getJson, postJson } from "./fetch-helper";

const SUB_URL = "http://127.0.0.1:3456";

describe("Plugins API", () => {
  it("should list plugins", async () => {
    const resp = await getJson(`${SUB_URL}/plugins/list`, 5000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("plugins");
    expect(Array.isArray(resp.data.plugins)).toBe(true);
  });

  it("should get a plugin manifest", async () => {
    const list = await getJson(`${SUB_URL}/plugins/list`, 5000);
    if (list.data.plugins.length > 0) {
      const id = list.data.plugins[0].id;
      const resp = await getJson(`${SUB_URL}/plugins/${id}/manifest`, 5000);
      expect(resp.status).toBe(200);
      expect(resp.data).toHaveProperty("manifest");
    }
  });

  it("should enable and disable a plugin", async () => {
    const list = await getJson(`${SUB_URL}/plugins/list`, 5000);
    if (list.data.plugins.length > 0) {
      const id = list.data.plugins[0].id;
      const disable = await postJson(`${SUB_URL}/plugins/disable`, { id }, 5000);
      expect(disable.status).toBe(200);
      const enable = await postJson(`${SUB_URL}/plugins/enable`, { id }, 5000);
      expect(enable.status).toBe(200);
    }
  });
});
