import type { FastifyInstance } from "fastify";

export function registerBrainProxy(
  app: FastifyInstance,
  mainBrainUrl: string,
  useUds: boolean,
  mainBrainUds: string
): void {
  app.all("/brain/*", async (request, reply) => {
    const axios = (await import("axios")).default;
    const path = (request.raw.url || "").replace(/^\/brain/, "");
    const url = `${mainBrainUrl}${path}`;
    const traceId = (request as any).traceId || "";
    const isStream = request.headers.accept?.includes("text/event-stream");

    // Forward headers that downstream services actually rely on. We
    // can't blindly forward every header (host, content-length, etc.
    // would conflict with axios's own auto-management), so we pick a
    // small allowlist:
    //   - authorization: required for MCP write-scope tools and any
    //     future auth-gated route. Round C4 smoke caught this — main-
    //     brain rejected every authenticated MCP call because the
    //     proxy stripped the bearer token.
    //   - any incoming x-* header: distributed tracing / custom context
    //     that downstream might rely on.
    //
    // Round E2 harden: deny-list the x-forwarded-* / x-real-ip family.
    // Sub-brain is the public entry point; if main-brain ever enables
    // uvicorn's ProxyHeadersMiddleware or trusts these for IP
    // allowlisting, an authenticated client could spoof
    // `X-Forwarded-For: 127.0.0.1` and appear to come from localhost.
    // Strip now to make that footgun unloadable.
    const SPOOFABLE_PROXY_HEADERS = new Set([
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-port",
      "x-forwarded-ssl",
      "x-real-ip",
      "x-original-host",
      "x-original-uri",
    ]);

    const forwardedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-trace-id": traceId,
    };
    const rawAuth = request.headers.authorization;
    if (typeof rawAuth === "string" && rawAuth.length > 0) {
      forwardedHeaders["Authorization"] = rawAuth;
    }
    for (const [key, value] of Object.entries(request.headers)) {
      if (!key.startsWith("x-")) continue;
      if (key === "x-trace-id") continue; // already set above with our value
      if (SPOOFABLE_PROXY_HEADERS.has(key)) continue; // see Round E2 note
      if (typeof value === "string") {
        forwardedHeaders[key] = value;
      }
    }

    const axiosConfig: any = {
      method: request.method as any,
      url,
      data: request.body,
      headers: forwardedHeaders,
      timeout: 120000,
      responseType: isStream ? "stream" : "json",
    };
    if (useUds) {
      axiosConfig.socketPath = mainBrainUds;
    }

    try {
      const response = await axios(axiosConfig);
      const contentType = response.headers?.["content-type"];
      if (contentType) reply.header("Content-Type", contentType);

      if (isStream && response.data?.pipe) {
        // SSE stream: pipe axios response stream directly to client.
        //
        // Round Q (2026-05-21) — the previous version forgot to call
        // `reply.hijack()`. Without that, Fastify treats the response
        // as still "owned" by the route, and when the handler returns
        // it auto-completes by calling `reply.raw.end()`. That races
        // with axios's pipe — Fastify's `end()` often won out, closing
        // the response before any body bytes were flushed. The visible
        // symptom: every chat-stream request from the frontend
        // (which sets `Accept: text/event-stream`) closed in ~15 ms
        // with status 200 but zero body bytes. Discovered by walking
        // the live app via Chrome MCP and bisecting layers.
        reply.hijack();
        const rawCT = response.headers?.["content-type"];
        const headerCT = typeof rawCT === "string" ? rawCT : "text/event-stream";
        reply.raw.setHeader("Content-Type", headerCT);
        reply.raw.setHeader("Cache-Control", "no-cache");
        reply.raw.setHeader("Connection", "keep-alive");
        // X-Accel-Buffering: no — prevents nginx-style intermediaries
        // (and some browser caches) from buffering the stream.
        reply.raw.setHeader("X-Accel-Buffering", "no");
        reply.raw.writeHead(response.status);
        response.data.pipe(reply.raw);
        return;
      }

      reply.code(response.status).send(response.data);
    } catch (err: any) {
      const status = err.response?.status || 500;
      const data = err.response?.data || { error: err.message };
      reply.code(status).send(data);
    }
  });
}
