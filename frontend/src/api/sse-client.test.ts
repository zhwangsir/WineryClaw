import { describe, it, expect, vi, beforeEach } from "vitest";
import { SSEClient } from "./sse-client";

function makeStream(lines: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: () => ({
      read: () => {
        if (index >= lines.length) return Promise.resolve({ done: true, value: undefined });
        const value = encoder.encode(lines[index++]);
        return Promise.resolve({ done: false, value });
      },
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    }),
  };
}

describe("SSEClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("webrain-api-key");
  });

  it("connects and receives JSON messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: makeStream(['data: {"msg":"hello"}\n', "data: [DONE]\n"]),
    });
    global.fetch = fetchMock;

    const msgs: unknown[] = [];
    const doneFn = vi.fn();
    const client = new SSEClient();
    await client.connect("/events", (d) => msgs.push(d), doneFn);

    expect(msgs).toEqual([{ msg: "hello" }]);
    expect(doneFn).toHaveBeenCalled();
  });

  it("receives raw string messages when JSON parse fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: makeStream(["data: plain text\n", "data: [DONE]\n"]),
    });

    const msgs: unknown[] = [];
    const client = new SSEClient();
    await client.connect("/events", (d) => msgs.push(d));

    expect(msgs).toContain("plain text");
  });

  it("sends auth header when token exists", async () => {
    localStorage.setItem("webrain-api-key", "test-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: makeStream(["data: [DONE]\n"]),
    });
    global.fetch = fetchMock;

    const client = new SSEClient();
    await client.connect("/events", vi.fn());

    expect(fetchMock).toHaveBeenCalledWith(
      "/events",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      })
    );
  });

  it("calls onError on HTTP error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const errFn = vi.fn();
    const client = new SSEClient({ maxRetries: 0 });
    await client.connect("/events", vi.fn(), vi.fn(), errFn);

    expect(errFn).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("500") }));
  });

  it("calls onError when body is null", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
    });

    const errFn = vi.fn();
    const client = new SSEClient({ maxRetries: 0 });
    await client.connect("/events", vi.fn(), vi.fn(), errFn);

    expect(errFn).toHaveBeenCalledWith(expect.objectContaining({ message: "Response body is null" }));
  });

  it("aborts connection and calls onError", async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      return new Promise((_, reject) => {
        setTimeout(() => reject({ name: "AbortError", message: "aborted" }), 50);
      });
    });
    global.fetch = fetchMock;

    const errFn = vi.fn();
    const client = new SSEClient();
    const connectPromise = client.connect("/events", vi.fn(), vi.fn(), errFn);

    client.abort();
    await connectPromise;

    expect(errFn).toHaveBeenCalledWith(expect.objectContaining({ message: "Connection aborted" }));
  });

  it("retries on failure then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue({
        ok: true,
        body: makeStream(["data: [DONE]\n"]),
      });
    global.fetch = fetchMock;

    const doneFn = vi.fn();
    const client = new SSEClient({ maxRetries: 2, baseRetryDelayMs: 10 });
    await client.connect("/events", vi.fn(), doneFn);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(doneFn).toHaveBeenCalled();
  });

  it("calls onError after max retries exhausted", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("persistent error"));

    const errFn = vi.fn();
    const client = new SSEClient({ maxRetries: 1, baseRetryDelayMs: 10 });
    await client.connect("/events", vi.fn(), vi.fn(), errFn);

    expect(errFn).toHaveBeenCalledWith(expect.objectContaining({ message: "persistent error" }));
  });

  it("calls onDone when stream ends without [DONE] marker", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: makeStream(['data: {"msg":"hello"}\n']),
    });

    const doneFn = vi.fn();
    const client = new SSEClient();
    await client.connect("/events", vi.fn(), doneFn);

    expect(doneFn).toHaveBeenCalled();
  });

  it("triggers heartbeat timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolveRead: any;
    const reader = {
      read: () =>
        new Promise<any>((r) => {
          resolveRead = r;
        }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => reader },
    });

    const errFn = vi.fn();
    const client = new SSEClient({ heartbeatTimeoutMs: 5000, requestTimeoutMs: 60000 });
    const connectPromise = client.connect("/events", vi.fn(), vi.fn(), errFn);

    // Allow fetch to resolve and startHeartbeat to schedule first check
    await vi.advanceTimersByTimeAsync(0);
    // Advance past first heartbeat check interval (10000ms)
    await vi.advanceTimersByTimeAsync(11000);

    expect(errFn).toHaveBeenCalledWith(expect.objectContaining({ message: "Connection stalled — no data for 60s" }));

    vi.useRealTimers();
    resolveRead?.({ done: true });
    await connectPromise.catch(() => {});
  });
});
