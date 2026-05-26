/**
 * @vitest-environment jsdom
 *
 * v2.32 — PrivacyPanel tests (P1 #8). Covers:
 *   - initial fetch + render of status (mode, local/remote endpoint lists)
 *   - Switch toggle posts /privacy/toggle?mode=on|off and refreshes
 *   - warning banner when ON but no local endpoints configured
 *   - refresh button re-fetches
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PrivacyPanel from "./PrivacyPanel";

vi.mock("../../api/client", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from "../../api/client";

describe("PrivacyPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders OFF state with local endpoints list", async () => {
    vi.mocked(api.get).mockResolvedValue({
      mode: "off",
      local_endpoints: [{ name: "lmstudio", base_url: "http://127.0.0.1:1234/v1" }],
      remote_endpoints: [{ name: "openai", base_url: "https://api.openai.com/v1" }],
    });
    render(<PrivacyPanel />);
    await waitFor(() => expect(screen.getByText("关闭")).toBeInTheDocument());
    expect(screen.getByText(/本地 endpoint \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/远程 endpoint \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("lmstudio")).toBeInTheDocument();
  });

  it("renders ON state with remote endpoints marked blocked", async () => {
    vi.mocked(api.get).mockResolvedValue({
      mode: "on",
      local_endpoints: [{ name: "ollama", base_url: "http://localhost:11434" }],
      remote_endpoints: [{ name: "openai", base_url: "https://api.openai.com/v1" }],
    });
    render(<PrivacyPanel />);
    await waitFor(() => expect(screen.getByText("已开启")).toBeInTheDocument());
    // remote endpoints get "(已屏蔽)" annotation when mode=on
    expect(screen.getByText(/已屏蔽/)).toBeInTheDocument();
  });

  it("shows warning banner when ON without local endpoints", async () => {
    vi.mocked(api.get).mockResolvedValue({
      mode: "on",
      local_endpoints: [],
      remote_endpoints: [{ name: "openai", base_url: "https://api.openai.com/v1" }],
    });
    render(<PrivacyPanel />);
    await waitFor(() => expect(screen.getByText(/没有本地 endpoint/)).toBeInTheDocument());
  });

  it("toggling the switch posts /privacy/toggle and refreshes", async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({ mode: "off", local_endpoints: [], remote_endpoints: [] })
      .mockResolvedValueOnce({ mode: "on", local_endpoints: [], remote_endpoints: [] });
    vi.mocked(api.post).mockResolvedValue({ ok: true, mode: "on" });

    render(<PrivacyPanel />);
    await waitFor(() => expect(screen.getByText("关闭")).toBeInTheDocument());

    const sw = screen.getByRole("switch");
    fireEvent.click(sw);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/brain/privacy/toggle?mode=on");
    });
    // status re-fetched after toggle
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  // ─────────────────────────────────────────────────────────────────────
  // v2.38 — error paths.
  // ─────────────────────────────────────────────────────────────────────

  it("v2.38: api.get rejection does not crash; Card title still renders", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error("network down"));
    render(<PrivacyPanel />);
    await waitFor(() => {
      expect(screen.getByText("隐私模式")).toBeInTheDocument();
    });
    // status stays null → the dynamic mode tag ("已开启" / "关闭") should
    // be absent, and the endpoint-count <strong> lines (formatted as
    // "本地 endpoint (N):") shouldn't render. The description paragraph
    // contains "本地 endpoint" as plain text though, so we anchor on the
    // unique parenthesized-count form.
    expect(screen.queryByText(/本地 endpoint \(\d/)).toBeNull();
    expect(screen.queryByText("已开启")).toBeNull();
    expect(screen.queryByText("关闭")).toBeNull();
  });

  it("v2.38: toggle failure does NOT re-fetch (refresh skipped)", async () => {
    vi.mocked(api.get).mockResolvedValue({
      mode: "off",
      local_endpoints: [],
      remote_endpoints: [],
    });
    vi.mocked(api.post).mockRejectedValueOnce(new Error("503"));
    render(<PrivacyPanel />);
    await waitFor(() => expect(screen.getByText("关闭")).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    // Critical: a failed POST must NOT trigger a re-fetch — the second
    // api.get would race against the user toggle's "toggling" spinner and
    // flicker state. The handler's finally block clears `toggling` but
    // does NOT call refresh on rejection.
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
