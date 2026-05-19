/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSWR, invalidateSWR } from "./useSWR";

beforeEach(() => {
  invalidateSWR("");
});

describe("useSWR", () => {
  it("execute returns fresh data on first call", async () => {
    const fetcher = vi.fn().mockResolvedValue(42);
    const { result } = renderHook(() => useSWR("key1", fetcher));
    const data = await result.current.execute();
    expect(data).toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("execute returns cached data without calling fetcher again", async () => {
    const fetcher = vi.fn().mockResolvedValue(99);
    const { result } = renderHook(() => useSWR("key2", fetcher, { staleTime: 60000 }));
    await result.current.execute();
    const data = await result.current.execute();
    expect(data).toBe(99);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("mutate clears cache and refetches", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const { result } = renderHook(() => useSWR("key3", fetcher, { staleTime: 60000 }));
    await result.current.execute();
    const data = await result.current.mutate();
    expect(data).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent requests", async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r(7), 50)));
    const { result } = renderHook(() => useSWR("key4", fetcher));
    const p1 = result.current.execute();
    const p2 = result.current.execute();
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(v1).toBe(7);
    expect(v2).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("removes failed promise so retry works", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValueOnce(5);
    const { result } = renderHook(() => useSWR("key5", fetcher, { staleTime: 0 }));
    await expect(result.current.execute()).rejects.toThrow("fail");
    const data = await result.current.execute();
    expect(data).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("invalidateSWR", () => {
  it("clears matching cache entries", async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    const { result } = renderHook(() => useSWR("prefix/foo", fetcher, { staleTime: 60000 }));
    await result.current.execute();
    invalidateSWR("prefix/");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const data = await result.current.execute();
    expect(data).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
