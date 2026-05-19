import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub the tool registry + built-ins so we don't pull in axios/playwright/etc.
const mockGet = vi.fn();
vi.mock("../src/tools/tool-registry.js", () => ({
  registry: {
    get: (...args: unknown[]) => mockGet(...args),
    list: () => [],
  },
}));
vi.mock("../src/tools/built-in-tools.js", () => ({
  registerAllTools: vi.fn(),
}));

const { ToolExecutor } = await import("../src/tools/tool-executor.js");
const { hookRegistry } = await import("../src/plugin-sdk/hooks.js");

describe("ToolExecutor + plugin hooks", () => {
  let executor: InstanceType<typeof ToolExecutor>;
  const toolExecute = vi.fn();

  beforeEach(() => {
    executor = new ToolExecutor();
    // Pretend we have a tool named "echo".
    mockGet.mockReturnValue({ name: "echo", execute: toolExecute, category: "test", description: "", parameters: {} });
    // Enable it (default state, but be explicit).
    (executor as any).toolEnabled.set("echo", true);

    toolExecute.mockReset();

    // Wipe any leftover hooks from other tests.
    (hookRegistry as any).hooks.pre_tool_call.length = 0;
    (hookRegistry as any).hooks.post_tool_call.length = 0;
  });

  it("pre_tool_call hook returning {allowed: false} blocks tool execution", async () => {
    hookRegistry.register("pre_tool_call", async () => ({
      allowed: false,
      reason: "policy: echo is forbidden",
    }));

    const result = await executor.execute("echo", { text: "hi" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("policy: echo is forbidden");
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it("pre_tool_call hook with {modified} rewrites params before tool runs", async () => {
    hookRegistry.register("pre_tool_call", async () => ({
      allowed: true,
      modified: { text: "REWRITTEN" },
    }));
    toolExecute.mockResolvedValue("ok");

    const result = await executor.execute("echo", { text: "original" });

    expect(result.ok).toBe(true);
    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(toolExecute.mock.calls[0][0]).toEqual({ text: "REWRITTEN" });
  });

  it("post_tool_call hook is invoked with the result after a successful execution", async () => {
    const postHook = vi.fn(async () => ({ allowed: true }));
    hookRegistry.register("post_tool_call", postHook);
    toolExecute.mockResolvedValue({ value: 42 });

    const result = await executor.execute("echo", { x: 1 });

    expect(result.ok).toBe(true);
    expect(postHook).toHaveBeenCalledTimes(1);
    expect(postHook.mock.calls[0][0].tool).toBe("echo");
    expect(postHook.mock.calls[0][1]).toEqual({ value: 42 });
  });

  it("multiple pre_tool_call hooks short-circuit on the first that denies", async () => {
    const first = vi.fn(async () => ({ allowed: true }));
    const second = vi.fn(async () => ({ allowed: false, reason: "second blocks" }));
    const third = vi.fn(async () => ({ allowed: true }));
    hookRegistry.register("pre_tool_call", first);
    hookRegistry.register("pre_tool_call", second);
    hookRegistry.register("pre_tool_call", third);

    const result = await executor.execute("echo", {});

    expect(result.ok).toBe(false);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it("tool execution still happens normally when no hooks are registered", async () => {
    toolExecute.mockResolvedValue("done");
    const result = await executor.execute("echo", { a: 1 });
    expect(result.ok).toBe(true);
    expect(result.result).toBe("done");
  });

  it("post_tool_call hook is NOT invoked when the underlying tool throws", async () => {
    const postHook = vi.fn(async () => ({ allowed: true }));
    hookRegistry.register("post_tool_call", postHook);
    toolExecute.mockRejectedValue(new Error("kaboom"));

    const result = await executor.execute("echo", {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("kaboom");
    expect(postHook).not.toHaveBeenCalled();
  });
});
