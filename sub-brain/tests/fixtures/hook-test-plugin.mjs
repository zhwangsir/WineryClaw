// Test fixture for plugin-hook-wiring.test.ts.
// Exposes one pre_tool_call hook plus minimal lifecycle stubs.

export const manifest = {
  id: "test-hook-plugin",
  name: "Hook Test Plugin",
  version: "1.0.0",
};

export const hooks = {
  pre_tool_call: async () => ({ allowed: true }),
};

export async function initialize() {}
export async function destroy() {}
