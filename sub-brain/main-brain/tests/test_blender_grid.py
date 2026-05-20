"""Blender weight grid search (Round B3).

The 0.7 / 0.3 split between textual relevance and effective_importance was
picked by hypothesis when the blender was first written — "strong match
should mostly dominate, but importance breaks near-ties". This benchmark
puts numbers on that intuition by sweeping the weight grid against the
real 7-day fixture and recording recall@5, recall@10, MRR per cell.

Run explicitly (slow):
    pytest -m benchmark -s tests/test_blender_grid.py

Output is printed as a markdown-friendly table so it can be pasted into
docs/PROJECT_STATE.md §14 verbatim. We do NOT auto-update the default
weights from this run — that's a human decision, because the fixture is
small (20 queries) and the "best" cell can shift inside the noise floor
between runs. The benchmark documents WHICH cell wins so the human can
update memory_manager.RELEVANCE_WEIGHT/IMPORTANCE_WEIGHT deliberately.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple
from unittest.mock import AsyncMock

import pytest

from memory.dreaming_engine import DreamingEngine
from memory.memory_manager import MemoryManager

# Reuse the fixture-planting + evaluation helpers from the main benchmark.
# They're stable utilities, not benchmark-specific assertions.
from tests.test_memory_benchmark import (
    _attach_keyword_preserving_llm,
    _evaluate,
    _load_fixture,
    _plant_all,
)


# ---------------------------------------------------------------------------
# Grid definition
# ---------------------------------------------------------------------------
#
# We sweep relevance weight in [0.5, 0.6, 0.7, 0.8, 0.9]. Importance is
# always 1 - relevance — testing non-complementary pairs is interesting
# theoretically but adds little signal on a 20-query fixture. Endpoints
# (1.0, 0.0) and (0.0, 1.0) are included as sanity checks: relevance-only
# should match "search engine" recall, importance-only should approximate
# "popularity ranking" (much worse for fresh queries).
GRID = [
    (1.0, 0.0),  # relevance-only baseline
    (0.9, 0.1),
    (0.8, 0.2),
    (0.7, 0.3),  # current default
    (0.6, 0.4),
    (0.5, 0.5),
    (0.4, 0.6),
    (0.3, 0.7),
    (0.0, 1.0),  # importance-only sanity check
]


# ---------------------------------------------------------------------------
# Pre-seed the fixture + run consolidation once. The blender weights
# influence only the QUERY path; the L1→L2→L3 consolidation is identical
# across cells. So we plant + dream once, then sweep weights.
# ---------------------------------------------------------------------------


async def _prepare_consolidated_mm(
    temp_dir: Path, mock_llm_config: Dict[str, Any],
) -> Tuple[MemoryManager, Dict[str, Any], Dict[str, str]]:
    fixture = _load_fixture()
    mm = MemoryManager(db_path=str(temp_dir / "blender_grid.db"), llm_config=mock_llm_config)
    key_to_id = await _plant_all(mm, fixture)
    id_to_key = {v: k for k, v in key_to_id.items()}

    eng = DreamingEngine(mm, llm_config=mock_llm_config)
    _attach_keyword_preserving_llm(eng, {})  # contents_by_session unused by stub
    await eng.consolidate_l1_to_l2(quiet_minutes=10)
    await eng.consolidate_l2_to_l3()

    return mm, fixture, id_to_key


async def _run_grid(
    mm, fixture, id_to_key, monkeypatch, *, use_rerank: bool, label: str,
    output_filename: str, temp_dir,
) -> List[Dict[str, Any]]:
    """Reusable grid runner. Returns the per-cell results list and prints
    a markdown table plus winner analysis to stdout."""
    results: List[Dict[str, Any]] = []
    for rel, imp in GRID:
        monkeypatch.setenv("WEBRAIN_RELEVANCE_WEIGHT", str(rel))
        monkeypatch.setenv("WEBRAIN_IMPORTANCE_WEIGHT", str(imp))
        metrics = await _evaluate(
            mm, fixture, id_to_key,
            levels=["L1", "L2", "L3"], use_rerank=use_rerank,
        )
        results.append({
            "relevance": rel,
            "importance": imp,
            "recall@5": metrics["recall@5"],
            "recall@10": metrics["recall@10"],
            "mrr": metrics["mrr"],
        })

    print("\n" + "=" * 72)
    print(f"BLENDER WEIGHT GRID SEARCH — {label}")
    print(f"Fixture: 20 queries, {len(fixture['l1'])} L1 rows, 7-day distribution")
    print(f"use_rerank={use_rerank}")
    print(f"Run at: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 72)
    print()
    print("| relevance | importance | recall@5 | recall@10 |  MRR  |")
    print("|-----------|------------|----------|-----------|-------|")
    for r in results:
        marker = "  ← current" if (r["relevance"], r["importance"]) == (0.7, 0.3) else ""
        print(
            f"| {r['relevance']:9.1f} | {r['importance']:10.1f} "
            f"|  {r['recall@5']:.3f}  |   {r['recall@10']:.3f}  "
            f"| {r['mrr']:.3f}{marker} |"
        )

    by_r10 = sorted(results, key=lambda x: x["recall@10"], reverse=True)
    by_mrr = sorted(results, key=lambda x: x["mrr"], reverse=True)
    print()
    print("Best by recall@10: rel={:.1f} imp={:.1f} → {:.3f}".format(
        by_r10[0]["relevance"], by_r10[0]["importance"], by_r10[0]["recall@10"]
    ))
    print("Best by MRR:       rel={:.1f} imp={:.1f} → {:.3f}".format(
        by_mrr[0]["relevance"], by_mrr[0]["importance"], by_mrr[0]["mrr"]
    ))

    out_path = Path(temp_dir) / output_filename
    out_path.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "use_rerank": use_rerank,
        "fixture_size": len(fixture["l1"]),
        "n_queries": len(fixture["queries"]),
        "grid": results,
    }, indent=2))
    print(f"Results JSON: {out_path}")
    return results


@pytest.mark.benchmark
@pytest.mark.asyncio
async def test_blender_weight_grid_search(temp_dir, mock_llm_config, monkeypatch, capsys):
    """Sweep RELEVANCE/IMPORTANCE weights with rerank OFF (Round B3 conditions).

    Preserved as-is so the B3 grid stays comparable across runs.
    """
    mm, fixture, id_to_key = await _prepare_consolidated_mm(temp_dir, mock_llm_config)
    results = await _run_grid(
        mm, fixture, id_to_key, monkeypatch,
        use_rerank=False, label="Round B3 (rerank OFF)",
        output_filename="blender_grid_results.json", temp_dir=temp_dir,
    )

    # ----- Soft sanity checks -----
    # Importance-only (0.0, 1.0) should be measurably WORSE than the
    # default 0.9/0.1 — if not, our relevance signal is broken.
    importance_only = next(r for r in results if r["relevance"] == 0.0)
    default = next(r for r in results if (r["relevance"], r["importance"]) == (0.7, 0.3))
    assert default["recall@10"] >= importance_only["recall@10"], (
        f"Default blend ({default['recall@10']:.3f}) "
        f"should beat importance-only ({importance_only['recall@10']:.3f}) — "
        f"if this fails, the relevance signal is dead or the blender is inverted."
    )

    # Relevance-only (1.0, 0.0) is the "search engine" baseline. The default
    # should be within 0.10 of it on recall@10 — adding importance shouldn't
    # tank recall, only re-order near-ties.
    relevance_only = next(r for r in results if r["relevance"] == 1.0)
    assert default["recall@10"] >= relevance_only["recall@10"] - 0.10, (
        f"Default blend tanks recall@10 vs relevance-only by more than 0.10. "
        f"relevance-only={relevance_only['recall@10']:.3f} "
        f"default={default['recall@10']:.3f}"
    )


@pytest.mark.benchmark
@pytest.mark.asyncio
async def test_blender_weight_grid_search_with_rerank(
    temp_dir, mock_llm_config, monkeypatch, capsys,
):
    """Round D2 — re-run the same grid with rerank ON.

    Production /memory/query defaults to use_rerank=True. B3's optimal
    (0.9/0.1) was measured with rerank OFF; D1 proved rerank itself is
    a big win. This test answers: does the optimal blender ratio
    SHIFT when rerank is doing the heavy lifting on candidate ordering?

    Hypothesis: rerank gives distinct cross-encoder scores, so there are
    fewer near-ties for importance to break — pure relevance (1.0/0.0)
    or near-pure should dominate even more decisively.
    """
    mm, fixture, id_to_key = await _prepare_consolidated_mm(temp_dir, mock_llm_config)
    results = await _run_grid(
        mm, fixture, id_to_key, monkeypatch,
        use_rerank=True, label="Round D2 (rerank ON)",
        output_filename="blender_grid_results_rerank.json", temp_dir=temp_dir,
    )

    # Same sanity checks (the relationships should hold regardless of
    # rerank, even if absolute numbers shift).
    importance_only = next(r for r in results if r["relevance"] == 0.0)
    default = next(r for r in results if (r["relevance"], r["importance"]) == (0.7, 0.3))
    assert default["recall@10"] >= importance_only["recall@10"], (
        f"With rerank ON, default still must beat importance-only: "
        f"default={default['recall@10']:.3f} importance-only={importance_only['recall@10']:.3f}"
    )
