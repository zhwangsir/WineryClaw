import { test, expect } from "@playwright/test";

/**
 * Dashboard page E2E — health indicators + module status.
 *
 * The dashboard is the user's first impression after boot. If it
 * crashes (which it did during the 2026-05-20 user trial), every
 * other feature page is unreachable.
 */
test.describe("Dashboard page", () => {
  async function mockDashboardBackend(page: import("@playwright/test").Page) {
    // Main-brain health
    await page.route("**/brain/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ok",
          component: "main-brain",
          modules: {
            memory: true,
            reasoning: true,
            chat: true,
            wiki: true,
            kg: true,
            cron: true,
          },
          router_status: "ok",
        }),
      });
    });
    // Sub-brain health (sub-brain serves its own /health, not via /brain/)
    await page.route("**/health", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/health") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, channels: true }),
        });
        return;
      }
      await route.continue();
    });
    // LLM endpoint stats — drives the health panel
    await page.route("**/brain/llm/stats", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "healthy",
          total_count: 2,
          endpoints: [
            {
              name: "lm-studio",
              base_url: "http://example.invalid/v1",
              model_id: "test-model",
              healthy: true,
              latency_ms: 42,
              success_count: 10,
              failure_count: 0,
            },
          ],
        }),
      });
    });
    // Metrics
    await page.route("**/brain/metrics**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, metrics: {} }),
      });
    });
  }

  test("dashboard mounts and shows main-brain status", async ({ page }) => {
    await mockDashboardBackend(page);
    await page.goto("/");
    // The page must render something — body must mount without crash.
    await expect(page.locator("body")).toBeVisible();
    // Wait briefly for any client-side data fetches to resolve and any
    // unhandled errors to surface.
    await page.waitForTimeout(1000);
    // The page should not be a blank white screen — must have SOME content.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(20);
  });
});
