"""Tests for the rewritten Dreaming Engine L1→L2 consolidation (M-Memory-1).

The original implementation re-summarized every recent L1 every 6 hours,
creating duplicate L2 rows. This suite locks in the new invariants:

  1. Idempotency: a second consolidate_l1_to_l2() over the same data is a no-op
  2. Active-window respect: a session whose latest L1 is < QUIET_MINUTES old
     is skipped — actively-running conversations don't get frozen mid-flight
  3. Provenance: each new L2 row carries provenance_source + refs back to
     contributing L1 rows; each L1 carries superseded_by pointing at the L2
  4. Empty / short / no-LLM paths leave the L1 rows untouched so a future
     run can retry
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from unittest.mock import AsyncMock

import pytest

from memory.dreaming_engine import DreamingEngine
from memory.memory_manager import MemoryManager


# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------


def _insert_l1(
    mm: MemoryManager,
    *,
    session_id: str,
    content: str,
    created_at: datetime,
    superseded_by: str | None = None,
) -> str:
    """Insert an L1 row at a specific timestamp, bypassing store()'s `now()`.

    The whole quiet-window mechanism hinges on created_at timestamps, so
    tests need to plant rows in the past — that's not what store() is for.
    """
    import uuid
    mem_id = str(uuid.uuid4())
    ts = created_at.isoformat()
    with mm._connect() as conn:
        conn.execute(
            """INSERT INTO memories
               (id, level, content, source, session_id, created_at,
                importance, last_accessed_at, superseded_by, provenance_source, provenance_refs)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (mem_id, "L1", content, "test", session_id, ts,
             0.4, ts, superseded_by, "", "[]"),
        )
        conn.commit()
    return mem_id


def _count_l2(mm: MemoryManager, session_id: str | None = None) -> int:
    with mm._connect() as conn:
        if session_id:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM memories WHERE level = 'L2' AND session_id = ?",
                (session_id,),
            ).fetchone()
        else:
            row = conn.execute("SELECT COUNT(*) AS c FROM memories WHERE level = 'L2'").fetchone()
        return row["c"]


def _get_l1_supersedes(mm: MemoryManager, ids: List[str]) -> Dict[str, str | None]:
    with mm._connect() as conn:
        placeholders = ",".join(["?"] * len(ids))
        rows = conn.execute(
            f"SELECT id, superseded_by FROM memories WHERE id IN ({placeholders})",
            tuple(ids),
        ).fetchall()
    return {r["id"]: r["superseded_by"] for r in rows}


def _make_engine(mm: MemoryManager, mock_llm_config: Dict[str, Any]) -> DreamingEngine:
    """DreamingEngine with a stubbed _llm_call that returns a canned summary."""
    eng = DreamingEngine(mm, llm_config=mock_llm_config)
    eng._llm_call = AsyncMock(return_value="Mock summary of conversation key points.")
    return eng


@pytest.fixture
def mm(temp_dir, mock_llm_config) -> MemoryManager:
    return MemoryManager(db_path=str(temp_dir / "test_dream.db"), llm_config=mock_llm_config)


@pytest.fixture
def engine(mm, mock_llm_config) -> DreamingEngine:
    return _make_engine(mm, mock_llm_config)


# ---------------------------------------------------------------------------
# Invariant 1 — Idempotency
# ---------------------------------------------------------------------------


