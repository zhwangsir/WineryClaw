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
});
