/**
 * @vitest-environment jsdom
 *
 * v2.34 — RAGUploadDropzone tests (P1 #10).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import RAGUploadDropzone from "./RAGUploadDropzone";

// v2.38: keep real exports (validateUploadCandidate,
// ALLOWED_UPLOAD_EXTENSIONS, MAX_UPLOAD_BYTES) — only stub uploadApi.
// Without importActual, the dropzone's pre-check would receive undefined.
vi.mock("../../api/upload", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/upload")>("../../api/upload");
  return {
    ...actual,
    uploadApi: {
      upload: vi.fn(),
      uploadAndIndex: vi.fn(),
    },
  };
});

import { uploadApi } from "../../api/upload";

describe("RAGUploadDropzone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the dragger with hint text", () => {
    render(<RAGUploadDropzone />);
    expect(screen.getByText(/拖拽文件到这里/)).toBeInTheDocument();
    expect(screen.getByText(/支持 .txt/)).toBeInTheDocument();
  });

  it("processes a dropped file: queued → uploading → done with chunk count", async () => {
    vi.mocked(uploadApi.uploadAndIndex).mockResolvedValue({
      upload: { ok: true, url: "/uploads/x", name: "x", absolute_path: "/tmp/x" },
      indexed: true,
      chunks: 5,
    });
    const onIndexed = vi.fn();
    render(<RAGUploadDropzone onIndexed={onIndexed} />);

    // Use the component's processOne path via the file input that AntD
    // Upload exposes (hidden input[type=file]).
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    const file = new File(["hello"], "note.md", { type: "text/markdown" });
    // Fire change event with the file.
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(uploadApi.uploadAndIndex).toHaveBeenCalledWith(file);
    });
    await waitFor(() => {
      expect(screen.getByText("note.md")).toBeInTheDocument();
    });
    // Final state should be "完成 · 5 chunks"
    await waitFor(() => {
      expect(screen.getByText(/完成.*5 chunks/)).toBeInTheDocument();
    });
    expect(onIndexed).toHaveBeenCalled();
  });

  it("upload-fail path shows failure tag + error tooltip text", async () => {
    vi.mocked(uploadApi.uploadAndIndex).mockResolvedValue({
      upload: { ok: false, error: "Disk full" },
      indexed: false,
      error: "Disk full",
    });
    render(<RAGUploadDropzone />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "bad.md");
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(screen.getByText("失败")).toBeInTheDocument();
    });
    // "Disk full" appears both in the antd message toast AND the per-file
    // error span; getAllByText to accept both occurrences.
    expect(screen.getAllByText(/Disk full/).length).toBeGreaterThanOrEqual(1);
  });

  it("upload-ok + index-fail shows partial failure (file saved warning)", async () => {
    vi.mocked(uploadApi.uploadAndIndex).mockResolvedValue({
      upload: { ok: true, url: "/uploads/x", name: "x", absolute_path: "/tmp/x" },
      indexed: false,
      error: "embedder OOM",
    });
    render(<RAGUploadDropzone />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "huge.md");
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(screen.getByText("失败")).toBeInTheDocument();
    });
    // Same dual-render note as above.
    expect(screen.getAllByText(/embedder OOM|索引失败/).length).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // v2.38 — client-side allowlist + size pre-check.
  // ─────────────────────────────────────────────────────────────────────

  it("v2.38: rejects file with disallowed extension WITHOUT calling uploadApi", async () => {
    render(<RAGUploadDropzone />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const bad = new File(["MZ\x90\x00"], "evil.exe", { type: "application/octet-stream" });
    Object.defineProperty(input, "files", { value: [bad] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(screen.getByText("失败")).toBeInTheDocument();
    });
    // The file appears in the list with a Chinese rejection reason that
    // includes the disallowed extension.
    expect(screen.getAllByText(/不支持的扩展名/).length).toBeGreaterThanOrEqual(1);
    // Critical: uploadApi.uploadAndIndex must NOT have been called — the
    // whole point of the pre-check is to avoid network round-trips.
    expect(uploadApi.uploadAndIndex).not.toHaveBeenCalled();
  });

  it("v2.38: rejects file lacking any extension WITHOUT calling uploadApi", async () => {
    render(<RAGUploadDropzone />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const noExt = new File(["x"], "noextension", { type: "" });
    Object.defineProperty(input, "files", { value: [noExt] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(screen.getByText("失败")).toBeInTheDocument();
    });
    expect(uploadApi.uploadAndIndex).not.toHaveBeenCalled();
  });

  it("v2.38: hint text no longer claims false PDF / DOCX support", () => {
    render(<RAGUploadDropzone />);
    // Pre-fix the hint advertised ".pdf / .docx" which silently produced
    // garbage when indexed. Confirm those misleading tokens are gone.
    expect(screen.queryByText(/\.pdf/)).toBeNull();
    expect(screen.queryByText(/\.docx/)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────
// v2.38 — front/back allowlist drift detector.
//
// The frontend mirrors the backend's ALLOWED_EXTENSIONS list as a Set
// in src/api/upload.ts. If someone updates one side without the other
// (a recurring class of bug across this project), the upload UX breaks
// in either direction:
//   - Backend stricter: user adds .csv, frontend lets it through, server
//     rejects with a confusing 200-payload error.
//   - Frontend stricter: user has .csv-supporting backend, frontend
//     rejects before bytes go over the wire.
// The drift test below is a static string list — keep both in sync.
// ───────────────────────────────────────────────────────────────────────

describe("v2.38 RAG upload allowlist contract", () => {
  it("frontend ALLOWED_UPLOAD_EXTENSIONS mirrors backend allowlist", async () => {
    const { ALLOWED_UPLOAD_EXTENSIONS } = await vi.importActual<
      typeof import("../../api/upload")
    >("../../api/upload");
    const expected = new Set([
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
    expect([...ALLOWED_UPLOAD_EXTENSIONS].sort()).toEqual([...expected].sort());
  });
});
