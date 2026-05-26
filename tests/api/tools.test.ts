import { describe, it, expect } from "vitest";
import { getJson, postJson } from "./fetch-helper";

const SUB_URL = "http://127.0.0.1:3456";

describe("POST /tools/execute", () => {
  it("should execute shell tool", async () => {
    const resp = await postJson(`${SUB_URL}/tools/execute`, {
      tool: "shell", params: { command: "echo api_shell_test" }
    }, 10000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("ok", true);
    expect(resp.data.result).toHaveProperty("output");
    expect(resp.data.result.output).toContain("api_shell_test");
    expect(resp.data.result).toHaveProperty("exitCode", 0);
  });

  it("should execute calculator tool", async () => {
    const resp = await postJson(`${SUB_URL}/tools/execute`, {
      tool: "calculator", params: { expression: "2 + 2 * 3" }
    }, 10000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("ok", true);
    expect(resp.data.result).toHaveProperty("result", 8);
    expect(resp.data.result).toHaveProperty("expression", "2 + 2 * 3");
  });

  it("should execute python_exec tool", async () => {
    const resp = await postJson(`${SUB_URL}/tools/execute`, {
      tool: "python_exec", params: { code: "print(1 + 1)" }
    }, 10000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("ok", true);
    expect(resp.data.result).toHaveProperty("output");
    expect(resp.data.result.output.trim()).toBe("2");
  });

  it("should list available tools", async () => {
    const resp = await getJson(`${SUB_URL}/tools/list`, 5000);
    expect(resp.status).toBe(200);
    expect(resp.data).toHaveProperty("tools");
    expect(Array.isArray(resp.data.tools)).toBe(true);
    const toolNames = resp.data.tools.map((t: any) => t.name);
    expect(toolNames).toContain("shell");
    expect(toolNames).toContain("calculator");
    expect(toolNames).toContain("python_exec");
  });
});
