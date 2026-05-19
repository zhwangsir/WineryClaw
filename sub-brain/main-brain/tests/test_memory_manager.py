"""Tests for MemoryManager."""

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from memory.memory_manager import (
    DEFAULT_IMPORTANCE_BY_LEVEL,
    HALF_LIFE_DAYS_BY_LEVEL,
    RETRIEVAL_BOOST,
    MemoryManager,
    effective_importance,
)


class TestMemoryManager:
    """Unit tests for MemoryManager."""

    @pytest.fixture
    def mm(self, temp_dir, mock_llm_config):
        db_path = temp_dir / "test_memory.db"
        return MemoryManager(db_path=str(db_path), llm_config=mock_llm_config)

    @pytest.mark.asyncio
    async def test_store_and_query(self, mm):
        result = await mm.store({
            "content": "Test memory content",
            "level": "L1",
            "session_id": "sess-1",
            "tags": ["test"],
        })
        assert "id" in result

        results = await mm.query({"query": "memory", "limit": 5})
        assert len(results) >= 1
        assert any("memory" in r["content"].lower() for r in results)

    @pytest.mark.asyncio
    async def test_store_auto_extracts_semantic(self, mm, monkeypatch):
        """Storing L1 should auto-extract entities."""
        mock_extract = AsyncMock(return_value={"entities": [{"name": "Alice", "type": "person"}], "facts": []})
        monkeypatch.setattr(mm, "extract_semantic", mock_extract)

        await mm.store({
            "content": "Alice went to the store",
            "level": "L2",
            "session_id": "sess-1",
        })
        mock_extract.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_stats(self, mm):
        stats = await mm.get_stats()
        assert "total" in stats
        assert "by_level" in stats

    @pytest.mark.asyncio
    async def test_get_session_memories(self, mm):
        await mm.store({"content": "A", "level": "L1", "session_id": "sess-abc"})
        await mm.store({"content": "B", "level": "L1", "session_id": "sess-abc"})
        await mm.store({"content": "C", "level": "L1", "session_id": "sess-other"})

        results = await mm.get_session_memories("sess-abc", limit=10)
        assert len(results) == 2
        contents = [r["content"] for r in results]
        assert "A" in contents
        assert "B" in contents

    @pytest.mark.asyncio
    async def test_get_recent(self, mm):
        await mm.store({"content": "Old", "level": "L1", "session_id": "s1"})
        await mm.store({"content": "New", "level": "L1", "session_id": "s2"})

        recent = await mm.get_recent(level="L1", limit=10)
        assert len(recent) >= 2


# ---------------------------------------------------------------------------
# M-Memory-1: effective_importance (pure function, no IO)
# ---------------------------------------------------------------------------


class TestEffectiveImportance:
    def test_no_decay_when_just_accessed(self):
        now = datetime(2026, 5, 20, tzinfo=timezone.utc)
        result = effective_importance(0.8, "L1", now.isoformat(), now=now)
        # Zero elapsed → exactly the input importance
        assert result == pytest.approx(0.8, abs=1e-9)

    def test_l1_half_decay_at_2_days(self):
        now = datetime(2026, 5, 20, tzinfo=timezone.utc)
        two_days_ago = (now - timedelta(days=2)).isoformat()
        result = effective_importance(0.8, "L1", two_days_ago, now=now)
        # exp(-1) ≈ 0.3679; so 0.8 * 0.3679 ≈ 0.294
        assert result == pytest.approx(0.8 * 0.36788, abs=0.001)

    def test_l3_decays_much_slower_than_l1_at_same_age(self):
        now = datetime(2026, 5, 20, tzinfo=timezone.utc)
        thirty_days_ago = (now - timedelta(days=30)).isoformat()
        l1 = effective_importance(0.8, "L1", thirty_days_ago, now=now)
        l3 = effective_importance(0.8, "L3", thirty_days_ago, now=now)
        assert l1 < 0.01  # essentially gone — half-life 2d, 30d elapsed
        assert l3 > 0.5  # half-life 90d, only 30d elapsed → still strong

    def test_l4_does_not_decay_in_any_realistic_window(self):
        now = datetime(2026, 5, 20, tzinfo=timezone.utc)
        a_year_ago = (now - timedelta(days=365)).isoformat()
        result = effective_importance(0.9, "L4", a_year_ago, now=now)
        # 365 / 1e9 → exp(-3.65e-7) ≈ 1
        assert result == pytest.approx(0.9, abs=1e-5)

    def test_missing_last_accessed_returns_raw_importance(self):
        # None / empty / unparseable all fall back to raw importance — never crash
        for bad in (None, "", "not-a-timestamp"):
            assert effective_importance(0.7, "L2", bad) == pytest.approx(0.7)

    def test_importance_clamped_to_unit_interval(self):
        now = datetime(2026, 5, 20, tzinfo=timezone.utc)
        # Out-of-range inputs should be clamped before decay math applies
        assert effective_importance(1.5, "L1", now.isoformat(), now=now) == 1.0
        assert effective_importance(-0.3, "L1", now.isoformat(), now=now) == 0.0

    def test_unknown_level_uses_reasonable_default(self):
        # Defensive: if a level string is unknown (e.g., "L99"), don't crash —
        # fall back to a moderate half-life so the function stays useful.
        now = datetime(2026, 5, 20, tzinfo=timezone.utc)
        seven_days_ago = (now - timedelta(days=7)).isoformat()
        result = effective_importance(0.5, "L99", seven_days_ago, now=now)
        assert 0.0 < result <= 0.5

    def test_negative_elapsed_returns_raw_importance(self):
        # Clock skew or test fixture in the future → don't amplify importance
        now = datetime(2026, 5, 20, tzinfo=timezone.utc)
        future = (now + timedelta(days=5)).isoformat()
        result = effective_importance(0.6, "L1", future, now=now)
        assert result == pytest.approx(0.6)


