/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { StorageAdapter, SessionStorageAdapter } from "./storage";

describe("StorageAdapter", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("get returns fallback when key is missing", () => {
    expect(StorageAdapter.get("missing", "default")).toBe("default");
  });

  it("get returns parsed value", () => {
    localStorage.setItem("key", JSON.stringify({ a: 1 }));
    expect(StorageAdapter.get("key", {})).toEqual({ a: 1 });
  });

  it("get returns fallback on invalid JSON", () => {
    localStorage.setItem("bad", "not-json");
    expect(StorageAdapter.get("bad", "fallback")).toBe("fallback");
  });

  it("set stores JSON string", () => {
    StorageAdapter.set("key", [1, 2]);
    expect(localStorage.getItem("key")).toBe("[1,2]");
  });

  it("set silently fails on quota exceeded", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    expect(() => StorageAdapter.set("key", "value")).not.toThrow();
    spy.mockRestore();
  });

  it("remove deletes key", () => {
    localStorage.setItem("key", "value");
    StorageAdapter.remove("key");
    expect(localStorage.getItem("key")).toBeNull();
  });

  it("remove silently fails on error", () => {
    const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("fail");
    });
    expect(() => StorageAdapter.remove("key")).not.toThrow();
    spy.mockRestore();
  });
});

describe("SessionStorageAdapter", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("get returns fallback when key is missing", () => {
    expect(SessionStorageAdapter.get("missing", 0)).toBe(0);
  });

  it("get returns parsed value", () => {
    sessionStorage.setItem("skey", JSON.stringify(true));
    expect(SessionStorageAdapter.get("skey", false)).toBe(true);
  });

  it("set stores JSON string", () => {
    SessionStorageAdapter.set("skey", { x: 1 });
    expect(sessionStorage.getItem("skey")).toBe('{"x":1}');
  });

  it("get returns fallback on invalid JSON", () => {
    sessionStorage.setItem("bad", "not-json");
    expect(SessionStorageAdapter.get("bad", "fallback")).toBe("fallback");
  });

  it("get returns fallback when key is null", () => {
    expect(SessionStorageAdapter.get("missing", 0)).toBe(0);
  });

  it("set silently fails on quota exceeded", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    expect(() => SessionStorageAdapter.set("key", "value")).not.toThrow();
    spy.mockRestore();
  });
});
