/**
 * Tool Execution System — v3 无安全限制版
 * 全程本地运行，无白名单/确认/密钥/路径检查
 */

import { registry, RegisteredTool } from "./tool-registry.js";
import { registerAllTools } from "./built-in-tools.js";
import { hookRegistry, type ToolCallContext } from "../plugin-sdk/hooks.js";

export interface ToolExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  enabled: boolean;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export class ToolExecutor {
  private globalEnabled = true;
  private toolEnabled = new Map<string, boolean>();

  async initialize(): Promise<void> {
    registerAllTools();
    for (const def of registry.list()) {
      this.toolEnabled.set(def.name, true);
    }
    console.log(`[tools] Registered ${registry.list().length} tools`);
  }

  async execute(name: string, params: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.globalEnabled) {
      return { ok: false, error: "工具执行全局已禁用" };
    }

    const registered = registry.get(name);
    if (!registered) {
      return { ok: false, error: `Tool not found: ${name}` };
    }

    if (this.toolEnabled.get(name) === false) {
      return { ok: false, error: `Tool disabled: ${name}` };
    }

    // Plugin pre_tool_call hooks: may block (allowed=false) or rewrite params (modified).
    // hookRegistry.runPreToolCall mutates ctx.params in place when result.modified is set.
    const ctx: ToolCallContext = { tool: name, params };
    const pre = await hookRegistry.runPreToolCall(ctx);
    if (!pre.allowed) {
      return { ok: false, error: pre.reason || pre.error || `Tool '${name}' blocked by plugin hook` };
    }

    try {
      const result = await registered.execute(ctx.params);
      // Plugin post_tool_call hooks: observability only — return value not used to mutate result.
      await hookRegistry.runPostToolCall(ctx, result);
      return { ok: true, result };
    } catch (err: any) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  listTools(): Array<{ name: string; description: string; enabled: boolean; category: string }> {
    return registry.list().map(def => ({
      name: def.name,
      description: def.description,
      enabled: this.toolEnabled.get(def.name) !== false,
      category: def.category,
    }));
  }

  enableTool(name: string): void {
    this.toolEnabled.set(name, true);
  }

  disableTool(name: string): void {
    this.toolEnabled.set(name, false);
  }

  setGlobalEnabled(enabled: boolean): void {
    this.globalEnabled = enabled;
  }
}
