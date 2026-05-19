"""Tests for RAGRetriever — verify retrieval behavior, not structure.

Uses a deterministic fake embedder so tests pass without sentence-transformers
in the venv and run in milliseconds. Production correctness is covered by:
  - retrieval ranks semantically closer chunks higher (via fake "topic vectors")
  - re-indexing same content is a no-op (idempotency)
  - empty / missing / changed files handled
  - chunks preserve doc provenance
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import List, Sequence

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from memory.rag_retriever import (  # noqa: E402
    Chunk,
    RAGRetriever,
    chunk_text,
)


# ─── Fake embedder ───────────────────────────────────────────────────────────


class TopicEmbedder:
    """Deterministic embedder that produces vectors based on keyword presence.

    Each "topic" (cat/dog/python/golang/...) gets a fixed orthogonal basis
    vector. The encoded vector is a normalized sum of the topics present in
    the text. This makes cosine similarity meaningful for tests:
    "cat sleeps" and "cat eats" share the cat vector and score high; "cat"
    and "golang" share nothing and score near 0.
    """

    TOPICS = ["cat", "dog", "python", "golang", "rust", "fastapi", "database"]
    DIM = len(TOPICS)

    def encode(self, texts: Sequence[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.DIM), dtype=np.float32)
        for i, text in enumerate(texts):
            lower = text.lower()
            vec = np.zeros(self.DIM, dtype=np.float32)
            for j, topic in enumerate(self.TOPICS):
                if topic in lower:
                    vec[j] = 1.0
            norm = np.linalg.norm(vec)
            out[i] = vec / norm if norm > 0 else vec
        return out


@pytest.fixture
def retriever(tmp_path: Path):
    db = tmp_path / "rag.db"
    return RAGRetriever(db_path=str(db), embedder=TopicEmbedder())


def write_file(tmp_path: Path, name: str, content: str) -> str:
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return str(path)


# ─── chunk_text unit tests ───────────────────────────────────────────────────


class TestChunkText:
    def test_empty_returns_empty(self):
        assert chunk_text("") == []

    def test_short_text_one_chunk(self):
        assert chunk_text("hello world") == ["hello world"]

    def test_long_text_split_with_overlap(self):
        text = "a" * 2000
        chunks = chunk_text(text, chunk_chars=500, overlap=50)
        assert len(chunks) >= 3
        # All chunks within size budget
        assert all(len(c) <= 500 for c in chunks)
        # Overlap: consecutive chunks share characters
        # (since text is uniform, exact overlap == 50)
        assert chunks[0][-50:] == chunks[1][:50]

    def test_invalid_overlap_raises(self):
        with pytest.raises(ValueError):
            chunk_text("text", chunk_chars=100, overlap=100)

    def test_invalid_chunk_size_raises(self):
        with pytest.raises(ValueError):
            chunk_text("text", chunk_chars=0)

    def test_prefers_paragraph_boundary(self):
        # \n\n at position 150 falls inside the search range [100, 200].
        # The chunker should split there rather than hard-cut at 200.
        text = ("a" * 150) + "\n\n" + ("b" * 150)
        chunks = chunk_text(text, chunk_chars=200, overlap=20)
        assert chunks[0].endswith("\n\n")
        assert chunks[0] == "a" * 150 + "\n\n"


# ─── RAGRetriever tests ──────────────────────────────────────────────────────


class TestIndexing:
    def test_index_file_records_doc_and_chunks(self, retriever, tmp_path):
        path = write_file(tmp_path, "a.md", "the cat sat on the mat")
        result = retriever.index_file(path)
        assert result.indexed is True
        assert result.chunks_count == 1
        assert result.reason == "indexed"

        stats = retriever.stats()
        assert stats.docs_count == 1
        assert stats.chunks_count == 1
        assert stats.embedding_dim == TopicEmbedder.DIM

    def test_index_file_missing_returns_unindexed(self, retriever, tmp_path):
        result = retriever.index_file(str(tmp_path / "nope.md"))
        assert result.indexed is False
        assert result.reason == "file not found"

    def test_index_empty_file_skipped(self, retriever, tmp_path):
        path = write_file(tmp_path, "empty.md", "   \n\t  ")
        result = retriever.index_file(path)
        assert result.indexed is False
        assert result.reason == "empty file"

    def test_reindex_same_content_is_idempotent(self, retriever, tmp_path):
        path = write_file(tmp_path, "a.md", "the cat sat on the mat")
        first = retriever.index_file(path)
        second = retriever.index_file(path)
        assert first.indexed is True
        assert second.indexed is False
        assert second.reason == "unchanged"
        assert second.chunks_count == first.chunks_count
        # No duplicate chunks
        assert retriever.stats().chunks_count == 1

    def test_reindex_after_content_change_replaces_chunks(self, retriever, tmp_path):
        path = write_file(tmp_path, "a.md", "the cat slept")
        retriever.index_file(path)
        # Modify content (and mtime advances naturally)
        Path(path).write_text("the dog barked", encoding="utf-8")
        # Force mtime to advance even if filesystem rounding made it equal
        future = os.path.getmtime(path) + 2
        os.utime(path, (future, future))

        result = retriever.index_file(path)
        assert result.indexed is True
        # Still one doc, content replaced
        assert retriever.stats().docs_count == 1

    def test_index_dir_walks_glob(self, retriever, tmp_path):
        write_file(tmp_path, "a.md", "cat")
        write_file(tmp_path, "b.txt", "dog")
        (tmp_path / "sub").mkdir()
        write_file(tmp_path, "sub/c.md", "python")
        results = retriever.index_dir(str(tmp_path), glob="**/*.md")
        # Two md files indexed; .txt skipped by glob
        indexed_paths = [r.path for r in results if r.indexed]
        assert len(indexed_paths) == 2


class TestRetrieval:
    def test_retrieve_returns_topic_match(self, retriever, tmp_path):
        retriever.index_file(write_file(tmp_path, "cats.md", "cat sleeps on the mat"))
        retriever.index_file(write_file(tmp_path, "dogs.md", "dog barks at mailman"))
        retriever.index_file(write_file(tmp_path, "rust.md", "rust is a systems language"))

        results = retriever.retrieve("the cat is purring", k=3)
        assert len(results) == 3
        # Cat doc must rank #1
        assert Path(results[0].doc_path).name == "cats.md"
        assert results[0].score > results[1].score

    def test_retrieve_respects_k(self, retriever, tmp_path):
        for i in range(5):
            retriever.index_file(write_file(tmp_path, f"d{i}.md", f"document number {i} about cat"))
        results = retriever.retrieve("cat", k=2)
        assert len(results) == 2

    def test_retrieve_empty_query_returns_empty(self, retriever, tmp_path):
        retriever.index_file(write_file(tmp_path, "a.md", "cat"))
        assert retriever.retrieve("", k=5) == []
        assert retriever.retrieve("   ", k=5) == []
        assert retriever.retrieve("cat", k=0) == []

    def test_retrieve_with_no_indexed_docs_returns_empty(self, retriever):
        assert retriever.retrieve("anything", k=5) == []

    def test_retrieve_returns_chunk_provenance(self, retriever, tmp_path):
        path = write_file(tmp_path, "story.md", "cat first paragraph. " + ("filler " * 200) + "cat last paragraph")
        retriever.index_file(path)
        results = retriever.retrieve("cat", k=2)
        assert all(isinstance(r, Chunk) for r in results)
        assert all(r.doc_path == str(Path(path).resolve()) for r in results)
        # Chunk indices distinct
        assert len({r.chunk_idx for r in results}) == len(results)


class TestLifecycle:
    def test_remove_file_purges_chunks(self, retriever, tmp_path):
        path = write_file(tmp_path, "a.md", "cat dog python")
        retriever.index_file(path)
        assert retriever.stats().chunks_count >= 1

        removed = retriever.remove_file(path)
        assert removed is True
        assert retriever.stats().docs_count == 0
        assert retriever.stats().chunks_count == 0

    def test_remove_unknown_file_returns_false(self, retriever, tmp_path):
        assert retriever.remove_file(str(tmp_path / "never-indexed.md")) is False

    def test_list_documents_returns_indexed_paths(self, retriever, tmp_path):
        write_file(tmp_path, "a.md", "cat")
        write_file(tmp_path, "b.md", "dog")
        retriever.index_dir(str(tmp_path), glob="**/*.md")
        docs = retriever.list_documents()
        names = sorted(Path(p).name for p, _ in docs)
        assert names == ["a.md", "b.md"]


class TestEmbedderContract:
    def test_no_embedder_raises_on_retrieve(self, tmp_path):
        # No embedder passed; should raise the moment we try to embed.
        retriever = RAGRetriever(db_path=str(tmp_path / "rag.db"), embedder=None)
        with pytest.raises(RuntimeError, match="no embedder"):
            retriever.retrieve("anything", k=5)

    def test_no_embedder_raises_on_index(self, tmp_path):
        retriever = RAGRetriever(db_path=str(tmp_path / "rag.db"), embedder=None)
        path = write_file(tmp_path, "a.md", "some content")
        with pytest.raises(RuntimeError, match="no embedder"):
            retriever.index_file(path)
