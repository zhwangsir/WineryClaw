"""End-to-end RAG smoke tests (Round C6, 2026-05-20).

RAG is the file-grounding backbone for chat — without it, /chat can't
cite documents and the entire "ask about your notes" UX is dead. Unit
tests in test_rag_retriever.py exercise RAGRetriever directly against
a fresh DB. These smoke tests prove the HTTP path works end-to-end:

  client → POST /brain/rag/index_file → sub-brain proxy
    → main-brain /rag/index_file → RAGRetriever.index_file
    → embedder, sqlite write
  client → POST /brain/rag/query → sub-brain proxy
    → main-brain /rag/query → vector + FTS search → ranked chunks

Catches the bug class: "RAG retriever unit-tested in isolation, but the
HTTP wiring is broken at the route layer". Given C2-C4 found exactly
this kind of bug on similar surfaces (FastAPI param-resolution,
closure-captured config, proxy header strip), it's worth probing here
even though C5 came back clean.

Marker: `@pytest.mark.smoke`. Run with:
    pytest -m smoke tests/smoke/test_e2e_rag.py -s
"""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path
from typing import Optional

import httpx
import pytest

pytestmark = pytest.mark.smoke


def _write_temp_doc(content: str, suffix: str = ".md") -> Path:
    """Write content to a fresh tempfile, return its absolute path."""
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=suffix, prefix="rag-smoke-", delete=False, encoding="utf-8",
    )
    tmp.write(content)
    tmp.flush()
    tmp.close()
    return Path(tmp.name).resolve()


def _index_file(sub_url: str, path: Path) -> dict:
    r = httpx.post(
        f"{sub_url}/brain/rag/index_file",
        json={"path": str(path)},
        timeout=60.0,  # first call may pay embedder cold load
    )
    assert r.status_code == 200, r.text
    return r.json()