class TestIdempotency:
    @pytest.mark.asyncio
    async def test_second_run_creates_no_duplicate_l2(self, mm, engine):
        # Plant a fully-quiet session with enough L1 rows
        old_ts = datetime.now(timezone.utc) - timedelta(hours=2)
        l1_ids = [
            _insert_l1(mm, session_id="s-quiet", content=f"msg {i}",
                       created_at=old_ts + timedelta(seconds=i))
            for i in range(5)
        ]

        first = await engine.consolidate_l1_to_l2()
        assert first["consolidated"] == 1
        assert _count_l2(mm, "s-quiet") == 1
        # LLM was called exactly once
        assert engine._llm_call.await_count == 1

        # Run again — should detect L1s already superseded and skip
        second = await engine.consolidate_l1_to_l2()
        assert second["consolidated"] == 0
        assert _count_l2(mm, "s-quiet") == 1, "must not create duplicate L2"
        # No additional LLM calls
        assert engine._llm_call.await_count == 1

    @pytest.mark.asyncio
    async def test_new_l1_after_consolidation_is_independently_consolidatable(self, mm, engine):
        """If a user sends more messages later, a *new* L2 is created from
        only the new (still-unsuperseded) L1s — not duplicating the prior one."""
        # First batch — old enough to be quiet
        old_ts = datetime.now(timezone.utc) - timedelta(hours=3)
        for i in range(4):
            _insert_l1(mm, session_id="s-1", content=f"batch1 {i}",
                       created_at=old_ts + timedelta(seconds=i))
        await engine.consolidate_l1_to_l2()
        assert _count_l2(mm, "s-1") == 1
        first_call_count = engine._llm_call.await_count

        # Second batch — new messages in the same session, also quiet
        mid_ts = datetime.now(timezone.utc) - timedelta(hours=1)
        new_l1_ids = [
            _insert_l1(mm, session_id="s-1", content=f"batch2 {i}",
                       created_at=mid_ts + timedelta(seconds=i))
            for i in range(3)
        ]
        await engine.consolidate_l1_to_l2()
        # Now exactly TWO L2 rows for this session — one per batch
        assert _count_l2(mm, "s-1") == 2
        assert engine._llm_call.await_count == first_call_count + 1
        # New L1s are now superseded by the second L2
        for mid in new_l1_ids:
            assert _get_l1_supersedes(mm, [mid])[mid] is not None


# ---------------------------------------------------------------------------
# Invariant 2 — Active-window respect
# ---------------------------------------------------------------------------


class TestQuietWindow:
    @pytest.mark.asyncio
    async def test_active_session_skipped(self, mm, engine):
        # All L1 rows are recent — last one is "now", well inside QUIET_MINUTES
        fresh_ts = datetime.now(timezone.utc) - timedelta(seconds=10)
        for i in range(5):
            _insert_l1(mm, session_id="s-active", content=f"m {i}",
                       created_at=fresh_ts + timedelta(seconds=i))

        result = await engine.consolidate_l1_to_l2()
        assert result["consolidated"] == 0
        assert result["sessions_skipped_active"] == 1
        assert _count_l2(mm, "s-active") == 0
        engine._llm_call.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_quiet_threshold_is_per_session(self, mm, engine):
        """One active session must not block consolidation of another quiet one."""
        # Quiet session
        old = datetime.now(timezone.utc) - timedelta(hours=4)
        for i in range(4):
            _insert_l1(mm, session_id="s-quiet", content=f"q{i}",
                       created_at=old + timedelta(seconds=i))
        # Active session
        fresh = datetime.now(timezone.utc) - timedelta(seconds=15)
        for i in range(4):
            _insert_l1(mm, session_id="s-active", content=f"a{i}",
                       created_at=fresh + timedelta(seconds=i))

        result = await engine.consolidate_l1_to_l2()
        assert result["consolidated"] == 1
        assert result["sessions_skipped_active"] == 1
        assert _count_l2(mm, "s-quiet") == 1
        assert _count_l2(mm, "s-active") == 0

    @pytest.mark.asyncio
    async def test_custom_quiet_minutes_parameter(self, mm, engine):
        # With quiet_minutes=1, a session whose latest L1 is 2 minutes old qualifies
        ts = datetime.now(timezone.utc) - timedelta(minutes=2)
        for i in range(3):
            _insert_l1(mm, session_id="s-x", content=f"m{i}",
                       created_at=ts + timedelta(seconds=i))

        result = await engine.consolidate_l1_to_l2(quiet_minutes=1)
        assert result["consolidated"] == 1


# ---------------------------------------------------------------------------
# Invariant 3 — Provenance + supersession
# ---------------------------------------------------------------------------


