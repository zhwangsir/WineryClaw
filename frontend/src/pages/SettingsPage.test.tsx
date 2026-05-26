/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import SettingsPage from "./SettingsPage";

// v2.38: this test's job is to verify v2.32's NEW panels (Privacy /
// NetworkLedger / MCPAudit) mount in the right tabs. The unrelated panels
// (Model / Health / MCPInfo / Global / About / ApiToken) fire their own
// useEffect-mounted API calls — those panels each have their own dedicated
// unit tests and aren't what we're verifying here. Stub them with
// lightweight placeholders so their internals don't run during this test.
// Vitest treats useEffect-triggered unhandled rejections as test failures
// (exit code 1), so silent crashes from out-of-scope panels were turning
// this green test red on CI.
vi.mock("../components/settings/ModelConfigPanel", () => ({
  default: () => <div data-testid="stub-ModelConfigPanel" />,
}));
vi.mock("../components/settings/LLMHealthPanel", () => ({
  default: () => <div data-testid="stub-LLMHealthPanel" />,
}));
vi.mock("../components/settings/MCPInfoPanel", () => ({
  default: () => <div data-testid="stub-MCPInfoPanel" />,
}));
vi.mock("../components/settings/GlobalConfigPanel", () => ({
  default: () => <div data-testid="stub-GlobalConfigPanel" />,
}));
vi.mock("../components/settings/AboutPanel", () => ({
  default: () => <div data-testid="stub-AboutPanel" />,
}));
vi.mock("../components/settings/ApiTokenPanel", () => ({
  default: () => <div data-testid="stub-ApiTokenPanel" />,
}));

// Stub api.client for the v2.32 panels we DO want to render (so they
// fetch successfully and mount their Card title — which is what we
// assert on for tab-routing verification).
vi.mock("../api/client", () => {
  const get = vi.fn(async (url: string) => {
    if (url.startsWith("/brain/privacy/status")) {
      return { mode: "off", local_endpoints: [], remote_endpoints: [] };
    }
    if (url.startsWith("/brain/audit/network_ledger")) {
      return { count: 0, total: 0, entries: [], path: "/tmp/n.jsonl" };
    }
    if (url.startsWith("/brain/audit/mcp_ledger")) {
      return {
        count: 0,
        entries: [],
        path: "/tmp/mcp.jsonl",
        stats: { total: 0, by_tool: {}, by_scope: {}, success: 0, failure: 0 },
      };
    }
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
