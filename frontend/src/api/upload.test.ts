/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  uploadApi,
  readFileAsBase64,
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  extractExtension,
  validateUploadCandidate,
} from "./upload";

vi.mock("./client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

import { api } from "./client";

describe("upload API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("readFileAsBase64 resolves with base64 string", async () => {
    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    const result = await readFileAsBase64(file);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("upload calls correct endpoint with base64 data", async () => {
    const file = new File(["hello world"], "hello.txt", { type: "text/plain" });
    vi.mocked(api.post).mockResolvedValue({ ok: true, url: "/uploads/hello.txt" });

    const result = await uploadApi.upload(file);

    expect(api.post).toHaveBeenCalledWith(
      "/api/upload",
      expect.objectContaining({
        filename: "hello.txt",
        type: "text/plain",
      })
    );
    expect(result).toEqual({ ok: true, url: "/uploads/hello.txt" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v2.38 — pure pre-check helpers (no network).
// ─────────────────────────────────────────────────────────────────────────

function makeFile(name: string, sizeBytes: number): File {
  // Build a synthetic File with the requested apparent size. We use a
  // tiny payload + override `size` because allocating 50MB in a test is
  // wasteful and slow — File.size is a regular configurable property in
  // jsdom, so the override is honored by our pre-check logic.
  const f = new File([new Uint8Array([0])], name);
  Object.defineProperty(f, "size", { value: sizeBytes, configurable: true });
  return f;
}

describe("v2.38 extractExtension", () => {
  it("returns lowercase dotted extension", () => {
    expect(extractExtension("notes.MD")).toBe(".md");
    expect(extractExtension("Doc.Txt")).toBe(".txt");
  });

  it("returns empty string when no extension", () => {
    expect(extractExtension("plainname")).toBe("");
  });

  it("returns empty string when the file ends with a dot", () => {
    expect(extractExtension("trailing.")).toBe("");
  });

  it("only the final dotted segment counts (mid-name dots ignored)", () => {
    expect(extractExtension("archive.tar.gz")).toBe(".gz");
  });
});

describe("v2.38 validateUploadCandidate", () => {
  it("accepts a normal .md text file", () => {
    expect(validateUploadCandidate(makeFile("notes.md", 1024))).toBeNull();
  });

  it("rejects unknown extension with helpful message", () => {
    const reason = validateUploadCandidate(makeFile("evil.exe", 100));
    expect(reason).not.toBeNull();
    expect(reason!).toMatch(/不支持的扩展名/);
    expect(reason!).toMatch(/\.exe/);
  });

  it("rejects no-extension filename", () => {
    const reason = validateUploadCandidate(makeFile("noext", 100));
    expect(reason).not.toBeNull();
    expect(reason!).toMatch(/不支持的扩展名/);
    expect(reason!).toMatch(/\(无\)/);
  });

  it("rejects file over MAX_UPLOAD_BYTES", () => {
    const reason = validateUploadCandidate(
      makeFile("big.txt", MAX_UPLOAD_BYTES + 1)
    );
    expect(reason).not.toBeNull();
    expect(reason!).toMatch(/文件过大/);
    expect(reason!).toMatch(/50 MB/);
  });

  it("accepts file exactly at MAX_UPLOAD_BYTES (boundary)", () => {
    expect(
      validateUploadCandidate(makeFile("atcap.txt", MAX_UPLOAD_BYTES))
    ).toBeNull();
  });

  it("extension check fires BEFORE size check (cheap-first)", () => {
    // Oversized .exe must surface as extension-rejected, not size-rejected.
    const reason = validateUploadCandidate(
      makeFile("huge.exe", MAX_UPLOAD_BYTES + 1)
    );
    expect(reason!).toMatch(/不支持的扩展名/);
    expect(reason!).not.toMatch(/文件过大/);
  });

  it("extension comparison is case-insensitive", () => {
    expect(validateUploadCandidate(makeFile("DOC.MD", 100))).toBeNull();
    expect(validateUploadCandidate(makeFile("Script.PY", 100))).toBeNull();
  });
});

describe("v2.38 ALLOWED_UPLOAD_EXTENSIONS sanity", () => {
  it("includes the commonly-claimed text formats", () => {
    for (const ext of [".txt", ".md", ".json", ".csv", ".yaml", ".py"]) {
      expect(ALLOWED_UPLOAD_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it("does NOT include known-bad binary formats (RAG can't index them)", () => {
    for (const ext of [".pdf", ".docx", ".xlsx", ".png", ".jpg", ".exe", ".zip"]) {
      expect(ALLOWED_UPLOAD_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});
