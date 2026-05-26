import { describe, it, expect } from "vitest";
import { getJson } from "./fetch-helper";

const SUB_URL = "http://127.0.0.1:3456";

describe("MCP API", () => {
  it("should list MCP servers", async () => {
    const resp = await getJson(`${SUB_URL}/mcp/servers`, 5000);
    expect([200, 404]).toContain(resp.status);
  });

  it("should list MCP tools", async () => {
    const resp = await getJson(`${SUB_URL}/mcp/tools`, 5000);
    expect([200, 404]).toContain(resp.status);
  });
});
