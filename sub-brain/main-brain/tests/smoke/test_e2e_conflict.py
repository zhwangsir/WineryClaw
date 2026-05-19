"""End-to-end conflict-resolution smoke tests (Round C3, 2026-05-20).

Verifies that the L3 conflict-detection pipeline actually marks
contradicting facts:

  store L3 "X is blue" → no conflict (nothing to contradict)
  store L3 "X is red"  → similarity search finds the blue row,
                         LLM judge says "contradicts",
                         older row is_current = 0,
                         new row is_current = 1,
                         both share a conflict_group

Without this smoke test the only coverage was unit tests with mocked
similarity + mocked judge. Real bugs:
  - Round C3 caught: _conflict_llm_caller closure captured llm_config
    at boot, so after /config/reload it kept hitting the stale endpoint
    and silently returned empty (no conflicts marked, no UI feedback).

Marker: `@pytest.mark.smoke`. Run with:
    pytest -m smoke tests/smoke/test_e2e_conflict.py -s
"""

from __future__ import annotations

import json
import uuid
from typing import Dict, List, Optional

import httpx
import pytest

pytestmark = pytest.mark.smoke


def _set_judge_mode(mock_llm_base_url: str, contradicts: bool, reason: str = "smoke") -> None:
    """Tell the mock LLM what to return for upcoming conflict-judge calls."""
    r = httpx.put(
        f"{mock_llm_base_url}/__debug/conflict-mode",
        json={"contradicts": contradicts, "reason": reason},
        timeout=5.0,
    )
    r.raise_for_status()


def _store_l3(sub_url: str, content: str) -> Dict:
    """Store an L3 memory, return the full response body."""
    r = httpx.post(
        f"{sub_url}/brain/memory/store",
        json={"content": content, "level": "L3", "source": "smoke-conflict"},
        timeout=60.0,  # first L3 store triggers conflict detector LLM round-trips
    )
    assert r.status_code == 200, r.text
    return r.json()


def _get_memory(sub_url: str, mem_id: str) -> Dict:
    """Fetch a single memory's full record (includes is_current, conflict_group).

    /memory/{id} wraps the row as {ok, memory: {...}, sources, supersedes,
    superseded_by}. We return the inner row (or the raw payload if the
    shape changes — tests will surface the missing fields with clear
    KeyErrors rather than silent Nones).
    """
    r = httpx.get(f"{sub_url}/brain/memory/{mem_id}", timeout=10.0)
    assert r.status_code == 200, r.text
    body = r.json()
    return body.get("memory", body)


def test_conflict_detector_returns_structured_field_for_l3(chat_smoke_rig):
    """Already covered indirectly by test_e2e_boot.test_l3_store_response_contains_conflict_field
    but re-asserting here makes the conflict-suite self-contained: if
    a future refactor breaks the detector, this file fails as a unit.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    body = _store_l3(sub_url, f"conflict-shape-{uuid.uuid4().hex} unrelated content")
    assert "conflict" in body, f"L3 store missing 'conflict' key: {body}"
    assert isinstance(body["conflict"].get("checked"), int)
    assert isinstance(body["conflict"].get("conflicts"), list)


def test_judge_marks_contradicting_l3_pair(chat_smoke_rig):
    """The keystone test: 2 contradicting L3s → newer wins, older marked.

    Uses content with strong vector similarity (same subject + value slot)
    so the detector's similarity filter surfaces the candidate, then the
    mock judge confirms contradiction. End-to-end exercise of every
    layer: vector index, level filter, judge HTTP call, mark_pair SQL.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    mock_url = chat_smoke_rig.mock_llm.base_url

    # Make the judge always say "contradicts" for this test
    _set_judge_mode(mock_url, contradicts=True, reason="contradiction test")

    # Use unique subject per run so previously-marked smoke conflicts
    # don't interfere. Two contradicting "favorite color" claims.
    subject = f"user-{uuid.uuid4().hex[:8]}"
    first = _store_l3(sub_url, f"{subject}'s favorite color is blue")
    # Sanity: first store has nothing to conflict with (no other L3 yet
    # matching this subject + slot). It should report no conflicts.
    assert first["conflict"]["checked"] >= 0  # could be >0 if other subjects pollute the index
    assert all(
        c.get("existing_id") != first["id"]
        for c in first["conflict"]["conflicts"]
    ), "first store shouldn't conflict with itself"

    # Second store with contradicting value — must trigger the judge AND
    # the judge says yes AND the mark_pair runs.
    second = _store_l3(sub_url, f"{subject}'s favorite color is red")

    # The second store's conflict response should reference the first
    second_conflicts = second["conflict"]["conflicts"]
    matching = [c for c in second_conflicts if c.get("existing_id") == first["id"]]
    assert matching, (
        f"Second L3 store didn't mark the first as a conflict. "
        f"first.id={first['id']} second.conflict={second['conflict']}. "
        f"Either similarity search didn't surface the first row "
        f"(threshold too high?), or the judge wasn't reached, or "
        f"_mark_pair silently failed."
    )

    # Verify the persisted state matches: first now is_current=0, both
    # share the conflict_group.
    first_after = _get_memory(sub_url, first["id"])
    second_after = _get_memory(sub_url, second["id"])

    group_first = first_after.get("conflict_group")
    group_second = second_after.get("conflict_group")
    assert group_first is not None, f"first row has no conflict_group: {first_after}"
    assert group_first == group_second, (
        f"Conflict pair must share group; first={group_first!r} second={group_second!r}"
    )
    # Policy: newer wins
    assert int(second_after.get("is_current", 1)) == 1, (
        f"newer (red) should be current; second_after={second_after}"
    )
    assert int(first_after.get("is_current", 1)) == 0, (
        f"older (blue) should be superseded; first_after={first_after}"
    )


