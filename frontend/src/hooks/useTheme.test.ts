/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useThemeSync, useIsDark } from "./useTheme";

vi.mock("../stores/systemStore", () => ({
  useSystemStore: () => ({ theme: "dark" }),
}));

describe("useThemeSync", () => {
  it("sets data-theme attribute on html element", () => {
    renderHook(() => useThemeSync());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("useIsDark", () => {
  it("returns true when theme is dark", () => {
    const { result } = renderHook(() => useIsDark());
    expect(result.current).toBe(true);
  });
});