# ---------------------------------------------------------------------------
# M-Memory-1: store() persists new fields, defaults per-level
# ---------------------------------------------------------------------------


class TestStoreNewFields:
    @pytest.fixture
    def mm(self, temp_dir, mock_llm_config):
        return MemoryManager(db_path=str(temp_dir / "test_mem.db"), llm_config=mock_llm_config)

    def _row(self, mm, mem_id):
        with mm._connect() as conn:
            return dict(conn.execute("SELECT * FROM memories WHERE id = ?", (mem_id,)).fetchone())

    @pytest.mark.asyncio
    async def test_l1_default_importance(self, mm):
        result = await mm.store({"content": "raw event", "level": "L1"})
        row = self._row(mm, result["id"])
        assert row["importance"] == pytest.approx(DEFAULT_IMPORTANCE_BY_LEVEL["L1"])

    @pytest.mark.asyncio
    async def test_l2_default_importance_higher_than_l1(self, mm):
        r2 = await mm.store({"content": "summary", "level": "L2"})
        row2 = self._row(mm, r2["id"])
        assert row2["importance"] > DEFAULT_IMPORTANCE_BY_LEVEL["L1"]

    @pytest.mark.asyncio
    async def test_l4_default_importance_highest(self, mm):
        r = await mm.store({"content": "long-term identity", "level": "L4"})
        row = self._row(mm, r["id"])
        assert row["importance"] >= 0.9

    @pytest.mark.asyncio
    async def test_explicit_importance_overrides_default(self, mm):
        r = await mm.store({"content": "x", "level": "L1", "importance": 0.95})
        row = self._row(mm, r["id"])
        assert row["importance"] == pytest.approx(0.95)

    @pytest.mark.asyncio
    async def test_explicit_importance_clamped(self, mm):
        r_high = await mm.store({"content": "h", "level": "L1", "importance": 2.0})
        assert self._row(mm, r_high["id"])["importance"] == pytest.approx(1.0)
        r_low = await mm.store({"content": "l", "level": "L1", "importance": -1.0})
        assert self._row(mm, r_low["id"])["importance"] == pytest.approx(0.0)

    @pytest.mark.asyncio
    async def test_invalid_importance_falls_back_to_default(self, mm):
        # Non-numeric importance → use the level default rather than crash
        r = await mm.store({"content": "x", "level": "L2", "importance": "not-a-number"})
        row = self._row(mm, r["id"])
        assert row["importance"] == pytest.approx(DEFAULT_IMPORTANCE_BY_LEVEL["L2"])

    @pytest.mark.asyncio
    async def test_provenance_source_and_refs_persisted(self, mm):
        r = await mm.store({
            "content": "summarized session",
            "level": "L2",
            "provenance_source": "consolidation_l1_l2",
            "provenance_refs": ["l1-uuid-1", "l1-uuid-2", "l1-uuid-3"],
        })
        row = self._row(mm, r["id"])
        assert row["provenance_source"] == "consolidation_l1_l2"
        refs = json.loads(row["provenance_refs"])
        assert refs == ["l1-uuid-1", "l1-uuid-2", "l1-uuid-3"]

    @pytest.mark.asyncio
    async def test_provenance_refs_defaults_to_empty_list_json(self, mm):
        r = await mm.store({"content": "no refs", "level": "L1"})
        row = self._row(mm, r["id"])
        assert json.loads(row["provenance_refs"]) == []

    @pytest.mark.asyncio
    async def test_non_list_provenance_refs_coerced_to_empty(self, mm):
        # Caller passed garbage — don't crash, normalize to []
        r = await mm.store({
            "content": "x", "level": "L1",
            "provenance_refs": "not-a-list",
        })
        assert json.loads(self._row(mm, r["id"])["provenance_refs"]) == []

    @pytest.mark.asyncio
    async def test_last_accessed_at_initialized_to_created_at(self, mm):
        r = await mm.store({"content": "fresh", "level": "L1"})
        row = self._row(mm, r["id"])
        assert row["last_accessed_at"] == row["created_at"]

    @pytest.mark.asyncio
    async def test_is_current_defaults_true(self, mm):
        r = await mm.store({"content": "x", "level": "L1"})
        assert self._row(mm, r["id"])["is_current"] == 1

    @pytest.mark.asyncio
    async def test_chunked_store_propagates_provenance_to_each_chunk(self, mm):
        # Force chunking by exceeding chunk_text threshold
        long_content = "段落 " + ("这是一段较长的中文文本,用于触发分块逻辑。" * 80)
        r = await mm.store({
            "content": long_content,
            "level": "L2",
            "provenance_source": "test_chunked",
            "provenance_refs": ["src-1"],
        })
        assert r["chunks"] >= 1
        # Every chunk row carries the same provenance + importance
        with mm._connect() as conn:
            rows = conn.execute(
                "SELECT importance, provenance_source, provenance_refs FROM memories "
                "WHERE id = ? OR metadata LIKE ?",
                (r["id"], f'%"parent_id": "{r["id"]}"%'),
            ).fetchall()
        for row in rows:
            assert row["provenance_source"] == "test_chunked"
            assert json.loads(row["provenance_refs"]) == ["src-1"]


