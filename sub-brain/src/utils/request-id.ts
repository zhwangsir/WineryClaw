/**
 * Request ID generator for distributed tracing
 * Attaches a unique ID to every incoming request for log correlation
 */

import { randomUUID } from "crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

export function registerRequestId(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    request.requestId =
      (request.headers["x-request-id"] as string) || randomUUID();
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.requestId);
  });
}
