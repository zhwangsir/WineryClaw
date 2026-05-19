import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Mock the DB layer so we don't pull in `node:sqlite` through Vite's transformer.
// The hook wire-up logic under test does not depend on real persistence — it only
// needs `db.prepare(...).run(...)` to be callable. PluginLoader also uses `.all()`
// during its (unused-here) initialize() path; stub it to be safe.
vi.mock("../src/db/sub-brain-db.js", () => ({
  subBrainDB: {
    getDb: () => ({
      prepare: () => ({
        run: () => undefined,
        all: () => [],
        get: () => undefined,
      }),
    }),
  },
}));

const { PluginLoader } = await import("../src/plugins/plugin-loader.js");
const { hookRegistry } = await import("../src/plugin-sdk/hooks.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/hook-test-plugin.mjs");
const PLUGIN_ID = "test-hook-plugin";

// hookRegistry is a module singleton — only count its internal array, never mutate.
function preToolCallCount(): number {
  return (hookRegistry as any).hooks.pre_tool_call.length;
}

describe("PluginLoader hook wire-up", () => {
  let loader: InstanceType<typeof PluginLoader>;

  beforeEach(() => {
    loader = new PluginLoader();
  });

  afterEach(async () => {
    // Best-effort cleanup: a failed test may leave the plugin loaded.
    try { await loader.unload(PLUGIN_ID); } catch { /* noop */ }
  });

  it("registers plugin hooks into hookRegistry on load", async () => {
    const before = preToolCallCount();

    const result = await loader.loadFromDisk(FIXTURE, PLUGIN_ID);
    expect(result.ok).toBe(true);
    expect(preToolCallCount()).toBe(before + 1);
  });

  it("unregisters plugin hooks on unload", async () => {
    const before = preToolCallCount();

    await loader.loadFromDisk(FIXTURE, PLUGIN_ID);
    expect(preToolCallCount()).toBe(before + 1);

    const result = await loader.unload(PLUGIN_ID);
    expect(result.ok).toBe(true);
    expect(preToolCallCount()).toBe(before);
  });

  it("does not accumulate hooks on reload (unload → load)", async () => {
    const before = preToolCallCount();

    await loader.loadFromDisk(FIXTURE, PLUGIN_ID);
    await loader.unload(PLUGIN_ID);
    await loader.loadFromDisk(FIXTURE, PLUGIN_ID);

    expect(preToolCallCount()).toBe(before + 1);
  });

  it("disable removes hooks; enable restores them", async () => {
    const before = preToolCallCount();

    await loader.loadFromDisk(FIXTURE, PLUGIN_ID);
    expect(preToolCallCount()).toBe(before + 1);

    await loader.disable(PLUGIN_ID);
    expect(preToolCallCount()).toBe(before);

    await loader.enable(PLUGIN_ID);
    expect(preToolCallCount()).toBe(before + 1);
  });
});
