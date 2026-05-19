import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOptimisticDelete, createDeleteThenRefetch } from "./utils";

vi.mock("antd", () => ({
  message: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { message } from "antd";

describe("createOptimisticDelete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes item optimistically and shows success", async () => {
    const state = { items: [{ id: "1" }, { id: "2" }] };
    const set = vi.fn((fn) => {
      if (typeof fn === "function") {
        Object.assign(state, fn(state));
      } else {
        Object.assign(state, fn);
      }
    });
    const get = vi.fn(() => state);
    const apiDelete = vi.fn().mockResolvedValue(undefined);

    const del = createOptimisticDelete(get, set, "items", apiDelete, {
      successMsg: "Deleted",
      errorMsg: "Failed",
    });

    await del("1");
    expect(state.items).toEqual([{ id: "2" }]);
    expect(apiDelete).toHaveBeenCalledWith("1");
    expect(message.success).toHaveBeenCalledWith("Deleted");
  });

  it("rolls back on api error", async () => {
    const state = { items: [{ id: "1" }, { id: "2" }] };
    const set = vi.fn((fn) => {
      if (typeof fn === "function") {
        Object.assign(state, fn(state));
      } else {
        Object.assign(state, fn);
      }
    });
    const get = vi.fn(() => state);
    const apiDelete = vi.fn().mockRejectedValue(new Error("network"));

    const del = createOptimisticDelete(get, set, "items", apiDelete, {
      successMsg: "Deleted",
      errorMsg: "Failed",
    });

    await del("1");
    expect(apiDelete).toHaveBeenCalledWith("1");
    expect(message.error).toHaveBeenCalledWith("network");
    expect(set).toHaveBeenLastCalledWith({ items: [{ id: "1" }, { id: "2" }] });
  });

  it("rolls back on api error without message", async () => {
    const state = { items: [{ id: "1" }] };
    const set = vi.fn((fn) => {
      if (typeof fn === "function") {
        Object.assign(state, fn(state));
      } else {
        Object.assign(state, fn);
      }
    });
    const get = vi.fn(() => state);
    const apiDelete = vi.fn().mockRejectedValue(new Error(""));

    const del = createOptimisticDelete(get, set, "items", apiDelete, {
      successMsg: "Deleted",
      errorMsg: "Failed",
    });

    await del("1");
    expect(message.error).toHaveBeenCalledWith("Failed");
  });

  it("applies extraUpdate on success", async () => {
    const state = { items: [{ id: "1" }], count: 1 };
    const set = vi.fn((fn) => {
      if (typeof fn === "function") {
        Object.assign(state, fn(state));
      } else {
        Object.assign(state, fn);
      }
    });
    const get = vi.fn(() => state);
    const apiDelete = vi.fn().mockResolvedValue(undefined);

    const del = createOptimisticDelete(get, set, "items", apiDelete, {
      successMsg: "Deleted",
      errorMsg: "Failed",
      extraUpdate: (_id, _prev, remaining) => ({ count: remaining.length }),
    });

    await del("1");
    expect(state.count).toBe(0);
  });

  it("calls onSuccess callback", async () => {
    const state = { items: [{ id: "1" }] };
    const set = vi.fn((fn) => {
      if (typeof fn === "function") {
        Object.assign(state, fn(state));
      } else {
        Object.assign(state, fn);
      }
    });
    const get = vi.fn(() => state);
    const apiDelete = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    const del = createOptimisticDelete(get, set, "items", apiDelete, {
      successMsg: "Deleted",
      errorMsg: "Failed",
      onSuccess,
    });

    await del("1");
    expect(onSuccess).toHaveBeenCalled();
  });
});

describe("createDeleteThenRefetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes and refetches on success", async () => {
    const apiDelete = vi.fn().mockResolvedValue(undefined);
    const refetch = vi.fn().mockResolvedValue(undefined);

    const del = createDeleteThenRefetch(apiDelete, refetch, {
      successMsg: "Deleted",
      errorMsg: "Failed",
    });

    await del("1");
    expect(apiDelete).toHaveBeenCalledWith("1");
    expect(message.success).toHaveBeenCalledWith("Deleted");
    expect(refetch).toHaveBeenCalled();
  });

  it("shows error on delete failure without refetch", async () => {
    const apiDelete = vi.fn().mockRejectedValue(new Error("bad"));
    const refetch = vi.fn().mockResolvedValue(undefined);

    const del = createDeleteThenRefetch(apiDelete, refetch, {
      successMsg: "Deleted",
      errorMsg: "Failed",
    });

    await del("1");
    expect(apiDelete).toHaveBeenCalledWith("1");
    expect(message.error).toHaveBeenCalledWith("bad");
    expect(refetch).not.toHaveBeenCalled();
  });

  it("shows default error on delete failure without message", async () => {
    const apiDelete = vi.fn().mockRejectedValue(new Error(""));
    const refetch = vi.fn().mockResolvedValue(undefined);

    const del = createDeleteThenRefetch(apiDelete, refetch, {
      successMsg: "Deleted",
      errorMsg: "Failed",
    });

    await del("1");
    expect(message.error).toHaveBeenCalledWith("Failed");
  });
});
