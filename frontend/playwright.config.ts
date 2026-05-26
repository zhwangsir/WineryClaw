import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1, // 本地也允许 1 次重试：89 个测试中有真实后端 + 并发压力，偶发时序 flake 不算 bug
  workers: process.env.CI ? 1 : 5,  // 本地限 5 个并发 worker，避免 9 个 worker 下后端 SQLite 锁竞争导致 flake
  reporter: "list",
  use: {
    baseURL: "http://localhost:8587",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:8587",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
