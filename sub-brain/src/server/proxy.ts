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
        // SSE stream: pipe axios response stream directly to client
        reply.code(response.status);
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
