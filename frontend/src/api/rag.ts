/**
 * RAG (document grounding) API client.
 *
 * 8 endpoints — index/query/stats/remove + watcher start/stop/status.
 * All routes proxied through /brain/* to main-brain.
 */

import { api } from "./client";

export interface RAGChunk {
  doc_path: string;
  chunk_idx: number;
  text: string;
  score: number;
}

export interface RAGStats {
  ok: boolean;
  docs_count: number;
  chunks_count: number;
  embedding_dim: number;
  documents: Array<[string, number]>; // [path, chunks_count][]
}

export interface IndexFileResult {
  ok: boolean;
  indexed?: boolean;
  chunks_count?: number;
  reason?: string;
  path?: string;
  error?: string;
}

export interface IndexDirResult {
  ok: boolean;
  files?: Array<{
    path: string;
    indexed: boolean;
    chunks: number;
    reason: string;
  }>;
  indexed_count?: number;
  error?: string;
}

export interface QueryResult {
  ok: boolean;
  chunks?: RAGChunk[];
  error?: string;
}

export interface WatcherStatus {
  running: boolean;
  watching?: string[];
  glob?: string;
  debounce_ms?: number;
  pending_count?: number;
}

export interface WatcherStartParams {
  paths: string[];
  glob?: string;
  debounce_ms?: number;
}

export interface WatcherStartResult {
  ok: boolean;
  watching?: string[];
  glob?: string;
  debounce_ms?: number;
  error?: string;
}

export const ragApi = {
  indexFile: (path: string) => api.post<IndexFileResult>("/brain/rag/index_file", { path }),

  indexDir: (dir_path: string, glob = "**/*") => api.post<IndexDirResult>("/brain/rag/index_dir", { dir_path, glob }),

  query: (query: string, k = 5) => api.post<QueryResult>("/brain/rag/query", { query, k }),

  stats: () => api.get<RAGStats>("/brain/rag/stats"),

  removeFile: (path: string) =>
    api.delete<{ ok: boolean; removed: boolean }>("/brain/rag/file", {
      data: { path },
    }),

  watcherStart: (params: WatcherStartParams) => api.post<WatcherStartResult>("/brain/rag/watcher/start", params),

  watcherStop: () => api.post<{ ok: boolean }>("/brain/rag/watcher/stop", {}),

  watcherStatus: () => api.get<WatcherStatus>("/brain/rag/watcher/status"),
};
