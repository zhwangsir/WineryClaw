/**
 * CLI bridge routes.
 *
 *   GET  /cli/status   — text status from WeBrainCLI
 *   POST /cli/chat     — proxy a chat message into the CLI
 *   POST /cli/exec     — execute a tool through the CLI surface
 */

import type { FastifyInstance } from "fastify";
import type { WeBrainCLI } from "../cli/webrain-cli.js";

export interface CLIRouteDeps {
  cli: WeBrainCLI;
}

interface ChatBody {
  message?: string;
  session_id?: string;
}

interface ExecBody {
  tool?: string;
  params?: Record<string, unknown>;
}

export function registerCLIRoutes(app: FastifyInstance, deps: CLIRouteDeps): void {
  app.get("/cli/status", async () => {
    const text = await deps.cli.status();
    return { text };
  });

  app.post("/cli/chat", async (request) => {
    const body = (request.body as ChatBody) ?? {};
    const reply = await deps.cli.chat(
      String(body.message ?? ""),
      body.session_id ? String(body.session_id) : undefined,
    );
    return { reply };
  });

  app.post("/cli/exec", async (request) => {
    const body = (request.body as ExecBody) ?? {};
    const result = await deps.cli.exec(String(body.tool ?? ""), body.params ?? {});
    return { result };
  });
}
