"""End-to-end dreaming-engine smoke tests (Round C2, 2026-05-20).

Verifies that the L1→L2→L3→L4 consolidation pipeline actually advances
rows through the levels when /dreaming/run is invoked.

The unit tests in test_dreaming_consolidation.py prove the algorithm
works against a synthetic MemoryManager. These smoke tests prove the
pipeline works against the REAL MemoryManager with all the wiring
(embeddings, provenance, importance, conflict detection) live, AND
that the HTTP endpoint actually exposes it.

Catches the bug class: "consolidation logic is unit-tested but the
/dreaming/run endpoint silently returns OK without doing anything"
(or worse, hangs because the dreaming engine wasn't initialized).

Strategy:
  1. Plant 3+ L1 rows in a unique session via /brain/memory/store
  2. POST /brain/dreaming/run with quiet_minutes=0 (force immediate)
  3. Verify L2 was created — query for the session
  4. Assert provenance_refs of the new L2 includes our L1 IDs

The mock LLM from chat_smoke_rig generates the L2 summary text, so
this test relies on the same fixture chain.

Marker: `@pytest.mark.smoke`. Run with:
    pytest -m smoke tests/smoke/test_e2e_dreaming.py -s
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List

import httpx
import pytest

pytestmark = pytest.mark.smoke


def _store_l1(sub_url: str, session: str, content: str) -> str:
    r = httpx.post(
        f"{sub_url}/brain/memory/store",
        json={
            "content": content,
            "level": "L1",
            "session_id": session,
            "source": "smoke-dreaming",
        },
        timeout=15.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("stored") is True, body
    return body["id"]


def test_dreaming_run_endpoint_responds(chat_smoke_rig):
    """The /dreaming/run endpoint must exist and respond OK.

    Catches the bug class where the dreaming endpoint was deleted or
    renamed but no client / test noticed. Without this test, dreaming
    could be silently disabled in production for months.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    # 180s: smoke DB accumulates sessions across runs, and the first run
    # in a fresh process pays one-time embedder + cross-encoder cold loads
    # (~25s) on top of N LLM round-trips. 180s gives a comfortable buffer.
    r = httpx.post(
        f"{sub_url}/brain/dreaming/run",
        json={"quiet_minutes": 0},
        timeout=180.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True, body
    result = body.get("result", {})
    # Shape check — phases must be present so the frontend dashboard
    # that displays "last dreaming cycle" can render it.
    assert "phases" in result, f"missing phases in dreaming response: {result}"
    phases = result["phases"]
    for phase in ("light_sleep", "rem_sleep", "deep_sleep"):
        assert phase in phases, f"missing phase {phase}: {phases}"


def test_dreaming_consolidates_l1_to_l2(chat_smoke_rig):
    """End-to-end: plant L1, trigger dreaming, find the resulting L2.

    The keystone test. If this passes, the entire consolidation pipeline
    is intact: embedder is loaded, LLM produces a summary, MemoryManager
    creates the L2 with correct provenance lineage, search can find it.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    session = f"dream-smoke-{uuid.uuid4().hex[:8]}"
    anchor = f"dream-anchor-{uuid.uuid4().hex}"

    # Plant 4 L1 rows — engine's MIN_L1_PER_SESSION is 3, we go above it
    # to be safe against future threshold tightening.
    l1_ids: List[str] = []
    for i in range(4):
        mid = _store_l1(sub_url, session,
                        f"{anchor} dreaming smoke entry {i}: discussing weather and lunch")
        l1_ids.append(mid)

    # Trigger dreaming with no quiet wait
    r = httpx.post(
        f"{sub_url}/brain/dreaming/run",
        json={"quiet_minutes": 0},
        timeout=180.0,  # generous — covers LLM round-trip + writes
    )
    assert r.status_code == 200, r.text
    result = r.json().get("result", {})
    light = result.get("phases", {}).get("light_sleep", {})
    assert light.get("consolidated", 0) >= 1, (
        f"Expected at least 1 L1→L2 consolidation; got: {light}"
    )

    # Verify the L2 exists by querying ALL memories for our specific session.
    # Earlier draft used /memory/query with FTS — but the shared smoke DB
    # accumulates many similar L2 rows from previous runs, and FTS+vector
    # found those instead of ours. Session-scoped query is unambiguous:
    # this session is unique-per-run, the only L2 in it must be ours.
    q = httpx.get(f"{sub_url}/brain/memory/session/{session}", timeout=15.0)
    assert q.status_code == 200, q.text
    session_memories = q.json().get("memories", [])
    l2_rows = [m for m in session_memories if m.get("level") == "L2"]
    assert len(l2_rows) >= 1, (
        f"No L2 row found for session {session}. Memories in session: "
        f"{[(m.get('level'), m.get('id')) for m in session_memories]}. "
        f"Dreaming reported consolidated={light.get('consolidated', 0)} "
        f"but no L2 landed in our session."
    )

    # Provenance check: the L2 row should reference all of our L1s
    # (or at least the head/tail subset if we exceeded MAX_L1_PER_SESSION).
    l2 = l2_rows[0]
    refs_raw = l2.get("provenance_refs") or "[]"
    if isinstance(refs_raw, str):
        try:
            refs = json.loads(refs_raw)
        except (ValueError, TypeError):
            refs = []
    else:
        refs = refs_raw
    assert isinstance(refs, list), f"provenance_refs not a list: {refs_raw!r}"
    common = set(refs) & set(l1_ids)
    assert common, (
        f"L2 row {l2.get('id')} (session={session}) provenance_refs={refs} "
        f"doesn't include any of our L1 IDs {l1_ids}. Lineage is broken — "
        f"dreaming is creating L2 rows without recording their L1 sources."
    )


def test_dreaming_idempotent_no_duplicate_l2(chat_smoke_rig):
    """Running dreaming twice on the same data must not double-create L2s.

    Without idempotency, every cron tick (every 6h) would re-create L2
    rows from the same L1s and bloat the database. The dreaming engine
    has supersession logic — verify it's hooked up.

    NB: smoke DB is project-data/main-brain/memory.db (NOT a tmpdir, see
    conftest.py note), so it accumulates rows across runs. We compare
    counts for OUR session_id specifically, not for any anchor-text match,
    so historical smoke L2s don't leak into the assertion.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    session = f"dream-idem-{uuid.uuid4().hex[:8]}"
    anchor = f"idem-anchor-{uuid.uuid4().hex}"

    for i in range(3):
        _store_l1(sub_url, session, f"{anchor} idempotency check entry {i}")

    def _count_l2_for_session() -> int:
        # Query by the unique anchor, then filter to OUR session — protects
        # against the shared-DB pollution from previous smoke runs.
        q = httpx.post(
            f"{sub_url}/brain/memory/query",
            json={"query": anchor, "levels": ["L2"], "limit": 50, "use_rerank": False},
            timeout=15.0,
        )
        q.raise_for_status()
        rows = q.json().get("results", [])
        return sum(1 for r in rows if r.get("session_id") == session)

    # First run
    r1 = httpx.post(f"{sub_url}/brain/dreaming/run",
                    json={"quiet_minutes": 0}, timeout=120.0)
    assert r1.status_code == 200, r1.text
    after_first = _count_l2_for_session()
    assert after_first >= 1, (
        f"First dreaming run produced no L2 for session {session}. "
        f"phase result: {r1.json()['result']['phases']['light_sleep']}"
    )

    # Second run — should NOT add another L2 for the same session
    r2 = httpx.post(f"{sub_url}/brain/dreaming/run",
                    json={"quiet_minutes": 0}, timeout=60.0)
    assert r2.status_code == 200, r2.text
    after_second = _count_l2_for_session()

    assert after_second == after_first, (
        f"After 2 dreaming runs on the same session, L2 count went "
        f"{after_first} → {after_second}. Expected unchanged "
        f"(idempotency must drop already-consolidated sessions)."
    )


def test_dreaming_run_rejects_negative_quiet_minutes(chat_smoke_rig):
    """quiet_minutes must be non-negative — negative would mean "consolidate
    rows from the future" which is silly. The API validates and rejects.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    r = httpx.post(
        f"{sub_url}/brain/dreaming/run",
        json={"quiet_minutes": -5},
        timeout=15.0,
    )
    # 400 = client error; some setups normalize this through the proxy
    # to 500; either way it MUST NOT be 200.
    assert r.status_code in (400, 422, 500), (
        f"Expected error response for negative quiet_minutes; got {r.status_code} {r.text}"
    )
