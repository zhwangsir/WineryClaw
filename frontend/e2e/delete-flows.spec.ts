import { test, expect } from "@playwright/test";

async function waitForPageLoad(page: ReturnType<typeof test.extend>) {
  // Wait for antd spin / loading to disappear
  await page.waitForSelector(".ant-spin", { state: "detached", timeout: 5000 }).catch(() => {});
}

test.describe("Delete flows", () => {
  test("ChannelsPage: delete a channel", async ({ page }) => {
    const requests: string[] = [];
    const deletedIds: string[] = [];

    page.on("request", (req) => requests.push(`${req.method()} ${req.url()}`));

    await page.route("http://localhost:8587/api/channels", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          channels: [
            { id: "ch-e2e-1", name: "E2E Test Channel", type: "telegram", connected: false, createdAt: "2024-01-01T00:00:00Z" },
          ],
        }),
      });
    });

    await page.route("http://localhost:8587/api/channels/ch-e2e-1", async (route) => {
      if (route.request().method() === "DELETE") {
        deletedIds.push("ch-e2e-1");
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
      } else {
        await route.continue();
      }
    });

    await page.goto("/channels");
    await page.waitForTimeout(1000);
    console.log("Requests:", requests);

    await expect(page.getByText("E2E Test Channel")).toBeVisible({ timeout: 10000 });

    const deleteBtn = page.getByRole("button", { name: "删除" }).first();
    await deleteBtn.click();

    // Ant Design Modal.confirm
    const confirmModal = page.locator(".ant-modal-confirm");
    await expect(confirmModal).toBeVisible();
    await confirmModal.locator("button.ant-btn-dangerous").click();

    await expect(page.getByText("E2E Test Channel")).not.toBeVisible();
    expect(deletedIds).toContain("ch-e2e-1");
  });

  test("KnowledgeGraphPage: delete an entity", async ({ page }) => {
    const deletedIds: string[] = [];

    await page.route("http://localhost:8587/brain/kg/entities?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entities: [
            { id: "ent-e2e-1", name: "E2E Entity", type: "concept", description: "Test entity" },
          ],
        }),
      });
    });

    await page.route("http://localhost:8587/brain/kg/entities/ent-e2e-1", async (route) => {
      if (route.request().method() === "DELETE") {
        deletedIds.push("ent-e2e-1");
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
      } else {
        await route.continue();
      }
    });

    await page.goto("/kg");
    await waitForPageLoad(page);

    await expect(page.getByText("E2E Entity")).toBeVisible({ timeout: 10000 });

    const deleteBtn = page.getByRole("button", { name: "删除" }).first();
    await deleteBtn.click();

    const confirmModal = page.locator(".ant-modal-confirm");
    await expect(confirmModal).toBeVisible();
    await confirmModal.locator("button.ant-btn-dangerous").click();

    await expect(page.getByText("E2E Entity")).not.toBeVisible();
    expect(deletedIds).toContain("ent-e2e-1");
  });

  test("IdentityPage: delete a user", async ({ page }) => {
    const deletedIds: string[] = [];

    await page.route("http://localhost:8587/api/identity/users", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          users: [
            { id: "user-e2e-1", name: "E2E User", role: "user", workspaces: ["ws-1"], createdAt: "2024-01-01T00:00:00Z" },
          ],
        }),
      });
    });

    await page.route("http://localhost:8587/api/identity/user/user-e2e-1", async (route) => {
      if (route.request().method() === "DELETE") {
        deletedIds.push("user-e2e-1");
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
      } else {
        await route.continue();
      }
    });

    await page.goto("/identity");
    await waitForPageLoad(page);

    await expect(page.getByText("E2E User")).toBeVisible({ timeout: 10000 });

    const deleteBtn = page.getByRole("button", { name: "删除" }).first();
    await deleteBtn.click();

    const confirmModal = page.locator(".ant-modal-confirm");
    await expect(confirmModal).toBeVisible();
    await confirmModal.locator("button.ant-btn-dangerous").click();

    await expect(page.getByText("E2E User")).not.toBeVisible();
    expect(deletedIds).toContain("user-e2e-1");
  });

  test("ConfigPage: delete a workspace", async ({ page }) => {
    const deletedIds: string[] = [];

    await page.route("http://localhost:8587/api/config/workspaces", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workspaces: [
            { workspaceId: "ws-e2e-1", name: "E2E Workspace", description: "Test workspace", createdAt: "2024-01-01T00:00:00Z" },
          ],
        }),
      });
    });

    await page.route("http://localhost:8587/api/config/workspace/ws-e2e-1", async (route) => {
      if (route.request().method() === "DELETE") {
        deletedIds.push("ws-e2e-1");
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
      } else {
        await route.continue();
      }
    });

    await page.goto("/config");
    await waitForPageLoad(page);

    await expect(page.getByText("E2E Workspace")).toBeVisible({ timeout: 10000 });

    const deleteBtn = page.getByRole("button", { name: "删除" }).first();
    await deleteBtn.click();

    const confirmModal = page.locator(".ant-modal-confirm");
    await expect(confirmModal).toBeVisible();
    await confirmModal.locator("button.ant-btn-dangerous").click();

    await expect(page.getByText("E2E Workspace")).not.toBeVisible();
    expect(deletedIds).toContain("ws-e2e-1");
  });

  test("PluginsPage: delete a plugin", async ({ page }) => {
    const deletedIds: string[] = [];
    let listEmpty = false;

    await page.route("http://localhost:8587/api/plugins/list", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          plugins: listEmpty ? [] : [
            { id: "plugin-e2e-1", name: "E2E Plugin", version: "1.0.0", enabled: true, manifest: { permissions: [] } },
          ],
        }),
      });
    });

    await page.route("http://localhost:8587/api/plugins/plugin-e2e-1", async (route) => {
      if (route.request().method() === "DELETE") {
        deletedIds.push("plugin-e2e-1");
        listEmpty = true;
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
      } else {
        await route.continue();
      }
    });

    await page.goto("/plugins");
    await waitForPageLoad(page);

    await expect(page.getByText("E2E Plugin")).toBeVisible({ timeout: 10000 });

    const deleteBtn = page.getByRole("button", { name: "删除" }).first();
    await deleteBtn.click();

    const confirmModal = page.locator(".ant-modal-confirm");
    await expect(confirmModal).toBeVisible();
    await confirmModal.locator("button.ant-btn-dangerous").click();
    await expect(confirmModal).not.toBeVisible();

    await expect(page.getByText("E2E Plugin")).not.toBeVisible();
    expect(deletedIds).toContain("plugin-e2e-1");
  });
});
