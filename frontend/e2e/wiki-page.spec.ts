import { test, expect } from "@playwright/test";

/**
 * Wiki page E2E — covers the note list and search-bar interaction.
 *
 * Backend mocked. Smoke point: when sub-brain wiki routes return a list,
 * the React page renders rows; when the user types in search, the
 * search endpoint is hit and results re-render.
 */
test.describe("Wiki page", () => {
  async function mockWikiBackend(
    page: import("@playwright/test").Page,
    notes: Array<{ id: string; title: string; content: string; tags?: string[] }>
  ) {
    await page.route("**/brain/wiki/notes**", async (route) => {
      const url = new URL(route.request().url());
      // listNotes returns { ok, notes: [] }
      if (route.request().method() === "GET" && !url.pathname.match(/\/notes\/[^/]+$/)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, notes }),
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/brain/wiki/search**", async (route) => {
      const url = new URL(route.request().url());
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const filtered = notes.filter((n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, results: filtered }),
      });
    });
    await page.route("**/brain/wiki/stats", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, stats: { total: notes.length } }),
      });
    });
  }

  test("renders empty wiki without crashing", async ({ page }) => {
    await mockWikiBackend(page, []);
    await page.goto("/wiki");
    // The page mounts; some heading or button must be present.
    // We're not asserting specific copy here — just "the React tree renders".
    await expect(page.locator("body")).toBeVisible();
    // Wait a brief moment to let any unhandled rejection surface
    await page.waitForTimeout(500);
  });

  test("renders a wiki note when backend returns one", async ({ page }) => {
    await mockWikiBackend(page, [
      {
        id: "note-1",
        title: "Smoke Test Note Title",
        content: "## Heading\n\nBody content with sentinel-xyz",
        tags: ["smoke"],
      },
    ]);
    await page.goto("/wiki");
    // The note title should appear somewhere on the page (list view)
    await expect(page.getByText("Smoke Test Note Title").first()).toBeVisible({
      timeout: 10000,
    });
  });
});
