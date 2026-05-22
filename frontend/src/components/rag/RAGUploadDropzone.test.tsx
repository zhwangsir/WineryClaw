/**
 * @vitest-environment jsdom
 *
 * v2.34 — RAGUploadDropzone tests (P1 #10).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import RAGUploadDropzone from "./RAGUploadDropzone";

vi.mock("../../api/upload", () => ({
  uploadApi: {
    upload: vi.fn(),
    uploadAndIndex: vi.fn(),
  },
}));

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
});
