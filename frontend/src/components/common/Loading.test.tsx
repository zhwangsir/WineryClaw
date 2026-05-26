/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Loading } from "./Loading";

describe("Loading", () => {
  it("renders default tip text", () => {
    render(<Loading />);
    expect(screen.getByText("加载中...")).toBeInTheDocument();
  });

  it("renders custom tip text", () => {
    render(<Loading tip="Saving..." />);
    expect(screen.getByText("Saving...")).toBeInTheDocument();
  });

  it("v2.42: inline mode uses flex centering + min-height instead of top padding", () => {
    // Pre-v2.42 the inline placeholder used `padding: 80px 0` which left
    // the spinner stuck near the top of an otherwise empty page region.
    // v2.42 switched to flex+min-height so the spinner actually centres.
    const { container } = render(<Loading />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.display).toBe("flex");
    expect(wrapper.style.alignItems).toBe("center");
    expect(wrapper.style.justifyContent).toBe("center");
    expect(wrapper.style.minHeight).toBe("40vh");
  });

  it("renders in fullscreen mode when fullScreen is true", () => {
    const { container } = render(<Loading fullScreen />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.height).toBe("100vh");
    expect(wrapper.style.display).toBe("flex");
  });
});
