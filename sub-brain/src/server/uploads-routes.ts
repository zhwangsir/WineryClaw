/**
 * File upload + download routes.
 *
 *   POST /upload            — body { filename, data (base64), type? } → stores under uploadsDir
 *   GET  /uploads/:name     — serves a previously-uploaded file (with path-traversal guard)
 *
 * Caller supplies `uploadsDir` so tests can point at a tmp dir and prod points
 * at ~/.webrain/uploads. The dir is created on registration if missing.
 */

import type { FastifyInstance } from "fastify";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve as pathResolve, sep as pathSep } from "path";

export interface UploadsRouteDeps {
  uploadsDir: string;
}

interface UploadBody {
  filename?: string;
  data?: string;     // base64-encoded
  type?: string;     // content type, optional
}

const SANITIZE_RE = /[^a-zA-Z0-9._-]/g;

export function registerUploadsRoutes(app: FastifyInstance, deps: UploadsRouteDeps): void {
  if (!existsSync(deps.uploadsDir)) {
    mkdirSync(deps.uploadsDir, { recursive: true });
  }

  app.post("/upload", async (request) => {
    const body = (request.body as UploadBody) ?? {};
    if (!body.filename || !body.data) {
      return { ok: false, error: "Missing filename or data" };
    }
    const safeName = body.filename.replace(SANITIZE_RE, "_");
    const uniqueName = `${Date.now()}_${safeName}`;
    const filePath = join(deps.uploadsDir, uniqueName);
    const buffer = Buffer.from(body.data, "base64");
    writeFileSync(filePath, buffer);
    return {
      ok: true,
      url: `/uploads/${uniqueName}`,
      name: uniqueName,
      // v2.34: absolute path so the caller (e.g. RAG drag-drop UI) can
      // pass it directly to /brain/rag/index_file without guessing where
      // the uploads dir is. pathResolve normalizes any "." / ".." in the
      // configured uploadsDir.
      absolute_path: pathResolve(filePath),
      size: buffer.length,
      type: body.type || "application/octet-stream",
    };
  });

  app.get("/uploads/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const filePath = join(deps.uploadsDir, name);
    const resolved = pathResolve(filePath);
    const baseResolved = pathResolve(deps.uploadsDir);
    // Reject any path that escapes uploadsDir (path-traversal guard).
    if (!resolved.startsWith(baseResolved + pathSep) && resolved !== baseResolved) {
      return reply.code(403).send({ error: "Access denied" });
    }
    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: "File not found" });
    }
    return reply.sendFile(name, deps.uploadsDir);
  });
}
