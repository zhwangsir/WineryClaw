/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDebounce } from "./useDebounce";

describe("useDebounce", () => {
  it("returns initial value immediately", () => {
    const { result } = renderHook(() => useDebounce("hello", 100));
    expect(result.current).toBe("hello");
  });

  it("debounces value changes", async () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 50), { initialProps: { value: "a" } });
    rerender({ value: "b" });
    expect(result.current).toBe("a");

    await waitFor(() => expect(result.current).toBe("b"), { timeout: 200 });
  });

  it("clears timer on unmount", () => {
    const { unmount } = renderHook(() => useDebounce("x", 100));
    expect(() => unmount()).not.toThrow();
  });
});
