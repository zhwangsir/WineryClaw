import type { FastifyInstance } from "fastify";
import staticPlugin from "@fastify/static";
import { join, resolve as pathResolve } from "path";
import { existsSync } from "fs";
import axios from "axios";

export function registerStatic(app: FastifyInstance, dirname: string): string | undefined {
  let frontendDist: string | undefined;
  const frontendPaths = [
    pathResolve(dirname, "../../frontend/dist"),
    pathResolve(dirname, "../frontend/dist"),
    pathResolve(dirname, "./frontend/dist"),
  ];
  frontendDist = frontendPaths.find((p) => existsSync(join(p, "index.html")));

  if (frontendDist) {
    app.register(staticPlugin, {
      root: frontendDist,
      prefix: "/",
      wildcard: false,
    });
    // Serve assets explicitly since wildcard:false doesn't cover subdirs
    app.get("/assets/*", async (request, reply) => {
      const filePath = (request.params as Record<string, string>)["*"];
      await reply.sendFile(join("assets", filePath));
    });
    // Support /api/* prefix for frontend consistency — proxy to internal routes with body forwarding
    app.all("/api/*", async (request, reply) => {
      const path = (request.raw.url || "").replace(/^\/api/, "");
      const port = (app.server.address() as any)?.port || 3000;
      const url = `http://127.0.0.1:${port}${path}`;

      try {
        const forwardHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          const lk = key.toLowerCase();
          if (lk === "content-length" || lk === "content-encoding" || lk === "host" || lk === "connection" || lk === "transfer-encoding") continue;
          if (typeof value === "string") forwardHeaders[key] = value;
          else if (Array.isArray(value)) forwardHeaders[key] = value.join(", ");
        }
        const response = await axios({
          method: request.method as any,
          url,
          data: request.body,
          headers: forwardHeaders,
          validateStatus: () => true,
          responseType: "arraybuffer",
        });

        reply.code(response.status);
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined && key.toLowerCase() !== "transfer-encoding") {
            void reply.header(key, value);
          }
        }
        reply.send(response.data);
      } catch (err: any) {
        app.log.error({ err: err.message, path, url }, "API proxy error");
        reply.code(502).send({ error: "Proxy error", message: err.message });
      }
    });

    // Prevent browser from caching index.html across builds
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.url === "/" || request.url === "/index.html") {
        reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
        reply.header("Pragma", "no-cache");
        reply.header("Expires", "0");
      }
      return payload;
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/brain/") || request.url.startsWith("/assets/")) {
        reply.code(404).send({ error: "Not found" });
      } else {
        await reply.sendFile("index.html");
      }
    });
    app.log.info(`[static] Serving frontend from ${frontendDist}`);
  } else {
    app.log.warn("[static] Frontend dist not found. UI will not be available.");
  }
  return frontendDist;
}
