import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { SSEClient } from "./sse-client";

const BASE_URL = "";
const MAX_RETRIES = 1;

/** Error classification for downstream handling */
export type ErrorCategory = "network" | "timeout" | "client" | "server" | "auth" | "unknown";

function classifyError(status: number, axiosMessage: string): ErrorCategory {
  if (status === 401) return "auth";
  if (status >= 400 && status < 500) return "client";
  if (status >= 500) return "server";
  if (axiosMessage.includes("timeout") || axiosMessage.includes("ETIMEDOUT")) return "timeout";
  if (
    axiosMessage.includes("Network Error") ||
    axiosMessage.includes("ECONNRESET") ||
    axiosMessage.includes("ECONNREFUSED") ||
    axiosMessage.includes("ENOTFOUND")
  ) {
    return "network";
  }
  return "unknown";
}

function isRetryable(status: number, category: ErrorCategory): boolean {
  return category === "network" || category === "timeout" || status >= 500;
}

export class ApiClient {
  private instance: AxiosInstance;
  private pendingRequests = new Map<string, AbortController>();

  constructor() {
    this.instance = axios.create({ baseURL: BASE_URL, timeout: 60000 });

    this.instance.interceptors.request.use((config) => {
      const token = localStorage.getItem("webrain-api-key");
      if (token) config.headers.Authorization = `Bearer ${token}`;

      // Deduplication for mutating requests
      const method = config.method?.toLowerCase();
      if (method && method !== "get" && method !== "head") {
        const key = `${method}_${config.url}_${JSON.stringify(config.params ?? {})}_${JSON.stringify(config.data ?? {})}`;
        if (this.pendingRequests.has(key)) {
          this.pendingRequests.get(key)!.abort();
        }
        const controller = new AbortController();
        config.signal = controller.signal;
        this.pendingRequests.set(key, controller);
      }

      // Retry counter
      config.headers["x-retry-count"] = config.headers["x-retry-count"] ?? 0;

      return config;
    });

    this.instance.interceptors.response.use(
      (res) => {
        this.clearRequest(res.config);
        return res;
      },
      async (err) => {
        if (err.config) this.clearRequest(err.config);

        const status = err.response?.status || 0;
        const rawMessage = err.response?.data?.error || err.message || "Request failed";
        const category = classifyError(status, err.message || "");

        // Auth: clear token. Only redirect if the user actually HAD a token
        // — otherwise the 401 came from an endpoint that nominally requires
        // server-side auth (MCP token, etc.) which the user never plumbed
        // through. Hard-redirecting would bounce them off any admin page
        // that polls such endpoints. v2.19 bug: /brain/proactive/insights
        // polls every 30s; bare visit to /dashboard → 401 → redirect to / →
        // admin mode entirely unusable.
        if (status === 401) {
          const hadToken = !!localStorage.getItem("webrain-api-key");
          localStorage.removeItem("webrain-api-key");
          if (hadToken) window.location.href = "/";
          throw new ApiError(status, rawMessage, category);
        }

        // Automatic retry for transient failures
        const retryCount = Number(err.config?.headers?.["x-retry-count"] ?? 0);
        if (retryCount < MAX_RETRIES && isRetryable(status, category)) {
          err.config.headers["x-retry-count"] = retryCount + 1;
          return this.instance.request(err.config);
        }

        throw new ApiError(status, rawMessage, category);
      }
    );
  }

  private clearRequest(config: AxiosRequestConfig) {
    const method = config.method?.toLowerCase();
    if (method && method !== "get" && method !== "head") {
      const key = `${method}_${config.url}_${JSON.stringify(config.params ?? {})}_${JSON.stringify(config.data ?? {})}`;
      this.pendingRequests.delete(key);
    }
  }

  get<T>(url: string, config?: AxiosRequestConfig) {
    return this.instance.get<T>(url, config).then((r) => r.data);
  }

  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return this.instance.post<T>(url, data, config).then((r) => r.data);
  }

  put<T>(url: string, data?: unknown, config?: AxiosRequestConfig) {
    return this.instance.put<T>(url, data, config).then((r) => r.data);
  }

  delete<T>(url: string, config?: AxiosRequestConfig) {
    return this.instance.delete<T>(url, config).then((r) => r.data);
  }

  /** SSE streaming with auto-reconnect, heartbeat, and auth */
  stream(url: string, data?: Record<string, unknown>) {
    const qs = data ? "?" + new URLSearchParams(data as Record<string, string>).toString() : "";
    const client = new SSEClient({ maxRetries: 3, heartbeatTimeoutMs: 60000, requestTimeoutMs: 30000 });
    return {
      client,
      url: url + qs,
    };
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public category: ErrorCategory = "unknown"
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True for network, timeout, or 5xx errors */
  get isRetryable(): boolean {
    return isRetryable(this.status, this.category);
  }

  /** True for 4xx client errors (excluding auth) */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 401;
  }
}

export const api = new ApiClient();
