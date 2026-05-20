"""Chat latency benchmark (Round F2, 2026-05-20).

End-to-end chat-call latency with the mock LLM (fast, deterministic).
Measures P50, P95, P99 over N samples. Decomposes total latency into:

    chat_total = memory.query (relevant) + LLM round-trip + memory.store
                 + background ActiveMemory fire (non-blocking)

Run explicitly (~3 min):
    pytest -m benchmark -s tests/test_chat_latency_benchmark.py

Output is printed (not asserted as a hard threshold) so the test
functions as a measurement, not a regression gate. The benchmark
exists for these questions:

  1. Did B2 (ActiveMemory fire-and-forget) add measurable per-chat
     overhead? Hypothesis: <5ms because asyncio.create_task returns
     immediately.
  2. Did the E1 _rerank-in-executor change add overhead vs the prior
     event-loop-blocking version? Hypothesis: latency goes DOWN for
     concurrent chats, similar for solo.
  3. What's the realistic P95 for users? Sets a baseline future
     rounds can compare against.

The mock LLM is intentionally fast (sub-ms response) so the numbers
are about CHAT INFRASTRUCTURE overhead, not LLM latency. Production
P95 will be dominated by the actual LLM endpoint.
"""
from __future__ import annotations

import json
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat.chat_engine import ChatEngine
from memory.memory_manager import MemoryManager


def _percentile(samples: List[float], pct: float) -> float:
    """Return the pct percentile of samples (0 ≤ pct ≤ 100)."""
    if not samples:
        return 0.0
    s = sorted(samples)
    k = (len(s) - 1) * (pct / 100.0)
    f = int(k)
    c = min(f + 1, len(s) - 1)
    if f == c:
        return s[f]
    return s[f] + (s[c] - s[f]) * (k - f)


@pytest.mark.benchmark
@pytest.mark.asyncio
async def test_chat_latency_with_mock_llm(temp_dir, mock_llm_config, capsys):
    """Measure chat() latency across N samples with mocked LLM endpoint."""
    import asyncio
    import time

    # Fresh DB so accumulated rows don't skew the importance blender.
    mm = MemoryManager(db_path=str(temp_dir / "latency.db"), llm_config=mock_llm_config)

    # Stub sub-brain client — agent-config fetch is irrelevant to latency
    sub_brain = MagicMock()
    sub_brain.execute_tool = AsyncMock(return_value="ok")

    chat = ChatEngine(
        memory_manager=mm,
        sub_brain_client=sub_brain,
        llm_config=mock_llm_config,
    )

    plain_resp = {
        "choices": [{
            "message": {"role": "assistant", "content": "Mock reply."},
            "finish_reason": "stop",
        }]
    }

    N_WARMUP = 3   # absorb any first-call costs (DB schema, embedder lazy load)
    N_SAMPLES = 30  # enough for stable P50/P95; not so many tests take forever

    async def _one_chat(seq: int) -> float:
        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value.raise_for_status = MagicMock()
            mock_post.return_value.json = MagicMock(return_value=plain_resp)
            t0 = time.perf_counter()
            await chat.chat(
                f"latency-bench-{seq}",
                session_id=f"bench-{seq}",
                context={"tools_enabled": False},
            )
            return (time.perf_counter() - t0) * 1000.0  # ms

    # Warmup
    for i in range(N_WARMUP):
        await _one_chat(i)

    # Measure
    samples_ms = []
    for i in range(N_SAMPLES):
        samples_ms.append(await _one_chat(N_WARMUP + i))

    # Concurrent — fire all at once, measure each
    async def _concurrent_batch() -> List[float]:
        starts = [time.perf_counter() for _ in range(N_SAMPLES)]
        tasks = []
        for i in range(N_SAMPLES):
            async def _ts(idx=i, s=starts[i]):
                await _one_chat(N_WARMUP + N_SAMPLES + idx)
                return (time.perf_counter() - s) * 1000.0
            tasks.append(_ts())
        return await asyncio.gather(*tasks)

    concurrent_samples = await _concurrent_batch()

    # Report
    p50 = _percentile(samples_ms, 50)
    p95 = _percentile(samples_ms, 95)
    p99 = _percentile(samples_ms, 99)
    mean = statistics.mean(samples_ms)
    cp50 = _percentile(concurrent_samples, 50)
    cp95 = _percentile(concurrent_samples, 95)

    print()
    print("=" * 72)
    print("CHAT LATENCY BENCHMARK — Round F2")
    print(f"Run at: {datetime.now(timezone.utc).isoformat()}")
    print(f"Samples: {N_SAMPLES} sequential + {N_SAMPLES} concurrent (after {N_WARMUP} warmup)")
    print("LLM: mocked (sub-ms response) — measures infra overhead only")
    print("=" * 72)
    print()
    print("Sequential (one chat at a time):")
    print(f"  P50  = {p50:7.2f} ms")
    print(f"  P95  = {p95:7.2f} ms")
    print(f"  P99  = {p99:7.2f} ms")
    print(f"  mean = {mean:7.2f} ms")
    print(f"  min  = {min(samples_ms):7.2f} ms")
    print(f"  max  = {max(samples_ms):7.2f} ms")
    print()
    print(f"Concurrent ({N_SAMPLES} simultaneous):")
    print(f"  P50  = {cp50:7.2f} ms")
    print(f"  P95  = {cp95:7.2f} ms")
    print(f"  mean = {statistics.mean(concurrent_samples):7.2f} ms")
    print()
    print("Notes:")
    print("  - Mock LLM is sub-ms, so per-chat overhead is the difference.")
    print("  - Concurrent P95 measures contention on memory.store (SQLite)")
    print("    and the embedder thread pool.")
    print("  - Production P95 will be dominated by real LLM latency (often 500-2000ms).")

    # Sanity floor — if per-chat overhead exceeds 500ms with a sub-ms
    # LLM something is badly wrong (sync I/O on the loop, runaway DB lock).
    assert p95 < 500.0, (
        f"Chat P95 = {p95:.1f}ms with a sub-ms mock LLM is suspicious. "
        f"Likely sync I/O on the event loop or DB contention regression."
    )

    # Persist for downstream tooling
    out = Path(temp_dir) / "chat_latency_results.json"
    out.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_warmup": N_WARMUP,
        "n_samples": N_SAMPLES,
        "sequential": {
            "p50_ms": p50, "p95_ms": p95, "p99_ms": p99,
            "mean_ms": mean,
            "min_ms": min(samples_ms), "max_ms": max(samples_ms),
        },
        "concurrent": {
            "p50_ms": cp50, "p95_ms": cp95,
            "mean_ms": statistics.mean(concurrent_samples),
        },
        "samples_ms": samples_ms,
        "concurrent_samples_ms": concurrent_samples,
    }, indent=2))
    print(f"\nResults JSON: {out}")
