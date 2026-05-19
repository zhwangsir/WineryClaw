/**
 * Identity & workspace-access routes.
 *
 *   GET    /identity/users                          — list users
 *   GET    /identity/user/:id                       — fetch one user
 *   POST   /identity/user                           — create user
 *   GET    /identity/user/:id/workspaces/:ws        — check workspace access
 *   DELETE /identity/user/:id                       — delete user
 */

import type { FastifyInstance } from "fastify";
import type { IdentityManager } from "../identity/identity-manager.js";

export interface IdentityRouteDeps {
  identityManager: IdentityManager;
}

interface CreateUserBody {
  name?: string;
  role?: string;
  workspaces?: string[];
}

export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRouteDeps): void {
  app.get("/identity/users", async () => ({
    users: deps.identityManager.listUsers(),
  }));

  app.get("/identity/user/:id", async (request) => {
    const { id } = request.params as { id: string };
    const user = deps.identityManager.getUser(id);
    return { ok: !!user, user };
  });

  app.post("/identity/user", async (request) => {
    const body = (request.body as CreateUserBody) ?? {};
    // Pass undefined (not "" / []) when fields are missing so IdentityManager's
    // default values ("user" role, ["default"] workspace) apply.
    const user = deps.identityManager.createUser(
      String(body.name ?? ""),
      body.role as "admin" | "user" | "guest" | undefined,
      Array.isArray(body.workspaces) ? body.workspaces : undefined,
    );
    return { ok: true, user };
  });

  app.get("/identity/user/:id/workspaces/:ws", async (request) => {
    const { id, ws } = request.params as { id: string; ws: string };
    return { ok: true, access: deps.identityManager.hasWorkspaceAccess(id, ws) };
  });

  app.delete("/identity/user/:id", async (request) => {
    const { id } = request.params as { id: string };
    const ok = deps.identityManager.deleteUser(id);
    return { ok };
  });
}
