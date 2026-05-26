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

/**
 * v2.38: mirror of `ALLOWED_EXTENSIONS` from
 * sub-brain/src/server/uploads-routes.ts. Used for client-side pre-check
 * so we don't waste bandwidth on a file the server will reject anyway.
 *
 * Keep this in sync with the backend allowlist. The shape is a Set of
 * dotted lowercase extensions, e.g. ".md". A drift would surface as a
 * mismatched-allowlist test failure (added intentionally below).
 */
export const ALLOWED_UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
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

/** v2.38: mirror of MAX_UPLOAD_BYTES from the backend (50 MB). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Extract the dotted lowercase extension from a filename ("MyDoc.MD" → ".md").
 * Returns empty string if there's no extension.
 */
export function extractExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot).toLowerCase();
}

/**
 * Validate a File against the upload allowlist + size cap.
 * Returns null if OK, otherwise a user-facing reason string.
 */
export function validateUploadCandidate(file: File): string | null {
  const ext = extractExtension(file.name);
  if (!ext || !ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    return `不支持的扩展名: "${ext || "(无)"}"。允许的格式: ${[...ALLOWED_UPLOAD_EXTENSIONS].sort().join(", ")}`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `文件过大: ${file.size} 字节超过上限 ${MAX_UPLOAD_BYTES} 字节 (${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`;
  }
  return null;
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
