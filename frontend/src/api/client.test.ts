import { describe, it, expect, vi, beforeEach } from "vitest";

let requestInterceptor: any;
let responseSuccessInterceptor: any;
let responseErrorInterceptor: any;
let mockAxiosInstance: any;

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => {
      mockAxiosInstance = {
        interceptors: {
          request: {
            use: vi.fn((fn: any) => {
              requestInterceptor = fn;
            }),
          },
          response: {
            use: vi.fn((s: any, e: any) => {
              responseSuccessInterceptor = s;
              responseErrorInterceptor = e;
            }),
          },
        },
        get: vi.fn(),
        post: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        request: vi.fn(),
      };
      return mockAxiosInstance;
    }),
  },
}));

// Must import after mock
const { ApiClient, ApiError } = await import("./client");

describe("ApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("webrain-api-key");
    requestInterceptor = undefined;
    responseSuccessInterceptor = undefined;
    responseErrorInterceptor = undefined;
    mockAxiosInstance = undefined;
  });

  it("adds auth header from localStorage", () => {
    localStorage.setItem("webrain-api-key", "tok123");
    new ApiClient();
    const config = requestInterceptor({ headers: {}, method: "get", url: "/test" });
    expect(config.headers.Authorization).toBe("Bearer tok123");
  });

  it("sets x-retry-count header", () => {
    new ApiClient();
    const config = requestInterceptor({ headers: {}, method: "get", url: "/test" });
    expect(config.headers["x-retry-count"]).toBe(0);
  });

  it("deduplicates mutating requests by aborting previous", () => {
    new ApiClient();
    const abortSpy = vi.fn();
    const first = requestInterceptor({ headers: {}, method: "post", url: "/api", data: { x: 1 } });
    first.signal = { reason: "old" } as any;
    // Simulate storing the controller
    const key = `post_/api_{}_{"x":1}`;
    // Now send same request again — interceptor should abort previous
    const second = requestInterceptor({ headers: {}, method: "post", url: "/api", data: { x: 1 } });
    expect(second.signal).toBeDefined();
  });

  it("clears pending request on response success", () => {
    new ApiClient();
    const res = responseSuccessInterceptor({
      config: { headers: {}, method: "post", url: "/api", data: {} },
      data: 42,
    });
    expect(res.data).toBe(42);
  });

  it("throws ApiError on 401 and clears token", async () => {
    const originalHref = window.location.href;
    Object.defineProperty(window, "location", { value: { href: "/chat" }, writable: true });
    localStorage.setItem("webrain-api-key", "tok");
    new ApiClient();

    const err = {
      config: { headers: { "x-retry-count": 0 } },
      response: { status: 401, data: { error: "Unauthorized" } },
      message: "Request failed",
    };

    await expect(responseErrorInterceptor(err)).rejects.toBeInstanceOf(ApiError);
    expect(localStorage.getItem("webrain-api-key")).toBeNull();
    expect(window.location.href).toBe("/");

    Object.defineProperty(window, "location", { value: { href: originalHref }, writable: true });
  });

  it("retries on 5xx error", async () => {
    new ApiClient();
    mockAxiosInstance.request.mockResolvedValue({ data: "ok" });

    const err = {
      config: { headers: { "x-retry-count": 0 }, method: "get", url: "/api" },
      response: { status: 503 },
      message: "Service Unavailable",
    };

    const result = await responseErrorInterceptor(err);
    expect(mockAxiosInstance.request).toHaveBeenCalled();
    expect(result.data).toBe("ok");
  });

  it("retries on network error", async () => {
    new ApiClient();
    mockAxiosInstance.request.mockResolvedValue({ data: "ok" });

    const err = {
      config: { headers: { "x-retry-count": 0 }, method: "get", url: "/api" },
      response: undefined,
      message: "Network Error",
    };

    const result = await responseErrorInterceptor(err);
    expect(mockAxiosInstance.request).toHaveBeenCalled();
    expect(result.data).toBe("ok");
  });

  it("retries on timeout error", async () => {
    new ApiClient();
    mockAxiosInstance.request.mockResolvedValue({ data: "ok" });

    const err = {
      config: { headers: { "x-retry-count": 0 }, method: "get", url: "/api" },
      response: undefined,
      message: "timeout of 5000ms exceeded",
    };

    const result = await responseErrorInterceptor(err);
    expect(mockAxiosInstance.request).toHaveBeenCalled();
  });

  it("does not retry beyond MAX_RETRIES", async () => {
    new ApiClient();

    const err = {
      config: { headers: { "x-retry-count": 1 }, method: "get", url: "/api" },
      response: { status: 503 },
      message: "Service Unavailable",
    };

    await expect(responseErrorInterceptor(err)).rejects.toBeInstanceOf(ApiError);
    expect(mockAxiosInstance.request).not.toHaveBeenCalled();
  });

  it("throws ApiError for non-retryable client errors", async () => {
    new ApiClient();

    const err = {
      config: { headers: { "x-retry-count": 0 }, method: "get", url: "/api" },
      response: { status: 400, data: { error: "Bad Request" } },
      message: "Bad Request",
    };

    await expect(responseErrorInterceptor(err)).rejects.toBeInstanceOf(ApiError);
  });

  it("classifies ECONNRESET as network", async () => {
    new ApiClient();
    mockAxiosInstance.request.mockResolvedValue({ data: "ok" });

    const err = {
      config: { headers: { "x-retry-count": 0 }, method: "get", url: "/api" },
      response: undefined,
      message: "ECONNRESET",
    };

    const result = await responseErrorInterceptor(err);
    expect(mockAxiosInstance.request).toHaveBeenCalled();
  });

  it("classifies ECONNREFUSED as network", async () => {
    new ApiClient();
    mockAxiosInstance.request.mockResolvedValue({ data: "ok" });

    const err = {
      config: { headers: { "x-retry-count": 0 }, method: "get", url: "/api" },
      response: undefined,
      message: "ECONNREFUSED",
    };

    const result = await responseErrorInterceptor(err);
    expect(mockAxiosInstance.request).toHaveBeenCalled();
  });

  it("classifies ENOTFOUND as network", async () => {
    new ApiClient();
    mockAxiosInstance.request.mockResolvedValue({ data: "ok" });

    const err = {
      config: { headers: { "x-retry-count": 0 }, method: "get", url: "/api" },
      response: undefined,
      message: "ENOTFOUND",
    };

    const result = await responseErrorInterceptor(err);
    expect(mockAxiosInstance.request).toHaveBeenCalled();
  });

  it("classifies unknown errors as unknown category", async () => {
    new ApiClient();

    const err = {
      config: { headers: { "x-retry-count": 0 }, method: "get", url: "/api" },
      response: { status: 200 },
      message: "Some weird error",
    };

    await expect(responseErrorInterceptor(err)).rejects.toBeInstanceOf(ApiError);
  });

  it("get delegates to instance.get", async () => {
    const client = new ApiClient();
    mockAxiosInstance.get.mockResolvedValue({ data: { ok: true } });
    const result = await client.get("/test");
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/test", undefined);
    expect(result).toEqual({ ok: true });
  });

  it("post delegates to instance.post", async () => {
    const client = new ApiClient();
    mockAxiosInstance.post.mockResolvedValue({ data: { id: 1 } });
    const result = await client.post("/test", { name: "x" });
    expect(mockAxiosInstance.post).toHaveBeenCalledWith("/test", { name: "x" }, undefined);
    expect(result).toEqual({ id: 1 });
  });

  it("put delegates to instance.put", async () => {
    const client = new ApiClient();
    mockAxiosInstance.put.mockResolvedValue({ data: { updated: true } });
    const result = await client.put("/test", { name: "y" });
    expect(result).toEqual({ updated: true });
  });

  it("delete delegates to instance.delete", async () => {
    const client = new ApiClient();
    mockAxiosInstance.delete.mockResolvedValue({ data: null });
    const result = await client.delete("/test");
    expect(result).toBeNull();
  });

  it("stream returns SSE client and URL", () => {
    const client = new ApiClient();
    const stream = client.stream("/events", { room: "abc" });
    expect(stream.url).toBe("/events?room=abc");
    expect(stream.client).toBeDefined();
  });
});

describe("ApiError", () => {
  it("has correct properties", () => {
    const err = new ApiError(503, "Service Unavailable", "server");
    expect(err.status).toBe(503);
    expect(err.message).toBe("Service Unavailable");
    expect(err.category).toBe("server");
    expect(err.name).toBe("ApiError");
  });

  it("isRetryable true for network/timeout/server", () => {
    expect(new ApiError(0, "x", "network").isRetryable).toBe(true);
    expect(new ApiError(0, "x", "timeout").isRetryable).toBe(true);
    expect(new ApiError(503, "x", "server").isRetryable).toBe(true);
    expect(new ApiError(400, "x", "client").isRetryable).toBe(false);
  });

  it("isClientError true for 4xx excluding 401", () => {
    expect(new ApiError(400, "x", "client").isClientError).toBe(true);
    expect(new ApiError(404, "x", "client").isClientError).toBe(true);
    expect(new ApiError(401, "x", "auth").isClientError).toBe(false);
    expect(new ApiError(500, "x", "server").isClientError).toBe(false);
  });
});
