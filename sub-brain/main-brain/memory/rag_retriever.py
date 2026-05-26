"""
RAG Retriever — document grounding over local files.

Distinct from MemoryManager: that one is conversational L1-L4 memory. This one
indexes documents (PDF text, markdown, source code, notes) so the agent can cite
them when answering questions.

Storage: standalone SQLite at ~/.webrain/rag.db, schema:
    documents(path, mtime, content_hash, chunks_count)
    chunks(id, doc_path, chunk_idx, text, embedding BLOB)

Design rules followed (PROJECT_STATE.md §3 哲学):
- No `Any` in public signatures.
- Failure-mode aware: file gone, embedder missing, db locked all handled.
- Embedder injected (Protocol) so tests don't need sentence-transformers.
- Idempotent index_file (re-indexing same content is a no-op via mtime+hash).
"""

from __future__ import annotations

import hashlib
import logging
import os
import sqlite3
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Protocol, Sequence, Tuple

import numpy as np

logger = logging.getLogger("webrain.memory.rag")


# ─── Protocols & DTOs ────────────────────────────────────────────────────────


class Embedder(Protocol):
    """Anything that can turn text into a fixed-length float vector.

    The production embedder is `sentence_transformers.SentenceTransformer`;
    tests pass a fake that returns deterministic vectors.
    """

    def encode(self, texts: Sequence[str]) -> np.ndarray:
        """Returns a 2D array shape (len(texts), dim). dim must be stable
        per embedder instance."""
        ...


@dataclass(frozen=True)
class Chunk:
    """One retrieved chunk with provenance."""

    doc_path: str
    chunk_idx: int
    text: str
    score: float  # cosine similarity, higher = more relevant


@dataclass(frozen=True)
class IndexResult:
    """Outcome of indexing a single file."""

    path: str
    indexed: bool      # False if unchanged since last index (mtime+hash match)
    chunks_count: int
    reason: str        # e.g. "indexed", "unchanged", "empty file", "read failed"


@dataclass(frozen=True)
class RAGStats:
    docs_count: int
    chunks_count: int
    embedding_dim: int


# ─── Chunking ────────────────────────────────────────────────────────────────


# Conservative defaults; tuned for ~512-token English/中文 mixed text.
DEFAULT_CHUNK_CHARS = 800
DEFAULT_CHUNK_OVERLAP = 120


