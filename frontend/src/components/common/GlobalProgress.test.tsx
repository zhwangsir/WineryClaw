/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { GlobalProgressBar, setGlobalLoading, _resetGlobalLoading } from "./GlobalProgress";

describe("GlobalProgressBar", () => {
  beforeEach(() => {
    _resetGlobalLoading();
  });

  it("is hidden when loading count is 0", () => {
    const { container } = render(<GlobalProgressBar />);
    expect(container.firstChild).toBeNull();
  });

  it("becomes visible after setGlobalLoading(1)", async () => {
    const { container } = render(<GlobalProgressBar />);
    setGlobalLoading(1);
    await waitFor(() => {
      expect(container.firstChild).not.toBeNull();
    });
  });

  it("becomes hidden after setGlobalLoading(-1)", async () => {
    const { container } = render(<GlobalProgressBar />);
    setGlobalLoading(1);
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    setGlobalLoading(-1);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("does not go below zero", async () => {
    const { container } = render(<GlobalProgressBar />);
    setGlobalLoading(1);
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    setGlobalLoading(-5);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("updates visibility when multiple components are mounted", async () => {
    const { container: c1 } = render(<GlobalProgressBar />);
    const { container: c2 } = render(<GlobalProgressBar />);

    setGlobalLoading(1);
    await waitFor(() => {
      expect(c1.firstChild).not.toBeNull();
      expect(c2.firstChild).not.toBeNull();
    });

    setGlobalLoading(-1);
    await waitFor(() => {
      expect(c1.firstChild).toBeNull();
      expect(c2.firstChild).toBeNull();
    });
  });
});
