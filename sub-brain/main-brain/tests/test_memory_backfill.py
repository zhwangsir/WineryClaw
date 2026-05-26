"""Tests for the embedding backfill that fixes user-trial #5.

Pre-M-Memory-1 installs have L1 rows with no matching vectors row. The
backfill is supposed to find those and embed them. These tests pin the
behaviour so a regression is caught immediately.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict

import pytest

from memory.memory_manager import MemoryManager, backfill_missing_embeddings


@pytest.fixture
def mm(temp_dir, mock_llm_config) -> MemoryManager:
    return MemoryManager(db_path=str(temp_dir / "backfill.db"), llm_config=mock_llm_config)


def _plant_legacy_row(
    mm: MemoryManager,
    *,
    level: str = "L1",
    content: str = "legacy memory row",
    archived: int = 0,
) -> str:
    """Plant a memory row WITHOUT going through store() so no vector row is created.

    This simulates the pre-M-Memory-1 state: schema columns exist but
    no embedding was generated when the row was inserted.
    """
    mem_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with mm._connect() as conn:
        conn.execute(
            """INSERT INTO memories
               (id, level, content, source, session_id, created_at,
                importance, last_accessed_at, archived)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (mem_id, level, content, "legacy", "s", now, 0.5, now, archived),
        )
        conn.commit()
    return mem_id


def _count_vectors_for(mm: MemoryManager, mem_id: str) -> int:
    with mm._connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM vectors WHERE memory_id = ?", (mem_id,),
        ).fetchone()
    return row["c"]


class TestBackfillBasicBehavior:
    @pytest.mark.asyncio
    async def test_empty_db_returns_zero_counts(self, mm):
        result = await backfill_missing_embeddings(mm)
        assert result == {"scanned": 0, "embedded": 0, "skipped_empty": 0, "failed": 0}

    @pytest.mark.asyncio
    async def test_legacy_l1_row_gets_embedded(self, mm):
        mem_id = _plant_legacy_row(mm, level="L1", content="user said hello")
        assert _count_vectors_for(mm, mem_id) == 0

        result = await backfill_missing_embeddings(mm)
        assert result["scanned"] == 1
        assert result["embedded"] == 1
        assert _count_vectors_for(mm, mem_id) == 1

    @pytest.mark.asyncio
    async def test_legacy_l3_row_gets_embedded(self, mm):
        mem_id = _plant_legacy_row(mm, level="L3", content="user lives in Beijing")
        result = await backfill_missing_embeddings(mm)
        assert result["embedded"] == 1
        assert _count_vectors_for(mm, mem_id) == 1

    @pytest.mark.asyncio
    async def test_row_with_existing_vector_skipped(self, mm):
        # Plant a row via store() — it gets a vector automatically
        result = await mm.store({"content": "fresh row", "level": "L3"})
        mem_id = result["id"]
        assert _count_vectors_for(mm, mem_id) >= 1
        vec_count_before = _count_vectors_for(mm, mem_id)

        # Backfill should NOT add another vector for it
        bf = await backfill_missing_embeddings(mm)
        assert bf["scanned"] == 0
        assert _count_vectors_for(mm, mem_id) == vec_count_before


class TestBackfillFiltering:
    @pytest.mark.asyncio
    async def test_empty_content_skipped(self, mm):
        # Plant a legacy row with empty content — embedding "" is meaningless
        empty_id = _plant_legacy_row(mm, content="")
        whitespace_id = _plant_legacy_row(mm, content="   \n\t  ")
        real_id = _plant_legacy_row(mm, content="real content")

        result = await backfill_missing_embeddings(mm)
        assert result["scanned"] == 1
        assert result["embedded"] == 1
        assert _count_vectors_for(mm, empty_id) == 0
        assert _count_vectors_for(mm, whitespace_id) == 0
        assert _count_vectors_for(mm, real_id) == 1

    @pytest.mark.asyncio
    async def test_archived_rows_skipped(self, mm):
        live_id = _plant_legacy_row(mm, content="live row", archived=0)
        archived_id = _plant_legacy_row(mm, content="archived row", archived=1)

        result = await backfill_missing_embeddings(mm)
        assert result["scanned"] == 1
        assert _count_vectors_for(mm, live_id) == 1
        assert _count_vectors_for(mm, archived_id) == 0

    @pytest.mark.asyncio
    async def test_l1_excluded_when_embed_l1_env_disabled(self, mm, monkeypatch):
        monkeypatch.setenv("WEBRAIN_MEMORY_EMBED_L1", "0")
        l1_id = _plant_legacy_row(mm, level="L1", content="l1 content")
        l3_id = _plant_legacy_row(mm, level="L3", content="l3 content")

        result = await backfill_missing_embeddings(mm)
        # Only L3 should be backfilled when L1 embed is disabled
        assert result["scanned"] == 1
        assert _count_vectors_for(mm, l1_id) == 0
        assert _count_vectors_for(mm, l3_id) == 1


class TestBackfillBudget:
    @pytest.mark.asyncio
    async def test_max_per_run_caps_scan_size(self, mm):
        # Plant 7 legacy rows, cap at 3
        for i in range(7):
            _plant_legacy_row(mm, content=f"row {i} content here")
        result = await backfill_missing_embeddings(mm, max_per_run=3)
        assert result["scanned"] == 3
        assert result["embedded"] == 3

    @pytest.mark.asyncio
    async def test_multiple_calls_progress_through_backlog(self, mm):
        # 10 legacy rows; 2 runs of 5 each should clear all
        for i in range(10):
            _plant_legacy_row(mm, content=f"backlog row {i}")
        first = await backfill_missing_embeddings(mm, max_per_run=5)
        second = await backfill_missing_embeddings(mm, max_per_run=5)
        third = await backfill_missing_embeddings(mm, max_per_run=5)  # nothing left
        assert first["embedded"] == 5
        assert second["embedded"] == 5
        assert third["embedded"] == 0
        assert third["scanned"] == 0


class TestBackfillRobustness:
    @pytest.mark.asyncio
    async def test_failure_in_one_row_does_not_abort_run(self, mm, monkeypatch):
        # Two rows. Force _store_embedding to raise for the first call only.
        mem_a = _plant_legacy_row(mm, content="row A")
        mem_b = _plant_legacy_row(mm, content="row B")

        original = mm._store_embedding
        call_count = {"n": 0}

        async def flaky(memory_id, text):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("simulated embed failure")
            return await original(memory_id, text)

        monkeypatch.setattr(mm, "_store_embedding", flaky)
        result = await backfill_missing_embeddings(mm)

        # Whichever ordered first failed; the other succeeded.
        assert result["scanned"] == 2
        assert result["embedded"] == 1
        assert result["failed"] == 1

    @pytest.mark.asyncio
    async def test_returns_dict_shape_pinned(self, mm):
        # Locks in the API shape. If anything changes the return keys,
        # the frontend / /memory/embeddings/backfill endpoint breaks.
        result = await backfill_missing_embeddings(mm)
        assert set(result.keys()) == {"scanned", "embedded", "skipped_empty", "failed"}
        for k, v in result.items():
            assert isinstance(v, int), f"{k} should be int, got {type(v)}"