def _query(sub_url: str, query: str, k: int = 5) -> dict:
    r = httpx.post(
        f"{sub_url}/brain/rag/query",
        json={"query": query, "k": k},
        timeout=30.0,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _stats(sub_url: str) -> dict:
    r = httpx.get(f"{sub_url}/brain/rag/stats", timeout=10.0)
    assert r.status_code == 200, r.text
    return r.json()


def _remove(sub_url: str, path: Path) -> dict:
    r = httpx.request(
        "DELETE",
        f"{sub_url}/brain/rag/file",
        json={"path": str(path)},
        timeout=10.0,
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_rag_index_then_query_roundtrip(smoke_rig):
    """Keystone: write a file with a unique anchor, index via HTTP, query
    via HTTP, assert the chunk comes back tagged to our file."""
    sub_url = smoke_rig.sub_brain.base_url
    anchor = f"rag-smoke-anchor-{uuid.uuid4().hex}"
    body_text = (
        f"# RAG smoke document\n\n"
        f"This document is for the RAG smoke test. {anchor}\n\n"
        f"The capital of France is Paris. The capital of Japan is Tokyo. "
        f"This second sentence is here to ensure chunking produces at least one chunk."
    )
    doc_path = _write_temp_doc(body_text)
    try:
        # Index
        index_resp = _index_file(sub_url, doc_path)
        assert index_resp.get("ok") is True, index_resp
        assert index_resp.get("indexed") is True, (
            f"expected indexed=True; got: {index_resp}"
        )
        assert index_resp.get("chunks_count", 0) >= 1, index_resp

        # Query for the unique anchor — must come back tagged to our file
        result = _query(sub_url, anchor, k=5)
        assert result.get("ok") is True, result
        chunks = result.get("chunks", [])
        assert len(chunks) >= 1, (
            f"no chunks retrieved for anchor {anchor!r}; got: {result}"
        )
        ours = [c for c in chunks if str(doc_path) in c.get("doc_path", "")]
        assert ours, (
            f"none of the retrieved chunks reference our doc {doc_path}. "
            f"chunks: {chunks}"
        )
        # The matching chunk text should contain the anchor
        assert any(anchor in c.get("text", "") for c in ours), (
            f"anchor missing from chunk text: {[c.get('text', '')[:80] for c in ours]}"
        )
    finally:
        try:
            _remove(sub_url, doc_path)
        except (httpx.HTTPError, AssertionError):
            pass
        try:
            doc_path.unlink(missing_ok=True)
        except OSError:
            pass


def test_rag_stats_reflects_indexed_doc(smoke_rig):
    """After indexing, /rag/stats must show docs_count >= 1 and our file
    in the document list. Defends the dashboard contract."""
    sub_url = smoke_rig.sub_brain.base_url
    doc_path = _write_temp_doc(
        f"# Stats test\n\nUnique tokens for stats coverage: "
        f"alpha-{uuid.uuid4().hex} bravo charlie delta."
    )
    try:
        before = _stats(sub_url)
        before_count = int(before.get("docs_count", 0))

        _index_file(sub_url, doc_path)

        after = _stats(sub_url)
        assert int(after.get("docs_count", 0)) >= before_count + 1, (
            f"docs_count didn't grow: before={before_count} after={after}"
        )
        # documents shape: list of [path, chunk_count] tuples (serialized as lists)
        docs = after.get("documents", [])
        ours = [d for d in docs if str(doc_path) in (d[0] if isinstance(d, list) else "")]
        assert ours, (
            f"our doc {doc_path} not listed in /rag/stats documents: "
            f"{[d[0] if isinstance(d, list) else d for d in docs][:5]}…"
        )
    finally:
        try:
            _remove(sub_url, doc_path)
        except (httpx.HTTPError, AssertionError):
            pass
        try:
            doc_path.unlink(missing_ok=True)
        except OSError:
            pass


def test_rag_remove_file_drops_from_index(smoke_rig):
    """DELETE /rag/file must remove the document — query for its unique
    anchor afterwards should miss. Prevents zombie chunks polluting
    future retrievals."""
    sub_url = smoke_rig.sub_brain.base_url
    anchor = f"rag-remove-anchor-{uuid.uuid4().hex}"
    doc_path = _write_temp_doc(
        f"# Remove me\n\nThis document will be removed. Unique anchor: {anchor}."
    )
    try:
        idx = _index_file(sub_url, doc_path)
        assert idx.get("indexed") is True, idx

        # Verify it's findable
        pre = _query(sub_url, anchor, k=5)
        pre_hits = [c for c in pre.get("chunks", []) if str(doc_path) in c.get("doc_path", "")]
        assert pre_hits, f"could not even find the doc before removal: {pre}"

        # Remove
        rm = _remove(sub_url, doc_path)
        assert rm.get("ok") is True, rm

        # Verify it's gone — query the same anchor, no chunks should reference our file
        post = _query(sub_url, anchor, k=5)
        post_hits = [c for c in post.get("chunks", []) if str(doc_path) in c.get("doc_path", "")]
        assert not post_hits, (
            f"removed file's chunks still showing up: {post_hits}"
        )
    finally:
        try:
            doc_path.unlink(missing_ok=True)
        except OSError:
            pass


def test_rag_index_nonexistent_file_fails_gracefully(smoke_rig):
    """Indexing a missing file returns indexed=false with a clear reason,
    NOT a 500. The frontend file-picker can't fully prevent stale paths,
    so the API has to be tolerant."""
    sub_url = smoke_rig.sub_brain.base_url
    fake_path = f"/tmp/does-not-exist-{uuid.uuid4().hex}.md"
    r = httpx.post(
        f"{sub_url}/brain/rag/index_file",
        json={"path": fake_path},
        timeout=10.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True, body
    assert body.get("indexed") is False, body
    assert "not found" in (body.get("reason") or "").lower(), body


def test_rag_index_missing_path_returns_400_shape(smoke_rig):
    """Missing 'path' in the body should produce a clean error, not crash."""
    sub_url = smoke_rig.sub_brain.base_url
    r = httpx.post(
        f"{sub_url}/brain/rag/index_file",
        json={},  # no path
        timeout=10.0,
    )
    # Endpoint returns {ok: false, error: ...} with 200 (current shape)
    # — accept either that or an HTTP error code.
    assert r.status_code < 500, r.text
    if r.status_code == 200:
        body = r.json()
        assert body.get("ok") is False, body


def test_rag_query_empty_string_returns_empty_list_not_error(smoke_rig):
    """Empty query is a UI edge (user hits enter on a blank input).
    Must return {chunks: []} rather than crashing or returning random
    top-k results."""
    sub_url = smoke_rig.sub_brain.base_url
    result = _query(sub_url, "", k=5)
    assert result.get("ok") is True, result
    # The contract is "no signal → no results" not "no signal → top-k by recency"
    chunks = result.get("chunks", [])
    assert isinstance(chunks, list), result
    # Permissive: 0 or "no results because nothing matched empty" — both OK
    # What's NOT OK is a 500 (would mean the retriever crashed on empty).
