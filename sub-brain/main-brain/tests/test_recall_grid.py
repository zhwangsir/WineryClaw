"""Quick grid search for blender weights without re-running dreaming."""
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from memory.memory_manager import MemoryManager
from memory.dreaming_engine import DreamingEngine
from tests.test_memory_benchmark import (
    _load_fixture, _plant_all, _attach_keyword_preserving_llm,
    _evaluate, _attach_keyword_preserving_llm,
)
from unittest.mock import AsyncMock


async def main():
    fixture = _load_fixture()
    # Use a temp db
    import tempfile
    with tempfile.TemporaryDirectory() as tmpdir:
        mm = MemoryManager(db_path=f"{tmpdir}/bench.db", llm_config={"model": "stub"})
        key_to_id = await _plant_all(mm, fixture)
        id_to_key = {v: k for k, v in key_to_id.items()}

        # Run dreaming once
        contents_by_session = {}
        for entry in fixture["l1"]:
            contents_by_session.setdefault(entry["session"], []).append(entry["content"])
        eng = DreamingEngine(mm, llm_config={"model": "stub"})
        _attach_keyword_preserving_llm(eng, contents_by_session)
        await eng.consolidate_l1_to_l2(quiet_minutes=10)
        await eng.consolidate_l2_to_l3()

        # Test different weight combos
        weights = [
            (0.5, 0.5),
            (0.6, 0.4),
            (0.7, 0.3),
            (0.8, 0.2),
            (0.9, 0.1),
            (1.0, 0.0),
        ]
        print("\n" + "=" * 60)
        print("BLENDER WEIGHT GRID SEARCH")
        print("=" * 60)
        for rel_w, imp_w in weights:
            os.environ["WEBRAIN_RELEVANCE_WEIGHT"] = str(rel_w)
            os.environ["WEBRAIN_IMPORTANCE_WEIGHT"] = str(imp_w)
            result = await _evaluate(mm, fixture, id_to_key, levels=["L1", "L2", "L3"], use_rerank=True)
            print(f"rel={rel_w:.1f} imp={imp_w:.1f}  |  recall@5={result['recall@5']:.3f}  recall@10={result['recall@10']:.3f}  MRR={result['mrr']:.3f}")

        # Also test baseline (L1 only) for reference
        os.environ["WEBRAIN_RELEVANCE_WEIGHT"] = "0.7"
        os.environ["WEBRAIN_IMPORTANCE_WEIGHT"] = "0.3"
        baseline = await _evaluate(mm, fixture, id_to_key, levels=["L1"], use_rerank=True)
        print(f"\nBASELINE (L1 only, rel=0.7 imp=0.3):")
        print(f"  recall@5={baseline['recall@5']:.3f}  recall@10={baseline['recall@10']:.3f}  MRR={baseline['mrr']:.3f}")


if __name__ == "__main__":
    asyncio.run(main())
