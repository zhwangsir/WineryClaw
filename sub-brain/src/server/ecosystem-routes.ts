/**
 * Ecosystem resource-sharing routes.
 *
 *   POST /ecosystem/register   — register a new resource
 *   POST /ecosystem/share      — share with another principal
 *   POST /ecosystem/revoke     — revoke a share
 *   POST /ecosystem/delete     — delete a resource
 *   GET  /ecosystem/resources  — list all resources
 */

import type { FastifyInstance } from "fastify";
import type { EcosystemHub } from "../ecosystem/ecosystem-hub.js";

export interface EcosystemRouteDeps {
  ecosystemHub: EcosystemHub;
}

interface RegisterBody {
  name?: string;
  type?: string;
  data?: unknown;
  owner?: string;
}

interface ShareBody {
  resource_id?: string;
  target?: string;
}

interface DeleteBody {
  resource_id?: string;
}

export function registerEcosystemRoutes(
  app: FastifyInstance,
  deps: EcosystemRouteDeps,
): void {
  app.post("/ecosystem/register", async (request) => {
    const body = (request.body as RegisterBody) ?? {};
    return deps.ecosystemHub.register(
      String(body.name ?? ""),
      String(body.type ?? ""),
      body.data,
      body.owner,
    );
  });

  app.post("/ecosystem/share", async (request) => {
    const body = (request.body as ShareBody) ?? {};
    return deps.ecosystemHub.share(
      String(body.resource_id ?? ""),
      String(body.target ?? ""),
    );
  });

  app.post("/ecosystem/revoke", async (request) => {
    const body = (request.body as ShareBody) ?? {};
    return deps.ecosystemHub.revoke(
      String(body.resource_id ?? ""),
      String(body.target ?? ""),
    );
  });

  app.post("/ecosystem/delete", async (request) => {
    const body = (request.body as DeleteBody) ?? {};
    return deps.ecosystemHub.deleteResource(String(body.resource_id ?? ""));
  });

  app.get("/ecosystem/resources", async () => ({
    resources: deps.ecosystemHub.listResources(),
  }));
}
