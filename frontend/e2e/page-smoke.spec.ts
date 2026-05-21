import { test, expect } from "@playwright/test";

const BASE = "http://localhost:8587";

const PAGES = [
  { path: "/", label: "User Chat" },
  { path: "/admin", label: "Admin Dashboard" },
  { path: "/admin/agents", label: "Agents" },
  { path: "/admin/memory", label: "Memory" },
  { path: "/admin/wiki", label: "Wiki" },
  { path: "/admin/uploads", label: "Uploads" },
  { path: "/admin/channels", label: "Channels" },
  { path: "/admin/workflows", label: "Workflows" },
  { path: "/admin/templates", label: "Templates" },
  { path: "/admin/skillhub", label: "Skillhub" },
  { path: "/admin/plugins", label: "Plugins" },
  { path: "/admin/tools", label: "Tools" },
  { path: "/admin/mcp", label: "MCP" },
  { path: "/admin/cron", label: "Cron" },
  { path: "/admin/hooks", label: "Hooks" },
  { path: "/admin/config", label: "Config" },
  { path: "/admin/metrics", label: "Metrics" },
  { path: "/admin/settings", label: "Settings" },
  { path: "/admin/kg", label: "Knowledge Graph" },
  { path: "/admin/a2a", label: "A2A" },
  { path: "/admin/identity", label: "Identity" },
];

// Errors that are expected when the sub-brain backend isn't running
// (network failures are handled gracefully by the UI)
const EXPECTED_NOISE = [
  "Failed to load resource",
  "net::ERR_",
  "favicon",
  "ERR_CONNECTION_REFUSED",
];

function isNoise(msg: string) {
  return EXPECTED_NOISE.some((n) => msg.includes(n));
}

for (const { path, label } of PAGES) {
  test(`${label} — no JS errors (${path})`, async ({ page }) => {
    const errors: string[] = [];

    // Only collect JS-level errors (type="error"), not network errors
    page.on("console", (msg) => {
      if (msg.type() === "error" && !isNoise(msg.text())) {
        errors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      errors.push(`UNCAUGHT: ${err.message}`);
    });

    // Mock sub-brain backend calls (port 3000 / vite proxy paths)
    // Only mock paths that the proxy would forward — avoid matching Vite module scripts
    await page.route("**/localhost:3000/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );

    await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 15000 });
    // Let lazy-loaded components settle
    await page.waitForTimeout(800);

    expect(errors, `JS errors on ${path}:\n${errors.join("\n")}`).toHaveLength(0);
  });
}
