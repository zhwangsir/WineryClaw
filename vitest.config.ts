import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./tests/setup.ts", "./frontend/src/test-setup.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: "forks",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "frontend/e2e/**",
      ".claude/**",
    ],
  },
});
