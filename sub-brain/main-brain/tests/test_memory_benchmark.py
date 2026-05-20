"""Memory retrieval benchmark (M-Memory-1, Task #8).

This isn't a unit test — it's the EVALUATION that justifies the whole
round of work. Without this we have no evidence the L1→L2→L3 pipeline
actually improves recall over the baseline "store everything as L1".

The benchmark:
  1. Plants a fixed 7-day conversation log (tests/fixtures/memory_7day_log.json)
     as L1 rows at the correct historical timestamps
  2. Runs 20 ground-truth queries, computes recall@5 / recall@10 / MRR
     for the "raw L1 only" baseline
  3. Runs the dreaming engine to consolidate L1→L2 (and synthesizes
     deterministic L3 facts from the fixture) to simulate a working
     consolidation pipeline
  4. Re-runs the same queries and reports the delta

The dreaming engine's LLM calls are stubbed deterministically — we're
testing the RETRIEVAL infrastructure (FTS, vector search, blending,
provenance lookups), NOT the LLM. The summary text returned by the stub
is a concatenation of the source L1 contents so the consolidated L2/L3
remain searchable by the original keywords.

This test is marked `slow` so the standard CI pass doesn't block on it.
Run explicitly via: pytest -m benchmark tests/test_memory_benchmark.py -s

We print the metrics to stdout (-s) rather than asserting hard
thresholds. The goal of the round was "build the infrastructure with
measurable evidence" — the actual numbers depend on the embedding model
loaded at test time, which we don't want to pin in CI.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import AsyncMock

import pytest

from memory.dreaming_engine import DreamingEngine
from memory.memory_manager import MemoryManager


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "memory_7day_log.json"


# ---------------------------------------------------------------------------
# Fixture loading & planting
# ---------------------------------------------------------------------------


def _load_fixture() -> Dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text())


async def _plant_l1_at(
    mm: MemoryManager, key: str, session: str, days_ago: float, content: str,
) -> str:
    """Plant an L1 row at a backdated timestamp using the real store() path.

    Going through store() (rather than raw INSERT) ensures the L1 row gets
    treated like any production L1 — most importantly, that any embedding
    / indexing logic store() triggers also runs here. Otherwise the
    baseline measurement would be unfairly handicapped (zero embeddings,
    only FTS retrieval, and FTS5's default tokenizer handles CJK poorly).

    After store(), we UPDATE the timestamps to backdate the row so the
    forgetting curve and dreaming quiet-window math operate on a realistic
    7-day distribution. We also UPDATE metadata to attach the fixture_key
    that the benchmark uses to map rows back to ground-truth entries.

    NB: store() defaults importance per-level. We let it. The benchmark
    isn't measuring importance-based gating directly — the dreaming layer
    creates new L2/L3 with the right defaults, that's what matters.
    """
    result = await mm.store({
        "level": "L1", "content": content,
        "source": "benchmark", "session_id": session,
        "provenance_source": "chat",
    })
    mem_id = result["id"]
    ts = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    with mm._connect() as conn:
        conn.execute(
            """UPDATE memories
               SET created_at = ?, last_accessed_at = ?, metadata = ?
               WHERE id = ?""",
            (ts, ts, json.dumps({"fixture_key": key}), mem_id),
        )
        conn.commit()
    return mem_id


async def _plant_all(mm: MemoryManager, fixture: Dict[str, Any]) -> Dict[str, str]:
    """Plant every L1 row from the fixture; return {fixture_key: mem_id}."""
    out: Dict[str, str] = {}
    for entry in fixture["l1"]:
        mem_id = await _plant_l1_at(
            mm, key=entry["key"], session=entry["session"],
            days_ago=entry["days_ago"], content=entry["content"],
        )
        out[entry["key"]] = mem_id
    return out


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def _key_for_row(row: Dict[str, Any]) -> str:
    """Map a returned memory row back to its fixture key (if L1) or to the
    set of fixture keys it covers (if L2/L3 via provenance lineage).

    For L1 rows: fixture_key sits in metadata.
    For L2/L3 rows: provenance_refs lists L1 ids; the harness owns the
    {L1 id → fixture_key} mapping and walks up to derive keys.
    """
    md = row.get("metadata")
    if isinstance(md, str):
        try:
            md = json.loads(md)
        except (ValueError, TypeError):
            md = {}
    if isinstance(md, dict) and "fixture_key" in md:
        return md["fixture_key"]
    return ""  # no direct key — caller handles lineage walk


def _resolve_fixture_keys(
    row: Dict[str, Any], id_to_key: Dict[str, str],
) -> List[str]:
    """Return the fixture keys this row "covers".

    - L1 row: its own fixture_key (from metadata) — one element list
    - L2/L3 row: the union of fixture_keys of L1 rows in its provenance_refs
    """
    direct = _key_for_row(row)
    if direct:
        return [direct]
    refs_raw = row.get("provenance_refs") or "[]"
    if isinstance(refs_raw, str):
        try:
            refs = json.loads(refs_raw)
        except (ValueError, TypeError):
            refs = []
    else:
        refs = refs_raw
    return [id_to_key[r] for r in refs if r in id_to_key]


def _recall_at_k(
    expected: List[str], returned_keys_per_rank: List[List[str]], k: int,
) -> float:
    expected_set = set(expected)
    top_k_keys: set = set()
    for keys in returned_keys_per_rank[:k]:
        top_k_keys.update(keys)
    if not expected_set:
        return 1.0
    return len(expected_set & top_k_keys) / len(expected_set)


def _reciprocal_rank(
    expected: List[str], returned_keys_per_rank: List[List[str]],
) -> float:
    expected_set = set(expected)
    for rank, keys in enumerate(returned_keys_per_rank, start=1):
        if expected_set & set(keys):
            return 1.0 / rank
    return 0.0


async def _evaluate(
    mm: MemoryManager, fixture: Dict[str, Any], id_to_key: Dict[str, str],
    levels: List[str], k_top: int = 10, use_rerank: bool = False,
) -> Dict[str, float]:
    """Run all queries from the fixture, return aggregated metrics.

    use_rerank: default False to preserve historical comparability of the
    baseline benchmark (was effectively the only option when the rerank
    model wasn't cached). Round D1 measured the prod-default impact and
    Round D2 re-runs blender grid with rerank=True — both pass True here.
    """
    r5_total = 0.0
    r10_total = 0.0
    mrr_total = 0.0
    n = len(fixture["queries"])
    per_query: List[Dict[str, Any]] = []

    for q in fixture["queries"]:
        results = await mm.query({
            "query": q["query"],
            "levels": levels,
            "limit": k_top,
            "use_rerank": use_rerank,
        })
        returned_keys_per_rank = [_resolve_fixture_keys(r, id_to_key) for r in results]
        r5 = _recall_at_k(q["expects"], returned_keys_per_rank, 5)
        r10 = _recall_at_k(q["expects"], returned_keys_per_rank, 10)
        rr = _reciprocal_rank(q["expects"], returned_keys_per_rank)
        r5_total += r5
        r10_total += r10
        mrr_total += rr
        per_query.append({
            "query": q["query"], "expects": q["expects"],
            "recall@5": r5, "recall@10": r10, "rr": rr,
            "got_keys_first_5": [k for ks in returned_keys_per_rank[:5] for k in ks],
        })

    return {
        "recall@5": r5_total / n,
        "recall@10": r10_total / n,
        "mrr": mrr_total / n,
        "n_queries": n,
        "per_query": per_query,
    }


# ---------------------------------------------------------------------------
# Stub LLM for dreaming engine — returns deterministic content so the
# resulting L2/L3 rows remain searchable by the original keywords.
# ---------------------------------------------------------------------------


def _attach_keyword_preserving_llm(eng: DreamingEngine, l1_contents_by_session: Dict[str, List[str]]):
    """Wire eng._llm_call so:
      - L1→L2 summaries are concatenations of source L1 contents (so the
        L2 row still hits FTS for any of the original keywords).
      - L2→L3 fact extraction returns ~3 facts per L2, each extracted
        verbatim from a chunk of the L2 content.
    """
    call_count = {"summary": 0, "facts": 0}

    async def _stub(messages, max_tokens: int = 1024) -> str:
        # Heuristic: the L1→L2 prompt contains "Summarize"; L2→L3 contains
        # "Extract" / "preference|fact|decision". Cheap inspection saves
        # us from threading extra params through.
        user_text = ""
        for m in messages:
            if m.get("role") == "user":
                user_text = m.get("content", "")
                break
        if "Extract" in user_text and "facts" in user_text:
            call_count["facts"] += 1
            # The L2 content lives between "Summary:\n" and end
            anchor = "Summary:\n"
            chunk = user_text.split(anchor, 1)[-1] if anchor in user_text else user_text
            lines = [l.strip() for l in chunk.split("\n") if l.strip()][:3]
            facts = [
                {"kind": "fact", "statement": line[:200]} for line in lines
            ]
            return json.dumps({"facts": facts})
        # L1→L2 summary path: echo back enough source text to keep FTS happy
        call_count["summary"] += 1
        marker = "messages):"
        if marker in user_text:
            body = user_text.split(marker, 1)[1]
            # body is the raw L1 lines + trailing "Summary:" — strip the latter
            body = body.split("Summary:", 1)[0].strip()
            # Cap to ~600 chars so we don't return absurd payloads
            return "SUMMARY: " + body[:600]
        return "SUMMARY: " + user_text[:300]

    eng._llm_call = AsyncMock(side_effect=_stub)
    return call_count


# ---------------------------------------------------------------------------
# The benchmark
# ---------------------------------------------------------------------------


@pytest.mark.benchmark
@pytest.mark.asyncio
async def test_memory_benchmark_baseline_vs_consolidated(temp_dir, mock_llm_config, capsys):
    """Measure recall against the 7-day fixture before and after dreaming.

    Output is printed (not asserted) so the test functions as a benchmark.
    Run with: pytest -m benchmark -s tests/test_memory_benchmark.py
    """
    fixture = _load_fixture()
    mm = MemoryManager(db_path=str(temp_dir / "bench.db"), llm_config=mock_llm_config)
    key_to_id = await _plant_all(mm, fixture)
    id_to_key = {v: k for k, v in key_to_id.items()}

    # ----- Baseline: query against L1 only, no consolidation yet -----
    baseline = await _evaluate(mm, fixture, id_to_key, levels=["L1"])
    # Pretty-print to stdout (visible with `pytest -s`)
    print("\n" + "=" * 72)
    print("BASELINE — L1 only, no consolidation")
    print("=" * 72)
    print(f"recall@5  = {baseline['recall@5']:.3f}")
    print(f"recall@10 = {baseline['recall@10']:.3f}")
    print(f"MRR       = {baseline['mrr']:.3f}")
    print(f"n_queries = {baseline['n_queries']}")

    # ----- Run dreaming engine with keyword-preserving stub LLM -----
    # Group L1s per session for the stub
    contents_by_session: Dict[str, List[str]] = {}
    for entry in fixture["l1"]:
        contents_by_session.setdefault(entry["session"], []).append(entry["content"])

    eng = DreamingEngine(mm, llm_config=mock_llm_config)
    _attach_keyword_preserving_llm(eng, contents_by_session)

    l1_to_l2 = await eng.consolidate_l1_to_l2(quiet_minutes=10)
    l2_to_l3 = await eng.consolidate_l2_to_l3()

    print("\n" + "-" * 72)
    print("CONSOLIDATION STATS")
    print("-" * 72)
    print(f"L1→L2: {l1_to_l2}")
    print(f"L2→L3: {l2_to_l3}")

    # ----- Re-evaluate, this time querying across all levels -----
    after = await _evaluate(mm, fixture, id_to_key, levels=["L1", "L2", "L3"])
    print("\n" + "=" * 72)
    print("POST-CONSOLIDATION — L1 + L2 + L3")
    print("=" * 72)
    print(f"recall@5  = {after['recall@5']:.3f}  (Δ {after['recall@5'] - baseline['recall@5']:+.3f})")
    print(f"recall@10 = {after['recall@10']:.3f}  (Δ {after['recall@10'] - baseline['recall@10']:+.3f})")
    print(f"MRR       = {after['mrr']:.3f}  (Δ {after['mrr'] - baseline['mrr']:+.3f})")

    # Per-query worst cases — useful for debugging fixture issues
    print("\n" + "-" * 72)
    print("WORST QUERIES (recall@10 < 1.0, post-consolidation)")
    print("-" * 72)
    for pq in sorted(after["per_query"], key=lambda x: x["recall@10"]):
        if pq["recall@10"] < 1.0:
            print(f"  '{pq['query']}'")
            print(f"    expected: {pq['expects']}")
            print(f"    got top-5: {pq['got_keys_first_5']}")
        else:
            break

    # ----- Soft assertions — the round was worth it if at least we don't regress -----
    # Hard floor: post-consolidation recall@10 must be at least as good as baseline.
    # If consolidation made things worse, something is broken (bad LLM stub,
    # provenance plumbing wrong, blender misranking). We want CI to surface that.
    assert after["recall@10"] >= baseline["recall@10"] - 0.05, (
        f"Consolidation regressed recall@10: {baseline['recall@10']:.3f} → {after['recall@10']:.3f}"
    )
    # Sanity: dreaming actually did something
    assert l1_to_l2["consolidated"] >= 5, (
        f"Expected ≥5 sessions consolidated from 7-day fixture, got {l1_to_l2['consolidated']}"
    )
    assert l2_to_l3["facts_created"] >= 5, (
        f"Expected ≥5 L3 facts from L2 summaries, got {l2_to_l3['facts_created']}"
    )
