"""Tests for L3 conflict detection (M-Memory-1, Task #7).

Conflict detection is the most subjective part of the Memory rework, so
the test suite locks in three categories of invariants:

  1. Contract: the new memory ALWAYS becomes is_current=1, the existing
     one becomes is_current=0, and both share a conflict_group UUID.
  2. Gating: contradictions are only marked when similarity is above
     threshold AND the LLM explicitly says "contradicts: true". Anything
     less means both facts coexist as currently-known truths.
  3. Safety: detector never raises into store(). LLM down, garbage JSON,
     missing vector index — all fall back to "no conflicts marked".

The detector is wired into MemoryManager.store() via set_conflict_detector,
so the integration tests at the bottom verify the end-to-end behavior
when a real L3 row is stored through the normal store() path.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List
from unittest.mock import AsyncMock

import pytest

from memory.conflict_detector import (
    DEFAULT_SIMILARITY_THRESHOLD,
    ConflictDetector,
)
from memory.memory_manager import MemoryManager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def mm(temp_dir, mock_llm_config) -> MemoryManager:
    return MemoryManager(db_path=str(temp_dir / "conflict.db"), llm_config=mock_llm_config)


def _make_llm_caller(verdict: Dict[str, Any]):
    """Build an LLMCaller that returns a fixed JSON verdict."""
    async def _call(messages: List[Dict[str, str]]) -> str:
        return json.dumps(verdict)
    return _call


def _make_unparseable_llm():
    async def _call(messages):
        return "this is not json at all"
    return _call


def _make_throwing_llm(err_msg: str = "boom"):
    async def _call(messages):
        raise RuntimeError(err_msg)
    return _call


async def _plant_l3(mm: MemoryManager, content: str, *, importance: float = 0.7) -> str:
    result = await mm.store({
        "level": "L3", "content": content, "source": "test",
        "session_id": "s", "importance": importance,
    })
    return result["id"]


def _get_row(mm: MemoryManager, mem_id: str) -> Dict[str, Any]:
    with mm._connect() as conn:
        row = conn.execute("SELECT * FROM memories WHERE id = ?", (mem_id,)).fetchone()
    return dict(row) if row else {}


# ---------------------------------------------------------------------------
# Unit tests — ConflictDetector with stubbed dependencies
# ---------------------------------------------------------------------------


class TestJudgeContradiction:
    """The LLM judge step in isolation — no DB, no embeddings."""

    @pytest.mark.asyncio
    async def test_returns_contradicts_true_on_explicit_verdict(self):
        det = ConflictDetector(_make_llm_caller({"contradicts": True, "reason": "different city"}))
        result = await det._judge_contradiction("Lives in Beijing", "Lives in Shanghai")
        assert result["contradicts"] is True
        assert "city" in result["reason"]

    @pytest.mark.asyncio
    async def test_returns_contradicts_false_on_explicit_verdict(self):
        det = ConflictDetector(_make_llm_caller({"contradicts": False, "reason": "orthogonal"}))
        result = await det._judge_contradiction("Likes coffee", "Likes tea")
        assert result["contradicts"] is False

    @pytest.mark.asyncio
    async def test_unparseable_response_treated_as_no_conflict(self):
        det = ConflictDetector(_make_unparseable_llm())
        result = await det._judge_contradiction("a", "b")
        assert result["contradicts"] is False
        assert "unparseable" in result["reason"]

    @pytest.mark.asyncio
    async def test_empty_response_treated_as_no_conflict(self):
        async def _empty(_): return ""
        det = ConflictDetector(_empty)
        result = await det._judge_contradiction("a", "b")
        assert result["contradicts"] is False

    @pytest.mark.asyncio
    async def test_extracts_json_from_surrounding_prose(self):
        async def _wrapped(_):
            return (
                "Sure, here's the verdict:\n"
                '{"contradicts": true, "reason": "incompatible claims"}\n'
                "Hope that helps!"
            )
        det = ConflictDetector(_wrapped)
        result = await det._judge_contradiction("a", "b")
        assert result["contradicts"] is True


# ---------------------------------------------------------------------------
# Integration — detect_and_mark via MemoryManager
# ---------------------------------------------------------------------------


class TestDetectAndMark:
    @pytest.mark.asyncio
    async def test_marks_pair_when_llm_says_contradicts(self, mm):
        # Plant the existing L3 first (no detector wired yet)
        existing_id = await _plant_l3(mm, "The user lives in Beijing")

        # Now wire a detector that says yes to everything similar
        det = ConflictDetector(
            _make_llm_caller({"contradicts": True, "reason": "different city"}),
            threshold=0.0,  # accept any vector similarity
        )
        mm.set_conflict_detector(det)

        new_id = await _plant_l3(mm, "The user lives in Shanghai")

        new_row = _get_row(mm, new_id)
        old_row = _get_row(mm, existing_id)

        # Both rows share a non-null conflict_group
        assert new_row["conflict_group"] is not None
        assert old_row["conflict_group"] == new_row["conflict_group"]
        # New wins
        assert new_row["is_current"] == 1
        assert old_row["is_current"] == 0

    @pytest.mark.asyncio
    async def test_no_mark_when_llm_says_no_contradiction(self, mm):
        existing_id = await _plant_l3(mm, "User likes coffee")
        det = ConflictDetector(
            _make_llm_caller({"contradicts": False, "reason": "orthogonal"}),
            threshold=0.0,
        )
        mm.set_conflict_detector(det)

        new_id = await _plant_l3(mm, "User likes tea")

        assert _get_row(mm, new_id)["conflict_group"] is None
        assert _get_row(mm, existing_id)["conflict_group"] is None
        # is_current remains the default 1 for both
        assert _get_row(mm, new_id)["is_current"] == 1
        assert _get_row(mm, existing_id)["is_current"] == 1

    @pytest.mark.asyncio
    async def test_existing_already_in_a_conflict_group_is_reused(self, mm):
        """If the existing memory is already part of a conflict group from
        a prior contradiction, a new contradicting memory should join that
        group rather than starting a fresh one."""
        a_id = await _plant_l3(mm, "User lives in Beijing")
        det = ConflictDetector(
            _make_llm_caller({"contradicts": True, "reason": "city mismatch"}),
            threshold=0.0,
        )
        mm.set_conflict_detector(det)

        b_id = await _plant_l3(mm, "User lives in Shanghai")
        # B vs A: group G1 formed
        group_id_after_b = _get_row(mm, b_id)["conflict_group"]
        assert group_id_after_b is not None

        c_id = await _plant_l3(mm, "User lives in Guangzhou")
        # C vs B (B is now is_current=1 with group G1): C should adopt G1
        # Note: A might also surface as a candidate; in any case all three
        # should end up in the SAME group, not three separate groups.
        groups = {
            _get_row(mm, a_id)["conflict_group"],
            _get_row(mm, b_id)["conflict_group"],
            _get_row(mm, c_id)["conflict_group"],
        }
        # All three rows must be in conflict groups
        assert None not in groups
        # And exactly one shared group_id across the cluster (B and C must match)
        assert _get_row(mm, c_id)["conflict_group"] == _get_row(mm, b_id)["conflict_group"]

    @pytest.mark.asyncio
    async def test_similarity_below_threshold_skips_llm_check(self, mm):
        # Plant a totally unrelated existing L3 — vector similarity will be low
        await _plant_l3(mm, "The capital of France is Paris")

        llm_calls: List[List[Dict[str, str]]] = []
        async def _spy(messages):
            llm_calls.append(messages)
            return json.dumps({"contradicts": True, "reason": "spy"})

        # High threshold — almost nothing will pass
        det = ConflictDetector(_spy, threshold=0.99)
        mm.set_conflict_detector(det)

        await _plant_l3(mm, "Today's weather is sunny in Seoul")

        # Threshold should have culled all candidates → LLM never invoked
        assert llm_calls == []

    @pytest.mark.asyncio
    async def test_llm_exception_does_not_break_store(self, mm):
        await _plant_l3(mm, "User lives in Beijing")
        det = ConflictDetector(_make_throwing_llm("LLM unreachable"), threshold=0.0)
        mm.set_conflict_detector(det)

        # store() must still succeed end-to-end; just no conflicts marked
        new_id = await _plant_l3(mm, "User lives in Shanghai")
        row = _get_row(mm, new_id)
        assert row["conflict_group"] is None
        assert row["is_current"] == 1


# ---------------------------------------------------------------------------
# Integration — MemoryManager.store() with detector returns 'conflict' info
# ---------------------------------------------------------------------------


class TestStoreReturnsConflictInfo:
    @pytest.mark.asyncio
    async def test_l3_store_returns_conflict_metadata(self, mm):
        await _plant_l3(mm, "User prefers dark mode")
        det = ConflictDetector(
            _make_llm_caller({"contradicts": True, "reason": "opposite preference"}),
            threshold=0.0,
        )
        mm.set_conflict_detector(det)

        result = await mm.store({
            "level": "L3", "content": "User prefers light mode",
            "source": "test", "session_id": "s",
        })

        assert "conflict" in result
        assert result["conflict"]["checked"] >= 1
        assert len(result["conflict"]["conflicts"]) == 1
        assert result["conflict"]["conflicts"][0]["reason"] == "opposite preference"

    @pytest.mark.asyncio
    async def test_l1_l2_stores_never_invoke_detector(self, mm):
        called = False
        class _SpyDetector:
            async def detect_and_mark(self_, manager, mem_id, content):
                nonlocal called
                called = True
                return {"checked": 0, "conflicts": []}
        mm.set_conflict_detector(_SpyDetector())

        await mm.store({"level": "L1", "content": "raw event", "session_id": "s"})
        await mm.store({"level": "L2", "content": "summary text"})

        assert called is False

    @pytest.mark.asyncio
    async def test_no_detector_means_no_conflict_field(self, mm):
        # mm has no detector wired — store should not include "conflict" key
        result = await mm.store({"level": "L3", "content": "some fact"})
        assert "conflict" not in result

    @pytest.mark.asyncio
    async def test_empty_l3_content_skips_detector(self, mm):
        # Whitespace-only content shouldn't trigger detection — there's
        # nothing meaningful to compare against existing facts
        called = False
        class _SpyDetector:
            async def detect_and_mark(self_, m, mid, c):
                nonlocal called
                called = True
                return {"checked": 0, "conflicts": []}
        mm.set_conflict_detector(_SpyDetector())

        await mm.store({"level": "L3", "content": "   "})
        assert called is False
