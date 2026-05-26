/**
 * SSE Client with auto-reconnect, heartbeat detection, and abort support
 * Ensures streaming responses are never silently lost
 */

export interface SSEOptions {
  maxRetries?: number;
  baseRetryDelayMs?: number;
  heartbeatTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class SSEClient {
  private retryCount = 0;
  private maxRetries: number;
  private baseDelay: number;
  private heartbeatTimeout: number;
  private requestTimeout: number;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private requestTimer?: ReturnType<typeof setTimeout>;
  private abortController?: AbortController;
  private lastMessageTime = 0;
  private connected = false;

  constructor(options: SSEOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelay = options.baseRetryDelayMs ?? 1000;
    this.heartbeatTimeout = options.heartbeatTimeoutMs ?? 60000;
    this.requestTimeout = options.requestTimeoutMs ?? 30000;
  }

  async connect(
    url: string,
    onMessage: (data: unknown) => void,
    onDone?: () => void,
    onError?: (err: Error) => void
  ): Promise<void> {
    this.abortController = new AbortController();
    this.lastMessageTime = Date.now();

    // Request-level timeout
    this.requestTimer = setTimeout(() => {
      this.abortController?.abort(new Error("Request timeout"));
    }, this.requestTimeout);

    try {
      const token = localStorage.getItem("webrain-api-key");
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: this.abortController.signal,
      });

      clearTimeout(this.requestTimer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("Response body is null");
      }

      this.connected = true;
      this.retryCount = 0;

      // Start heartbeat monitor
      this.startHeartbeat(onError);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.lastMessageTime = Date.now();
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") {
            onDone?.();
            return;
          }
          try {
            onMessage(JSON.parse(data));
          } catch {
            onMessage(data);
          }
        }
      }

      onDone?.();
    } catch (err: any) {
      clearTimeout(this.requestTimer);
      clearTimeout(this.heartbeatTimer);

      if (err.name === "AbortError") {
        // [Q-debug] surface where the abort came from — Q1.5 investigation.
        // eslint-disable-next-line no-console
        console.warn("[SSE] aborted", { url, reason: this.abortController?.signal?.reason });
        onError?.(new Error("Connection aborted"));
        return;
      }

      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        const delay = this.baseDelay * Math.pow(2, this.retryCount - 1);
        await new Promise((r) => setTimeout(r, delay));
        return this.connect(url, onMessage, onDone, onError);
      }

      onError?.(err);
    } finally {
      this.connected = false;
      clearTimeout(this.heartbeatTimer);
    }
  }

  abort(): void {
    this.abortController?.abort();
    clearTimeout(this.requestTimer);
    clearTimeout(this.heartbeatTimer);
  }

  private startHeartbeat(onError?: (err: Error) => void): void {
    const check = () => {
      if (!this.connected) return;
      if (Date.now() - this.lastMessageTime > this.heartbeatTimeout) {
        this.abortController?.abort(new Error("Heartbeat timeout"));
        onError?.(new Error("Connection stalled — no data for 60s"));
        return;
      }
      this.heartbeatTimer = setTimeout(check, 10000);
    };
    this.heartbeatTimer = setTimeout(check, 10000);
  }
}
