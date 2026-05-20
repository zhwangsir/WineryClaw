"""Re-rank impact benchmark (Round D1, 2026-05-20).

The cross-encoder re-ranker (`ms-marco-MiniLM-L-6-v2`) was disabled in
the standard memory benchmark and smoke tests because of "cold load is
slow". That justification doesn't apply once the model is loaded once
per process and cached. This benchmark decides empirically whether
re-rank helps recall enough to enable it as the production default.

Plan:
  1. Plant the same 7-day fixture used by test_memory_benchmark.py
  2. Run consolidation once (so the candidate pool includes L2/L3)
  3. Measure with use_rerank=False (the current default in the basic
     benchmark) AND use_rerank=True
  4. Report deltas in recall@5 / recall@10 / MRR

Output is printed (not asserted) — like the blender grid search, this
is a measurement test, not a regression gate. The result determines
whether we should change MemoryManager.query()'s `use_rerank` default
from True to True-with-warmup or keep the rerank gate opt-in.

Marker: `@pytest.mark.benchmark`. Run with:
    pytest -m benchmark -s tests/test_rerank_impact.py
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import pytest

from memory.dreaming_engine import DreamingEngine
from memory.memory_manager import MemoryManager

# Reuse helpers from the main benchmark
from tests.test_memory_benchmark import (
    _attach_keyword_preserving_llm,
    _load_fixture,
    _plant_all,
    _recall_at_k,
    _reciprocal_rank,
    _resolve_fixture_keys,
)


async def _evaluate_with_rerank(
    mm: MemoryManager, fixture: Dict[str, Any], id_to_key: Dict[str, str],
    use_rerank: bool, levels: List[str], k_top: int = 10,
) -> Dict[str, float]:
    """Run all queries with use_rerank toggled."""
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
            "query": q["query"],
            "rerank": use_rerank,
            "recall@5": r5,
            "recall@10": r10,
            "rr": rr,
        })

    return {
        "use_rerank": use_rerank,
        "recall@5": r5_total / n,
        "recall@10": r10_total / n,
        "mrr": mrr_total / n,
        "n_queries": n,
        "per_query": per_query,
    }


@pytest.mark.benchmark
@pytest.mark.asyncio
async def test_rerank_impact_on_memory_benchmark(
    temp_dir, mock_llm_config, capsys,
):
    """Measure the recall/MRR delta of re-ranking on the 7-day fixture.

    Output is printed in markdown form so it can be pasted into
    PROJECT_STATE.md §14 verbatim.
    """
    fixture = _load_fixture()
    mm = MemoryManager(db_path=str(temp_dir / "rerank.db"), llm_config=mock_llm_config)
    key_to_id = await _plant_all(mm, fixture)
    id_to_key = {v: k for k, v in key_to_id.items()}

    # Consolidate once so L2/L3 exist
    eng = DreamingEngine(mm, llm_config=mock_llm_config)
    _attach_keyword_preserving_llm(eng, {})
    await eng.consolidate_l1_to_l2(quiet_minutes=10)
    await eng.consolidate_l2_to_l3()

    # Without re-rank (current default in benchmark)
    without = await _evaluate_with_rerank(
        mm, fixture, id_to_key, use_rerank=False, levels=["L1", "L2", "L3"],
    )
    # With re-rank (production default)
    with_rerank = await _evaluate_with_rerank(
        mm, fixture, id_to_key, use_rerank=True, levels=["L1", "L2", "L3"],
    )

    delta_r5 = with_rerank["recall@5"] - without["recall@5"]
    delta_r10 = with_rerank["recall@10"] - without["recall@10"]
    delta_mrr = with_rerank["mrr"] - without["mrr"]

    print("\n" + "=" * 72)
    print("RE-RANK IMPACT BENCHMARK — Round D1")
    print(f"Fixture: {fixture.get('queries') and len(fixture['queries'])} queries, "
          f"{len(fixture['l1'])} L1 rows, 7-day distribution")
    print(f"Run at: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 72)
    print()
    print("| setting       | recall@5 | recall@10 |  MRR  |")
    print("|---------------|----------|-----------|-------|")
    print(f"| use_rerank=F  |  {without['recall@5']:.3f}  |   "
          f"{without['recall@10']:.3f}  | {without['mrr']:.3f} |")
    print(f"| use_rerank=T  |  {with_rerank['recall@5']:.3f}  |   "
          f"{with_rerank['recall@10']:.3f}  | {with_rerank['mrr']:.3f} |")
    print(f"| Δ             |  {delta_r5:+.3f}  |   {delta_r10:+.3f}  "
          f"| {delta_mrr:+.3f} |")
    print()
    if delta_mrr > 0.02:
        print("VERDICT: re-rank helps materially — keep enabled as default.")
    elif delta_mrr < -0.02:
        print("VERDICT: re-rank HURTS quality — consider disabling by default.")
    else:
        print("VERDICT: re-rank impact within noise floor — pure latency cost. "
              "Consider disabling default and exposing as advanced toggle.")

    # Per-query examples where re-rank changed the outcome
    print()
    print("-" * 72)
    print("WORST DELTAS — queries where re-rank made things worse")
    print("-" * 72)
    pairs = list(zip(without["per_query"], with_rerank["per_query"]))
    losses = sorted(
        pairs,
        key=lambda p: (p[1]["recall@10"] - p[0]["recall@10"], p[1]["rr"] - p[0]["rr"]),
    )
    for off, on in losses[:5]:
        d10 = on["recall@10"] - off["recall@10"]
        drr = on["rr"] - off["rr"]
        if d10 < 0 or drr < -0.05:
            print(f"  query: {off['query'][:60]!r}")
            print(f"    Δ recall@10={d10:+.3f}  Δ rr={drr:+.3f}")

    print()
    print("-" * 72)
    print("BEST DELTAS — queries where re-rank helped")
    print("-" * 72)
    wins = sorted(
        pairs,
        key=lambda p: -(p[1]["recall@10"] - p[0]["recall@10"] + (p[1]["rr"] - p[0]["rr"])),
    )
    for off, on in wins[:5]:
        d10 = on["recall@10"] - off["recall@10"]
        drr = on["rr"] - off["rr"]
        if d10 > 0 or drr > 0.05:
            print(f"  query: {off['query'][:60]!r}")
            print(f"    Δ recall@10={d10:+.3f}  Δ rr={drr:+.3f}")

    # Persist JSON for downstream consumers
    out = Path(temp_dir) / "rerank_impact.json"
    out.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "without_rerank": {k: v for k, v in without.items() if k != "per_query"},
        "with_rerank": {k: v for k, v in with_rerank.items() if k != "per_query"},
        "delta": {
            "recall@5": delta_r5,
            "recall@10": delta_r10,
            "mrr": delta_mrr,
        },
    }, indent=2))
    print(f"\nResults JSON: {out}")

    # Soft sanity: re-rank should not catastrophically tank recall@10.
    # If it does, the re-rank candidate pool may be too small (limit
    # arg in _rerank truncates before re-rank order kicks in).
    assert with_rerank["recall@10"] >= without["recall@10"] - 0.15, (
        f"Re-rank dropped recall@10 by more than 0.15 — "
        f"without={without['recall@10']:.3f} with={with_rerank['recall@10']:.3f}. "
        f"Probably a bug in _rerank's candidate handling."
    )