class TestProvenance:
    @pytest.mark.asyncio
    async def test_l2_carries_provenance_back_to_source_l1(self, mm, engine):
        old = datetime.now(timezone.utc) - timedelta(hours=2)
        l1_ids = [
            _insert_l1(mm, session_id="s-prov", content=f"msg {i}",
                       created_at=old + timedelta(seconds=i))
            for i in range(4)
        ]

        await engine.consolidate_l1_to_l2()

        with mm._connect() as conn:
            l2_row = conn.execute(
                "SELECT * FROM memories WHERE level = 'L2' AND session_id = 's-prov'"
            ).fetchone()

        assert l2_row is not None
        assert l2_row["provenance_source"] == "consolidation_l1_l2"
        refs = json.loads(l2_row["provenance_refs"])
        assert sorted(refs) == sorted(l1_ids)

    @pytest.mark.asyncio
    async def test_l1_marked_superseded_by_new_l2(self, mm, engine):
        old = datetime.now(timezone.utc) - timedelta(hours=2)
        l1_ids = [
            _insert_l1(mm, session_id="s-sup", content=f"m{i}",
                       created_at=old + timedelta(seconds=i))
            for i in range(4)
        ]

        await engine.consolidate_l1_to_l2()

        with mm._connect() as conn:
            l2_row = conn.execute(
                "SELECT id FROM memories WHERE level = 'L2' AND session_id = 's-sup'"
            ).fetchone()
        l2_id = l2_row["id"]

        supersedes = _get_l1_supersedes(mm, l1_ids)
        for l1_id in l1_ids:
            assert supersedes[l1_id] == l2_id, f"L1 {l1_id} not pointing at {l2_id}"

    @pytest.mark.asyncio
    async def test_superseded_l1_still_readable(self, mm, engine):
        """Supersession is a marker, not a delete — original content survives."""
        old = datetime.now(timezone.utc) - timedelta(hours=2)
        l1_id = _insert_l1(mm, session_id="s-keep", content="original content",
                           created_at=old)
        for i in range(3):
            _insert_l1(mm, session_id="s-keep", content=f"m{i}",
                       created_at=old + timedelta(seconds=i + 1))

        await engine.consolidate_l1_to_l2()

        with mm._connect() as conn:
            row = conn.execute(
                "SELECT content, superseded_by FROM memories WHERE id = ?",
                (l1_id,),
            ).fetchone()
        assert row["content"] == "original content"
        assert row["superseded_by"] is not None


# ---------------------------------------------------------------------------
# Invariant 4 — Failure paths leave L1 unsuperseded
# ---------------------------------------------------------------------------


class TestFailurePaths:
    @pytest.mark.asyncio
    async def test_short_session_skipped_not_marked(self, mm, engine):
        # Only 2 messages — below MIN_L1_PER_SESSION
        old = datetime.now(timezone.utc) - timedelta(hours=2)
        l1_ids = [
            _insert_l1(mm, session_id="s-short", content=f"m{i}",
                       created_at=old + timedelta(seconds=i))
            for i in range(2)
        ]

        result = await engine.consolidate_l1_to_l2()
        assert result["consolidated"] == 0
        assert result["sessions_skipped_short"] == 1
        supersedes = _get_l1_supersedes(mm, l1_ids)
        for v in supersedes.values():
            assert v is None  # untouched — eligible if future messages arrive

    @pytest.mark.asyncio
    async def test_empty_llm_response_leaves_l1_unsuperseded(self, mm, mock_llm_config):
        """If the LLM is unreachable / returns nothing, we want the L1 rows
        to remain consolidation-eligible on the next run. The original
        implementation would have silently created a junk L2 with no body."""
        eng = DreamingEngine(mm, llm_config=mock_llm_config)
        eng._llm_call = AsyncMock(return_value="")  # empty

        old = datetime.now(timezone.utc) - timedelta(hours=2)
        l1_ids = [
            _insert_l1(mm, session_id="s-llm-down", content=f"m{i}",
                       created_at=old + timedelta(seconds=i))
            for i in range(4)
        ]

        result = await eng.consolidate_l1_to_l2()
        assert result["consolidated"] == 0
        assert _count_l2(mm, "s-llm-down") == 0
        for v in _get_l1_supersedes(mm, l1_ids).values():
            assert v is None, "L1 must stay eligible for retry"

    @pytest.mark.asyncio
    async def test_empty_database_returns_clean_zero(self, mm, engine):
        result = await engine.consolidate_l1_to_l2()
        assert result["consolidated"] == 0
        assert result["sessions_evaluated"] == 0
        engine._llm_call.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_orphan_l1_without_session_id_skipped(self, mm, engine):
        # No session_id → no conversation thread, nothing to summarize
        old = datetime.now(timezone.utc) - timedelta(hours=2)
        for i in range(5):
            _insert_l1(mm, session_id="", content=f"orphan {i}",
                       created_at=old + timedelta(seconds=i))

        result = await engine.consolidate_l1_to_l2()
        assert result["consolidated"] == 0
        engine._llm_call.assert_not_awaited()