def chunk_text(
    text: str,
    *,
    chunk_chars: int = DEFAULT_CHUNK_CHARS,
    overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> List[str]:
    """Sliding-window chunker. Prefers splitting at paragraph/sentence
    boundaries when possible but falls back to hard cuts."""
    if not text:
        return []
    if chunk_chars <= 0:
        raise ValueError("chunk_chars must be positive")
    if overlap < 0 or overlap >= chunk_chars:
        raise ValueError("overlap must be in [0, chunk_chars)")

    out: List[str] = []
    n = len(text)
    start = 0
    while start < n:
        end = min(start + chunk_chars, n)
        # Try to land on a paragraph boundary
        if end < n:
            for sep in ["\n\n", "\n", "。", "！", "? ", ". ", "; "]:
                idx = text.rfind(sep, start + chunk_chars // 2, end)
                if idx > start:
                    end = idx + len(sep)
                    break
        out.append(text[start:end])
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return out


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _embedding_to_blob(vec: np.ndarray) -> bytes:
    """Pack as little-endian float32 array. SQLite stores BLOB; small + portable."""
    return struct.pack(f"<{vec.size}f", *vec.astype(np.float32).tolist())


def _blob_to_embedding(blob: bytes, dim: int) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)[:dim].copy()


def _cosine_sim(query: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """Vectorized cosine similarity. query (D,), matrix (N, D) → (N,)."""
    q_norm = np.linalg.norm(query)
    if q_norm == 0:
        return np.zeros(matrix.shape[0], dtype=np.float32)
    m_norms = np.linalg.norm(matrix, axis=1)
    m_norms = np.where(m_norms == 0, 1.0, m_norms)
    return (matrix @ query) / (m_norms * q_norm)


# ─── Retriever ───────────────────────────────────────────────────────────────


class RAGRetriever:
    """Document-grounded retrieval. Pure Python, single-file SQLite, no Qdrant.

    Threading: SQLite connection is opened per call. Safe for sequential use;
    callers wanting parallelism should serialize at a higher layer.
    """

    def __init__(
        self,
        db_path: Optional[str] = None,
        embedder: Optional[Embedder] = None,
    ):
        self.db_path = str(db_path) if db_path else str(Path.home() / ".webrain" / "rag.db")
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self.embedder = embedder
        self._dim: Optional[int] = None  # discovered lazily
        self._init_db()

    # ---- schema ----

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            # v2.43 (Sprint 0.7 quick win) — RAG previously had zero
            # PRAGMAs while MemoryManager already ran WAL. Even though
            # rag.db sees lower write QPS than memory.db, the DELETE
            # journal mode meant concurrent index_file + chat query
            # serialized through the same disk fsync. Match the
            # MemoryManager triple (WAL + synchronous=NORMAL +
            # busy_timeout=5000) so writes don't block readers.
            conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;
                PRAGMA busy_timeout=5000;

                CREATE TABLE IF NOT EXISTS rag_documents (
                    path TEXT PRIMARY KEY,
                    mtime REAL NOT NULL,
                    content_hash TEXT NOT NULL,
                    chunks_count INTEGER NOT NULL,
                    indexed_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS rag_chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    doc_path TEXT NOT NULL,
                    chunk_idx INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    embedding BLOB NOT NULL,
                    FOREIGN KEY (doc_path) REFERENCES rag_documents(path) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_chunks_doc ON rag_chunks(doc_path);
                """
            )

    # ---- embedder ----

    def _embed(self, texts: Sequence[str]) -> np.ndarray:
        if not self.embedder:
            raise RuntimeError(
                "RAGRetriever has no embedder. Pass one in the constructor "
                "(production: SentenceTransformer instance; tests: a fake)."
            )
        vectors = self.embedder.encode(texts)
        if not isinstance(vectors, np.ndarray):
            vectors = np.asarray(vectors, dtype=np.float32)
        if vectors.ndim != 2:
            raise ValueError(f"Embedder must return a 2D array; got shape {vectors.shape}")
        if self._dim is None:
            self._dim = int(vectors.shape[1])
        elif vectors.shape[1] != self._dim:
            raise ValueError(
                f"Embedder dim drift: started at {self._dim}, now {vectors.shape[1]}"
            )
        return vectors.astype(np.float32, copy=False)

    # ---- indexing ----

    def index_file(self, path: str) -> IndexResult:
        """Read + chunk + embed + store a single file. Idempotent."""
        resolved = str(Path(path).resolve())

        if not Path(resolved).exists() or not Path(resolved).is_file():
            return IndexResult(resolved, indexed=False, chunks_count=0, reason="file not found")

        try:
            content = Path(resolved).read_text(encoding="utf-8", errors="replace")
        except Exception as e:  # pragma: no cover — fs errors
            logger.warning("rag: read failed for %s: %s", resolved, e)
            return IndexResult(resolved, indexed=False, chunks_count=0, reason=f"read failed: {e}")

        if not content.strip():
            return IndexResult(resolved, indexed=False, chunks_count=0, reason="empty file")

        mtime = os.path.getmtime(resolved)
        content_hash = _content_hash(content)

        # Idempotency: skip if mtime+hash unchanged.
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT mtime, content_hash, chunks_count FROM rag_documents WHERE path = ?",
                (resolved,),
            ).fetchone()
            if row and row[1] == content_hash:
                return IndexResult(
                    resolved, indexed=False, chunks_count=int(row[2]), reason="unchanged"
                )

        chunks = chunk_text(content)
        if not chunks:
            return IndexResult(resolved, indexed=False, chunks_count=0, reason="empty after chunking")

        # Re-embed. (If embedder is unavailable, error bubbles up.)
        vectors = self._embed(chunks)

        with sqlite3.connect(self.db_path) as conn:
            # Replace existing chunks atomically.
            conn.execute("DELETE FROM rag_chunks WHERE doc_path = ?", (resolved,))
            conn.execute(
                """INSERT OR REPLACE INTO rag_documents
                   (path, mtime, content_hash, chunks_count, indexed_at)
                   VALUES (?, ?, ?, ?, datetime('now'))""",
                (resolved, mtime, content_hash, len(chunks)),
            )
            conn.executemany(
                "INSERT INTO rag_chunks (doc_path, chunk_idx, text, embedding) VALUES (?, ?, ?, ?)",
                [
                    (resolved, i, chunks[i], _embedding_to_blob(vectors[i]))
                    for i in range(len(chunks))
                ],
            )

        return IndexResult(resolved, indexed=True, chunks_count=len(chunks), reason="indexed")

    def index_dir(self, dir_path: str, glob: str = "**/*") -> List[IndexResult]:
        """Walk a directory, index every file matching glob.
        Default `**/*` indexes everything; pass e.g. `**/*.md` to filter.
        """
        base = Path(dir_path)
        if not base.exists() or not base.is_dir():
            return []
        results: List[IndexResult] = []
        for p in base.glob(glob):
            if p.is_file():
                results.append(self.index_file(str(p)))
        return results

    def remove_file(self, path: str) -> bool:
        """Delete all chunks + metadata for a file. Returns True if anything was removed."""
        resolved = str(Path(path).resolve())
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute("DELETE FROM rag_documents WHERE path = ?", (resolved,))
            removed_docs = cur.rowcount
            conn.execute("DELETE FROM rag_chunks WHERE doc_path = ?", (resolved,))
            return removed_docs > 0

    # ---- retrieval ----

    def retrieve(self, query: str, k: int = 5) -> List[Chunk]:
        """Top-k cosine-similar chunks for `query` across all indexed docs."""
        if not query.strip() or k <= 0:
            return []

        q_vec = self._embed([query])[0]

        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT doc_path, chunk_idx, text, embedding FROM rag_chunks"
            ).fetchall()

        if not rows:
            return []

        dim = q_vec.size
        matrix = np.stack([_blob_to_embedding(r[3], dim) for r in rows])
        scores = _cosine_sim(q_vec, matrix)
        # argpartition top-k for speed; then sort just those.
        idx = np.argpartition(scores, -min(k, scores.size))[-k:]
        idx = idx[np.argsort(scores[idx])[::-1]]

        return [
            Chunk(
                doc_path=rows[i][0],
                chunk_idx=int(rows[i][1]),
                text=rows[i][2],
                score=float(scores[i]),
            )
            for i in idx
        ]

    # ---- introspection ----

    def stats(self) -> RAGStats:
        with sqlite3.connect(self.db_path) as conn:
            docs = conn.execute("SELECT COUNT(*) FROM rag_documents").fetchone()[0]
            chunks = conn.execute("SELECT COUNT(*) FROM rag_chunks").fetchone()[0]
        return RAGStats(docs_count=int(docs), chunks_count=int(chunks), embedding_dim=self._dim or 0)

    def list_documents(self) -> List[Tuple[str, int]]:
        """Returns (path, chunks_count) for each indexed doc."""
        with sqlite3.connect(self.db_path) as conn:
            return [
                (row[0], int(row[1]))
                for row in conn.execute(
                    "SELECT path, chunks_count FROM rag_documents ORDER BY indexed_at DESC"
                ).fetchall()
            ]
