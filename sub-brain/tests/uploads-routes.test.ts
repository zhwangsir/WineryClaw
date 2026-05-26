import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join, resolve, sep } from "path";
import { tmpdir } from "os";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

import {
  registerUploadsRoutes,
  REQUIRED_FASTIFY_BODY_LIMIT,
} from "../src/server/uploads-routes.js";

describe("uploads routes", () => {
  let app: FastifyInstance;
  let uploadsDir: string;

  beforeEach(async () => {
    uploadsDir = mkdtempSync(join(tmpdir(), "webrain-uploads-test-"));
    // v2.38: match the prod bodyLimit so the route's MAX_UPLOAD_BYTES check
    // is actually exercised — Fastify's default 1 MB cap would otherwise
    // reject any large-payload test at the parser before reaching our route.
    app = Fastify({ bodyLimit: REQUIRED_FASTIFY_BODY_LIMIT });
    // GET /uploads/:name calls reply.sendFile, which needs fastify-static registered.
    await app.register(fastifyStatic, { root: uploadsDir, prefix: "/__static__/" });
    registerUploadsRoutes(app, { uploadsDir });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (existsSync(uploadsDir)) rmSync(uploadsDir, { recursive: true, force: true });
  });

  it("POST /upload writes base64 payload and returns metadata", async () => {
    const payload = Buffer.from("hello world").toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: { filename: "hello.txt", data: payload, type: "text/plain" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toMatch(/^\d+_hello\.txt$/);
    expect(body.size).toBe(11);
    expect(body.type).toBe("text/plain");
    expect(body.url).toBe(`/uploads/${body.name}`);

    // File actually exists with the right content
    const writtenPath = join(uploadsDir, body.name);
    expect(existsSync(writtenPath)).toBe(true);
    expect(readFileSync(writtenPath, "utf-8")).toBe("hello world");
  });

  it("v2.34: POST /upload returns absolute_path inside uploadsDir", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: { filename: "doc.md", data: Buffer.from("x").toString("base64") },
    });
    const body = res.json();
    expect(typeof body.absolute_path).toBe("string");
    // Resolved path must be absolute AND nested under uploadsDir (path
    // separator at the boundary, not just startsWith).
    const root = resolve(uploadsDir);
    expect(body.absolute_path.startsWith(root + sep)).toBe(true);
    // File should actually exist at that absolute path.
    expect(existsSync(body.absolute_path)).toBe(true);
  });

  it("POST /upload defaults type to application/octet-stream", async () => {
    // v2.38: filename must use an allowlisted extension (was .bin originally,
    // which is now rejected — the test is about type defaulting, not allowlist).
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: { filename: "x.txt", data: Buffer.from("x").toString("base64") },
    });
    expect(res.json().type).toBe("application/octet-stream");
  });

  it("POST /upload sanitizes the filename (path separators and unsafe chars)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: {
        filename: "../etc/pa ss w@rd.txt",
        data: Buffer.from("x").toString("base64"),
      },
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    // Path separators are stripped; `.` is preserved (so `..` survives, but the
    // timestamp prefix + GET-side pathResolve guard make it non-traversable).
    expect(body.name).not.toContain("/");
    expect(body.name).not.toContain(" ");
    expect(body.name).not.toContain("@");
    expect(body.name).toMatch(/_\.\._etc_pa_ss_w_rd\.txt$/);
  });

  it("POST /upload rejects missing filename", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: { data: Buffer.from("x").toString("base64") },
    });
    expect(res.json()).toEqual({ ok: false, error: "Missing filename or data" });
  });

  it("POST /upload rejects missing data", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: { filename: "x.txt" },
    });
    expect(res.json()).toEqual({ ok: false, error: "Missing filename or data" });
  });

  it("POST /upload handles empty body", async () => {
    const res = await app.inject({ method: "POST", url: "/upload", payload: {} });
    expect(res.json()).toEqual({ ok: false, error: "Missing filename or data" });
  });

  it("GET /uploads/:name returns 404 for non-existent file", async () => {
    const res = await app.inject({ method: "GET", url: "/uploads/never-existed.txt" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("File not found");
  });

  it("GET /uploads/:name rejects path-traversal attempts with 403", async () => {
    // ../../etc/passwd kind of attack — encoded so Fastify still sees it as a single segment.
    const res = await app.inject({ method: "GET", url: "/uploads/..%2F..%2Fetc%2Fpasswd" });
    // Either the path-traversal guard catches it (403) or the file-not-found check fires (404).
    // Both are acceptable outcomes — what matters is we don't serve out-of-tree content.
    expect([403, 404]).toContain(res.statusCode);
  });

  it("GET /uploads/:name serves a previously-uploaded file", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/upload",
      payload: { filename: "served.txt", data: Buffer.from("served-content").toString("base64") },
    });
    const name = upload.json().name;
    const res = await app.inject({ method: "GET", url: `/uploads/${name}` });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe("served-content");
  });

  // ─────────────────────────────────────────────────────────────────────
  // v2.38 — extension allowlist + size cap (RAG dropzone hardening).
  // ─────────────────────────────────────────────────────────────────────

  it("v2.38: POST /upload rejects binary extensions (allowlist)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: {
        filename: "evil.exe",
        data: Buffer.from("MZ\x90\x00").toString("base64"),
      },
    });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Unsupported file extension/);
    expect(body.error).toMatch(/\.exe/);
  });

  it("v2.38: POST /upload rejects extension-less filename", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: {
        filename: "noextension",
        data: Buffer.from("x").toString("base64"),
      },
    });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Unsupported file extension/);
    expect(body.error).toMatch(/\(none\)/);
  });

  it("v2.38: POST /upload accepts extension case-insensitively", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: { filename: "DOC.MD", data: Buffer.from("# Title").toString("base64") },
    });
    expect(res.json().ok).toBe(true);
  });

  it("v2.38: POST /upload rejects payloads over the size cap", async () => {
    // Build a payload just over 50 MB after decode. 50 MB = 52428800 bytes.
    // We use a small buffer + repeat to keep the test runtime tight.
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1, 0x41); // 50MB + 1 byte of 'A'
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: {
        filename: "big.txt",
        data: oversized.toString("base64"),
      },
    });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/File too large/);
    expect(body.error).toMatch(/50 MB/);
  });

  it("v2.38: POST /upload still accepts at-the-cap payload", async () => {
    // Exactly at the cap should succeed (it's a strict `>` check, not `>=`).
    const atCap = Buffer.alloc(50 * 1024 * 1024, 0x41);
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: {
        filename: "atcap.txt",
        data: atCap.toString("base64"),
      },
    });
    expect(res.json().ok).toBe(true);
  });

  it("v2.38: extension check fires BEFORE size check (cheap-first ordering)", async () => {
    // An oversized .exe should fail on extension, not size — proves we
    // don't decode the huge base64 payload before rejecting.
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1, 0x41);
    const res = await app.inject({
      method: "POST",
      url: "/upload",
      payload: {
        filename: "huge.exe",
        data: oversized.toString("base64"),
      },
    });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Unsupported file extension/);
    expect(body.error).not.toMatch(/File too large/);
  });
});