# ---------------------------------------------------------------------------
# M-Memory-1: retrieval reinforcement
# ---------------------------------------------------------------------------


class TestRetrievalReinforcement:
    @pytest.fixture
    def mm(self, temp_dir, mock_llm_config):
        return MemoryManager(db_path=str(temp_dir / "test_reinf.db"), llm_config=mock_llm_config)

    def _row(self, mm, mem_id):
        with mm._connect() as conn:
            return dict(conn.execute("SELECT * FROM memories WHERE id = ?", (mem_id,)).fetchone())

    def test_increment_access_bumps_count_timestamp_and_importance(self, mm):
        # Direct insert so we control the starting state
        now = datetime.now(timezone.utc).isoformat()
        with mm._connect() as conn:
            conn.execute(
                """INSERT INTO memories
                   (id, level, content, source, session_id, created_at,
                    importance, last_accessed_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                ("mem-a", "L1", "hi", "test", "s1", now, 0.5, now),
            )
            conn.commit()

        mm._increment_access(["mem-a"])
        row = self._row(mm, "mem-a")
        assert row["access_count"] == 1
        assert row["importance"] == pytest.approx(0.5 + RETRIEVAL_BOOST)
        # last_accessed_at should be >= the original timestamp
        assert row["last_accessed_at"] >= now

    def test_increment_access_caps_importance_at_one(self, mm):
        now = datetime.now(timezone.utc).isoformat()
        with mm._connect() as mm_conn:
            mm_conn.execute(
                """INSERT INTO memories
                   (id, level, content, source, session_id, created_at,
                    importance, last_accessed_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                ("mem-near-max", "L3", "x", "", "", now, 0.99, now),
            )
            mm_conn.commit()
        # One bump of 0.05 from 0.99 would be 1.04 → must clamp at 1.0
        mm._increment_access(["mem-near-max"])
        assert self._row(mm, "mem-near-max")["importance"] == pytest.approx(1.0)

    def test_increment_access_empty_list_noop(self, mm):
        # Should not raise on empty input
        mm._increment_access([])

    def test_increment_access_unknown_id_noop(self, mm):
        # No row → UPDATE matches nothing → silent
        mm._increment_access(["no-such-id"])

    @pytest.mark.asyncio
    async def test_query_triggers_reinforcement(self, mm):
        # End-to-end: store, query, observe importance bump
        r = await mm.store({"content": "reinforcement target text", "level": "L2"})
        initial = self._row(mm, r["id"])["importance"]
        # The query must actually retrieve this memory for the boost to fire
        results = await mm.query({"query": "reinforcement target", "levels": ["L2"], "limit": 5})
        assert any(item["id"] == r["id"] for item in results), "expected to retrieve the seed memory"
        bumped = self._row(mm, r["id"])["importance"]
        assert bumped > initial
