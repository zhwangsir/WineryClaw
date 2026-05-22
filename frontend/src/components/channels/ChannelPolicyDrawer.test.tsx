/**
 * @vitest-environment jsdom
 *
 * v2.33 — ChannelPolicyDrawer tests (closes v2.30 UI gap).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ChannelPolicyDrawer from "./ChannelPolicyDrawer";

vi.mock("../../api/channels", () => ({
  channelsApi: {
    getPolicy: vi.fn(),
    setPolicy: vi.fn(),
    clearPolicy: vi.fn(),
    policyAudit: vi.fn(),
  },
}));

import { channelsApi } from "../../api/channels";

describe("ChannelPolicyDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(channelsApi.policyAudit).mockResolvedValue({
      ok: true,
      count: 0,
      entries: [],
    });
  });

  it("does not fetch when not open", async () => {
    vi.mocked(channelsApi.getPolicy).mockResolvedValue({ ok: true, policy: null });
    render(<ChannelPolicyDrawer channelId="c1" open={false} onClose={() => {}} />);
    // Wait a tick — getPolicy should NOT be called for closed drawer.
    await new Promise((r) => setTimeout(r, 50));
    expect(channelsApi.getPolicy).not.toHaveBeenCalled();
  });

  it("loads existing policy on open", async () => {
    vi.mocked(channelsApi.getPolicy).mockResolvedValue({
      ok: true,
      policy: {
        agentId: "agent-x",
        senderAllow: ["alice"],
        keywordBlock: ["spam"],
        maxRepliesPerHour: 5,
      },
    });
    render(<ChannelPolicyDrawer channelId="c1" open={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(channelsApi.getPolicy).toHaveBeenCalledWith("c1");
    });
    // Form populated with the loaded values
    expect(screen.getByDisplayValue("agent-x")).toBeInTheDocument();
  });

  it("save serializes form to ChannelPolicy and posts", async () => {
    vi.mocked(channelsApi.getPolicy).mockResolvedValue({ ok: true, policy: null });
    vi.mocked(channelsApi.setPolicy).mockResolvedValue({
      ok: true,
      policy: { agentId: "agent-x" },
    });

    render(<ChannelPolicyDrawer channelId="c1" open={true} onClose={() => {}} />);
    await waitFor(() => expect(channelsApi.getPolicy).toHaveBeenCalled());

    const input = screen.getByPlaceholderText("agent-xxx") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "agent-x" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      expect(channelsApi.setPolicy).toHaveBeenCalledWith("c1", { agentId: "agent-x" });
    });
  });

  it("dropping empty arrays/zeros from form when serializing", async () => {
    vi.mocked(channelsApi.getPolicy).mockResolvedValue({ ok: true, policy: null });
    vi.mocked(channelsApi.setPolicy).mockResolvedValue({ ok: true, policy: {} });

    render(<ChannelPolicyDrawer channelId="c1" open={true} onClose={() => {}} />);
    await waitFor(() => expect(channelsApi.getPolicy).toHaveBeenCalled());
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => {
      // Empty form should produce {} — not {agentId: "", senderAllow: [], ...}
      expect(channelsApi.setPolicy).toHaveBeenCalledWith("c1", {});
    });
  });
});
