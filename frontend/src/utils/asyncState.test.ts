import { describe, it, expect, vi } from "vitest";
import {
  createAsyncState,
  setLoading,
  setSuccess,
  setError,
  isStale,
} from "./asyncState";

describe("asyncState", () => {
  it("createAsyncState returns initial state", () => {
    const state = createAsyncState("hello");
    expect(state).toEqual({
      data: "hello",
      loading: false,
      error: null,
      lastUpdated: 0,
    });
  });

  it("setLoading sets loading true and clears error", () => {
    const state = createAsyncState(0);
    const loaded = setLoading({ ...state, error: new Error("oops") });
    expect(loaded.loading).toBe(true);
    expect(loaded.error).toBeNull();
  });

  it("setSuccess sets data and loading false", () => {
    const state = createAsyncState(0);
    const before = Date.now();
    const success = setSuccess(setLoading(state), 42);
    expect(success.data).toBe(42);
    expect(success.loading).toBe(false);
    expect(success.error).toBeNull();
    expect(success.lastUpdated).toBeGreaterThanOrEqual(before);
  });

  it("setError sets error and loading false", () => {
    const state = setLoading(createAsyncState(0));
    const err = new Error("fail");
    const failed = setError(state, err);
    expect(failed.loading).toBe(false);
    expect(failed.error).toBe(err);
  });

  it("isStale returns true when data is older than staleMs", () => {
    const fresh = setSuccess(createAsyncState(0), 1);
    expect(isStale(fresh, 50)).toBe(false);

    const old = { ...fresh, lastUpdated: Date.now() - 200 };
    expect(isStale(old, 50)).toBe(true);
    expect(isStale(old, 500)).toBe(false);
  });
});
