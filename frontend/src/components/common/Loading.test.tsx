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

  it("renders in inline mode by default", () => {
    const { container } = render(<Loading />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.padding).toBe("80px 0px");
  });

  it("renders in fullscreen mode when fullScreen is true", () => {
    const { container } = render(<Loading fullScreen />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.height).toBe("100vh");
    expect(wrapper.style.display).toBe("flex");
  });
});
