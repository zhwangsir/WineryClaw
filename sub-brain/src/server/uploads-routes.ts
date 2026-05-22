/**
 * File upload + download routes.
 *
 *   POST /upload            — body { filename, data (base64), type? } → stores under uploadsDir
 *   GET  /uploads/:name     — serves a previously-uploaded file (with path-traversal guard)
 *
 * Caller supplies `uploadsDir` so tests can point at a tmp dir and prod points
 * at ~/.webrain/uploads. The dir is created on registration if missing.
 *
 * v2.38: server is the AUTHORITATIVE gate — it does not trust the frontend
 * to pre-check. We reject:
 *   - filenames whose extension isn't in ALLOWED_EXTENSIONS (the RAG
 *     indexer reads UTF-8 text only, so binary formats produce garbage)
 *   - payloads larger than MAX_UPLOAD_BYTES (matches the RAG drag-drop
 *     guidance + protects the proxy body parser)
 * Errors come back as { ok: false, error } so the frontend can surface
 * a friendly message; HTTP 200 is preserved (matches the existing
 * "Missing filename or data" failure shape).
 */

import type { FastifyInstance } from "fastify";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { extname, join, resolve as pathResolve, sep as pathSep } from "path";

export interface UploadsRouteDeps {
  uploadsDir: string;
}

interface UploadBody {
  filename?: string;
  data?: string;     // base64-encoded
  type?: string;     // content type, optional
}

const SANITIZE_RE = /[^a-zA-Z0-9._-]/g;

/**
 * v2.38: allowlist of extensions accepted by /upload.
 *
 * The RAG indexer (`memory/rag_retriever.py` index_file) reads files via
 * `Path.read_text(encoding="utf-8", errors="replace")` — so binary formats
 * (.pdf .docx .xlsx .png .jpg) produce a soup of replacement characters
 * and degrade retrieval quality. We only accept text-based formats here.
 * If you need true PDF/DOCX support, add a real parser (pdfplumber /
 * python-docx) to the indexer first, then expand this list.
 *
 * Comparison is case-insensitive (dotted form, e.g. ".md").
 */
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".log",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".sh",
  ".sql",
]);

/**
 * v2.38: hard ceiling on upload size after base64 decode. 50 MB is
 * generous for text documents (a 50 MB .md is ~50k pages of prose);
 * anything larger almost certainly belongs in /brain/rag/index_dir
 * via direct path rather than the drag-drop UI. The Vite proxy
 * default body limit is 100 MB so we stay well below that.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * v2.38: required Fastify `bodyLimit` to actually allow MAX_UPLOAD_BYTES
 * payloads through the JSON parser. base64 inflates binary by ~33%, plus
 * JSON envelope overhead (filename + type fields + quoting). 80 MB
 * comfortably handles a 50 MB decoded binary (~67 MB base64) + headroom.
 *
 * Bug found 2026-05-22 in v2.34: main.ts created `Fastify({ logger })`
 * with the default 1 MB limit, so the dropzone could never actually
 * carry a file >750 KB. The 10 MB UX hint + the would-be 50 MB cap were
 * BOTH unreachable in production.
 *
 * Call sites: `main.ts` passes this to `Fastify({ bodyLimit })`.
 */
export const REQUIRED_FASTIFY_BODY_LIMIT = 80 * 1024 * 1024;

export function registerUploadsRoutes(app: FastifyInstance, deps: UploadsRouteDeps): void {
  if (!existsSync(deps.uploadsDir)) {
    mkdirSync(deps.uploadsDir, { recursive: true });
  }

  app.post("/upload", async (request) => {
    const body = (request.body as UploadBody) ?? {};
    if (!body.filename || !body.data) {
      return { ok: false, error: "Missing filename or data" };
    }

    // v2.38 — extension allowlist (case-insensitive). Reject BEFORE
    // decoding base64 so we don't burn memory on a payload we'll throw
    // away. extname() includes the dot, e.g. ".md".
    const ext = extname(body.filename).toLowerCase();
    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        error: `Unsupported file extension: "${ext || "(none)"}". Allowed: ${[...ALLOWED_EXTENSIONS].sort().join(", ")}`,
      };
    }

    const safeName = body.filename.replace(SANITIZE_RE, "_");
    const uniqueName = `${Date.now()}_${safeName}`;
    const filePath = join(deps.uploadsDir, uniqueName);
    const buffer = Buffer.from(body.data, "base64");

    // v2.38 — hard size cap. We check AFTER decode (vs. base64 string
    // length) because base64 inflates the byte count by ~33% — the
    // decoded length is the real disk-bound number.
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        error: `File too large: ${buffer.length} bytes exceeds ${MAX_UPLOAD_BYTES} bytes (${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`,
      };
    }

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
