/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import SettingsPage from "./SettingsPage";

// v2.38: SettingsPage mounts ALL child panels — each fires its own GET on
// mount. We stub api.client at the top level with an URL-pattern dispatcher
// that returns harmless empty data for any endpoint. Without this, each
// panel's useEffect would throw an unhandled rejection.
vi.mock("../api/client", () => {
  const get = vi.fn(async (url: string) => {
    // Privacy
    if (url.startsWith("/brain/privacy/status")) {
      return { mode: "off", local_endpoints: [], remote_endpoints: [] };
    }
    // Network ledger
    if (url.startsWith("/brain/audit/network_ledger")) {
      return { count: 0, total: 0, entries: [], path: "/tmp/n.jsonl" };
    }
    // MCP audit ledger
    if (url.startsWith("/brain/audit/mcp_ledger")) {
      return {
        count: 0,
        entries: [],
        path: "/tmp/mcp.jsonl",
        stats: { total: 0, by_tool: {}, by_scope: {}, success: 0, failure: 0 },
      };
    }
    // Model / health / mcp info / global / about / api-token endpoints
    // — return undefined-shaped data; each panel handles its own
    // null-checks. The point of THIS test is page+tab integration, not
    // per-panel internals.
    return {};
  });
  return {
    api: {
      get,
      post: vi.fn().mockResolvedValue({ ok: true }),
      put: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
});

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders page shell", () => {
    render(
      <BrowserRouter>
        <SettingsPage />
      </BrowserRouter>
    );
    expect(screen.getByText("设置")).toBeInTheDocument();
  });

  it("v2.38: «安全» tab mounts PrivacyPanel (verifies v2.32 P1 #8 wiring)", async () => {
    render(
      <BrowserRouter>
        <SettingsPage />
      </BrowserRouter>
    );
    // Click the «安全» tab — antd Tabs render label text as a clickable role=tab.
    const safetyTab = screen.getByRole("tab", { name: /安全/ });
    fireEvent.click(safetyTab);
    // PrivacyPanel's Card title is "隐私模式" — a unique string to this panel.
    await waitFor(() => {
      expect(screen.getByText("隐私模式")).toBeInTheDocument();
    });
  });

  it("v2.38: «审计» tab mounts BOTH NetworkLedger and MCPAudit panels", async () => {
    render(
      <BrowserRouter>
        <SettingsPage />
      </BrowserRouter>
    );
    const auditTab = screen.getByRole("tab", { name: /审计/ });
    fireEvent.click(auditTab);
    // NetworkLedger title is "网络出站审计"; MCPAudit title is "MCP 调用审计".
    await waitFor(() => {
      expect(screen.getByText(/网络出站审计/)).toBeInTheDocument();
      expect(screen.getByText("MCP 调用审计")).toBeInTheDocument();
    });
  });

  it("v2.38: all expected top-level tabs are present", () => {
    render(
      <BrowserRouter>
        <SettingsPage />
      </BrowserRouter>
    );
    // 4 tabs that v2.32 set up: model / general / security / audit
    expect(screen.getByRole("tab", { name: /模型/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /通用/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /安全/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /审计/ })).toBeInTheDocument();
  });
});
