import { api } from "./client";
import { ragApi } from "./rag";

export interface UploadResult {
  ok: boolean;
  url?: string;
  name?: string;
  /** v2.34: server-resolved absolute path. Pass directly to
   * /brain/rag/index_file when the upload should also be indexed. */
  absolute_path?: string;
  size?: number;
  type?: string;
  error?: string;
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // DataURL format: data:[type];base64,[data]
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const uploadApi = {
  upload: async (file: File): Promise<UploadResult> => {
    const data = await readFileAsBase64(file);
    return api.post<UploadResult>("/api/upload", {
      filename: file.name,
      data,
      type: file.type,
    });
  },

  /**
   * v2.34: chained upload-then-index helper for the RAG drag-drop UX.
   * Uploads via /api/upload, then if the server returned an absolute_path,
   * calls /brain/rag/index_file. Failures at the index step do NOT roll
   * back the upload — the file is still on disk, user can retry-index.
   */
  uploadAndIndex: async (
    file: File
  ): Promise<{
    upload: UploadResult;
    indexed: boolean;
    chunks?: number;
    error?: string;
  }> => {
    const upload = await uploadApi.upload(file);
    if (!upload.ok || !upload.absolute_path) {
      return { upload, indexed: false, error: upload.error || "upload failed" };
    }
    try {
      const idx = await ragApi.indexFile(upload.absolute_path);
      return {
        upload,
        indexed: !!idx.ok,
        chunks: idx.chunks_count,
        error: idx.ok ? undefined : idx.error || "index failed",
      };
    } catch (e) {
      return {
        upload,
        indexed: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
};