# ---------------------------------------------------------------------------
# Cap behavior — very long sessions
# ---------------------------------------------------------------------------


class TestL2ToL3FactExtraction:
    """Locks in the L2→L3 distillation contract.

    The original implementation called extract_semantic() which wrote to
    entities/facts tables — NEVER to L3 memory rows. Anyone querying
    `levels=["L3"]` got nothing. The rewrite:
      - actually writes L3 rows
      - never re-processes an L2 that has already produced any L3
      - falls back cleanly on bad JSON / empty responses
    """

    async def _plant_l2(self, mm: MemoryManager, content: str, session_id: str = "s") -> str:
        result = await mm.store({
            "level": "L2", "content": content, "session_id": session_id,
            "source": "test", "provenance_source": "consolidation_l1_l2",
            "provenance_refs": [],
        })
        return result["id"]

    def _stub_llm(self, eng: DreamingEngine, facts: List[Dict[str, str]]) -> None:
        payload = json.dumps({"facts": facts})
        eng._llm_call = AsyncMock(return_value=payload)

    @pytest.mark.asyncio
    async def test_creates_l3_rows_with_provenance_back_to_l2(self, mm, mock_llm_config):
        eng = _make_engine(mm, mock_llm_config)
        self._stub_llm(eng, [
            {"kind": "preference", "statement": "User prefers dark mode."},
            {"kind": "fact", "statement": "User lives in Beijing."},
        ])
        l2_id = await self._plant_l2(mm, "User said they like dark mode and live in Beijing.")

        result = await eng.consolidate_l2_to_l3()
        assert result["facts_created"] == 2

        with mm._connect() as conn:
            rows = conn.execute(
                "SELECT content, provenance_source, provenance_refs FROM memories WHERE level = 'L3'"
            ).fetchall()
        assert len(rows) == 2
        for r in rows:
            assert r["provenance_source"] == "fact_extraction_l2_l3"
            assert json.loads(r["provenance_refs"]) == [l2_id]
        # Kind is encoded in the content prefix for downstream search
        contents = sorted(r["content"] for r in rows)
        assert any(c.startswith("[preference]") for c in contents)
        assert any(c.startswith("[fact]") for c in contents)

    @pytest.mark.asyncio
    async def test_idempotent_skips_already_processed_l2(self, mm, mock_llm_config):
        eng = _make_engine(mm, mock_llm_config)
        self._stub_llm(eng, [{"kind": "fact", "statement": "X"}])
        await self._plant_l2(mm, "first L2 summary")

        first = await eng.consolidate_l2_to_l3()
        assert first["facts_created"] == 1
        assert first["l2_processed"] == 1

        # Run again — same L2 is already processed, LLM should not be called again
        eng._llm_call.reset_mock()
        second = await eng.consolidate_l2_to_l3()
        assert second["facts_created"] == 0
        assert second["l2_processed"] == 0
        eng._llm_call.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_l2_NOT_marked_superseded(self, mm, mock_llm_config):
        """L2 is the narrative, L3 is the distillate — both must survive."""
        eng = _make_engine(mm, mock_llm_config)
        self._stub_llm(eng, [{"kind": "fact", "statement": "x"}])
        l2_id = await self._plant_l2(mm, "summary text")
        await eng.consolidate_l2_to_l3()

        with mm._connect() as conn:
            row = conn.execute(
                "SELECT superseded_by FROM memories WHERE id = ?", (l2_id,)
            ).fetchone()
        assert row["superseded_by"] is None

    @pytest.mark.asyncio
    async def test_empty_facts_list_leaves_l2_unprocessed_for_retry(self, mm, mock_llm_config):
        """If the LLM says "nothing durable", we want to leave the L2 alone
        so a future run with a smarter model can try again."""
        eng = _make_engine(mm, mock_llm_config)
        self._stub_llm(eng, [])  # explicit empty list
        l2_id = await self._plant_l2(mm, "ambiguous summary")

        result = await eng.consolidate_l2_to_l3()
        assert result["facts_created"] == 0
        assert result["facts_skipped_empty"] == 1

        # Critically: no L3 row references this L2, so a re-run will retry
        with mm._connect() as conn:
            l3_count = conn.execute("SELECT COUNT(*) AS c FROM memories WHERE level = 'L3'").fetchone()["c"]
        assert l3_count == 0
        # And the next run will revisit it (the predicate is "no L3 refs this L2")
        eng._llm_call.reset_mock()
        await eng.consolidate_l2_to_l3()
        eng._llm_call.assert_awaited()  # retried

    @pytest.mark.asyncio
    async def test_invalid_json_response_does_not_crash(self, mm, mock_llm_config):
        eng = _make_engine(mm, mock_llm_config)
        eng._llm_call = AsyncMock(return_value="this is not valid json at all")
        await self._plant_l2(mm, "x")

        result = await eng.consolidate_l2_to_l3()
        assert result["facts_created"] == 0
        # No L3 written → next run will retry, same as empty case

    @pytest.mark.asyncio
    async def test_unknown_kind_normalized_to_fact(self, mm, mock_llm_config):
        eng = _make_engine(mm, mock_llm_config)
        self._stub_llm(eng, [
            {"kind": "random_made_up_kind", "statement": "something durable"},
        ])
        await self._plant_l2(mm, "x")
        await eng.consolidate_l2_to_l3()

        with mm._connect() as conn:
            row = conn.execute("SELECT content FROM memories WHERE level = 'L3'").fetchone()
        assert row["content"].startswith("[fact]")  # normalized

    @pytest.mark.asyncio
    async def test_facts_with_empty_statements_dropped(self, mm, mock_llm_config):
        eng = _make_engine(mm, mock_llm_config)
        self._stub_llm(eng, [
            {"kind": "fact", "statement": "real one"},
            {"kind": "fact", "statement": ""},
            {"kind": "fact", "statement": "   "},
        ])
        await self._plant_l2(mm, "x")
        result = await eng.consolidate_l2_to_l3()
        assert result["facts_created"] == 1

    @pytest.mark.asyncio
    async def test_fenced_json_in_response_still_parses(self, mm, mock_llm_config):
        eng = _make_engine(mm, mock_llm_config)
        # Model wrapped output in ```json despite instructions
        eng._llm_call = AsyncMock(return_value=(
            "```json\n"
            + json.dumps({"facts": [{"kind": "fact", "statement": "Y"}]})
            + "\n```"
        ))
        await self._plant_l2(mm, "x")
        result = await eng.consolidate_l2_to_l3()
        assert result["facts_created"] == 1


class TestLongSessions:
    @pytest.mark.asyncio
    async def test_session_over_cap_uses_head_and_tail(self, mm, engine, monkeypatch):
        # Plant 100 L1 rows; engine should select head + tail, not OOM
        monkeypatch.setattr(engine, "MAX_L1_PER_SESSION", 20)
        old = datetime.now(timezone.utc) - timedelta(hours=2)
        l1_ids = [
            _insert_l1(mm, session_id="s-long", content=f"message number {i}",
                       created_at=old + timedelta(seconds=i))
            for i in range(100)
        ]

        await engine.consolidate_l1_to_l2()
        # All 100 L1 rows should still be marked superseded — head+tail
        # selection drives the SUMMARY input only, not the lineage
        supersedes = _get_l1_supersedes(mm, l1_ids)
        superseded = [v for v in supersedes.values() if v is not None]
        # The current implementation only marks the *selected* head+tail
        # window as superseded. That's intentional: rows we didn't summarize
        # should not be marked done. Lock that in here so a future refactor
        # has to think about it.
        assert len(superseded) == 20