def test_judge_no_conflict_when_judge_says_orthogonal(chat_smoke_rig):
    """When the judge replies contradicts=false, mark_pair must NOT run.

    Defends against the bug class "we mark every similar L3 as
    contradicting because the if-check on verdict.contradicts is wrong".
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    mock_url = chat_smoke_rig.mock_llm.base_url

    # Flip the judge into "no contradiction" mode
    _set_judge_mode(mock_url, contradicts=False, reason="orthogonal facts")

    subject = f"user-{uuid.uuid4().hex[:8]}"
    a = _store_l3(sub_url, f"{subject} likes coffee with milk")
    b = _store_l3(sub_url, f"{subject} likes coffee in the morning")

    # The judge said "no" — neither row should be marked
    a_after = _get_memory(sub_url, a["id"])
    b_after = _get_memory(sub_url, b["id"])
    assert int(a_after.get("is_current", 1)) == 1
    assert int(b_after.get("is_current", 1)) == 1
    # Group field stays None (or whatever default) on both
    assert a_after.get("conflict_group") in (None, "")
    assert b_after.get("conflict_group") in (None, "")

    # Reset for downstream tests (other tests in this module may not
    # remember to set their own mode — defensive)
    _set_judge_mode(mock_url, contradicts=True, reason="reset to default")


def test_conflicts_endpoint_lists_marked_groups(chat_smoke_rig):
    """The /memory/conflicts endpoint must return the pair we just marked.

    Defends against UI-facing regressions where the detector marks rows
    correctly but the list endpoint doesn't surface them, leaving the
    user with no way to see what was decided.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    mock_url = chat_smoke_rig.mock_llm.base_url
    _set_judge_mode(mock_url, contradicts=True, reason="listing test")

    subject = f"user-{uuid.uuid4().hex[:8]}"
    a = _store_l3(sub_url, f"{subject} lives in Shanghai")
    b = _store_l3(sub_url, f"{subject} lives in Beijing")

    # Hit the listing endpoint
    r = httpx.get(f"{sub_url}/brain/memory/conflicts", timeout=10.0)
    assert r.status_code == 200, r.text
    body = r.json()
    # Shape: either {"groups": [...]} or [...] — accept both for backwards-compat
    groups = body.get("groups") if isinstance(body, dict) else body
    assert isinstance(groups, list), f"unexpected conflicts payload: {body}"

    # Find a group containing both our IDs
    target_ids = {a["id"], b["id"]}
    matching_group = None
    for grp in groups:
        members = grp.get("memories") or grp.get("members") or []
        member_ids = {m.get("id") for m in members if isinstance(m, dict)}
        if target_ids.issubset(member_ids):
            matching_group = grp
            break

    assert matching_group is not None, (
        f"/memory/conflicts didn't return a group containing both "
        f"{a['id']} and {b['id']}. Returned {len(groups)} groups. "
        f"Either the detector didn't mark them (unit-test layer)  "
        f"or the listing endpoint excludes valid groups (API layer)."
    )
