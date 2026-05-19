import { test, expect } from "@playwright/test";

/**
 * Chat flow E2E — covers the critical send-and-render path.
 * Mocks all /brain/chat/* endpoints so no real backend is needed.
 *
 * Note: ChatPage unconditionally uses sendStream (SSE) — see chatStore.sendStream.
 * We mock the SSE endpoint by fulfilling text/event-stream with a single
 * well-formed event so the client emits one onChunk and one onDone.
 */
test.describe("Chat flow", () => {
  async function mockChatBackend(page: import("@playwright/test").Page, replyText: string) {
    // Sessions list (empty so newSession() generates a fresh ID)
    await page.route("**/brain/chat/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });

    // History fetch — return empty
    await page.route("**/brain/chat/history**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: [] }),
      });
    });

    // SSE stream endpoint: one content chunk then EOF.
    await page.route("**/brain/chat/stream**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({ type: "content", data: replyText })}\n\n` +
          `data: ${JSON.stringify({ type: "done" })}\n\n`,
      });
    });

    // Fallback non-streaming endpoint (in case the UI ever falls back)
    await page.route("**/brain/chat", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ reply: replyText }),
        });
      } else {
        await route.continue();
      }
    });
  }

  test("user message + assistant reply render", async ({ page }) => {
    await mockChatBackend(page, "Hello from mock");

    await page.goto("/chat");

    const textarea = page.getByPlaceholder("输入消息…");
    await expect(textarea).toBeVisible({ timeout: 10000 });

    await textarea.fill("hi");
    await textarea.press("Enter");

    // User's own message should appear immediately.
    await expect(page.getByText("hi", { exact: true })).toBeVisible({ timeout: 5000 });

    // Assistant's mocked reply should appear after the SSE chunk is processed.
    await expect(page.getByText("Hello from mock")).toBeVisible({ timeout: 10000 });
  });

  test("empty input does not trigger send", async ({ page }) => {
    let streamCalled = false;
    await page.route("**/brain/chat/stream**", async (route) => {
      streamCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "done" })}\n\n`,
      });
    });
    await page.route("**/brain/chat/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });

    await page.goto("/chat");

    const textarea = page.getByPlaceholder("输入消息…");
    await expect(textarea).toBeVisible({ timeout: 10000 });

    // Press Enter on an empty textarea — handler should short-circuit.
    await textarea.press("Enter");
    await page.waitForTimeout(500);

    expect(streamCalled).toBe(false);
  });

  test("whitespace-only input does not trigger send", async ({ page }) => {
    let streamCalled = false;
    await page.route("**/brain/chat/stream**", async (route) => {
      streamCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "done" })}\n\n`,
      });
    });
    await page.route("**/brain/chat/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });

    await page.goto("/chat");

    const textarea = page.getByPlaceholder("输入消息…");
    await expect(textarea).toBeVisible({ timeout: 10000 });

    await textarea.fill("   ");
    await textarea.press("Enter");
    await page.waitForTimeout(500);

    expect(streamCalled).toBe(false);
  });
});
