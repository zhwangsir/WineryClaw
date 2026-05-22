"""v2.45 — chat() cProfile-based bottleneck localization.

ADR-0002 flagged this as the next step after Sprint 0.7: the
writer-executor refactor shipped but did NOT deliver the predicted
P95 win, suggesting the SQLite write lock isn't the main bottleneck
on the current hardware. Before doing any more "guess and try"
perf work, we want hard data on what chat() actually spends its time on.

This module runs the same workload as `test_chat_latency_benchmark`
(30 concurrent chat() calls with the production WriterExecutor +
ml_executor wired, mock LLM) but wrapped in `cProfile.Profile`.
Output is printed as the top-30 cumulative-time functions and also
saved as a .pstats binary for further offline analysis with snakeviz
or gprof2dot.

Marker: `@pytest.mark.benchmark` — opt-in only. Run explicitly:

    pytest -m benchmark -s tests/test_chat_profile.py

Why cProfile and not py-spy:

- py-spy on macOS needs sudo (SIP) and a separate install.
- cProfile is stdlib, deterministic (within Python granularity),
  and shows ALL Python-level calls including the asyncio scheduler
  + wrap_future bridging that the writer-thread approach adds.
- The downside (sampling-vs-event tracing overhead) is acceptable
  for a one-shot localization run.

Interpreting the output:

- `cumtime` = total time spent in this function INCLUDING children.
  Top of this list is what dominates the end-to-end latency.
- `tottime` = time in the function itself, excluding children. Top
  of THIS list is where actual CPU/IO is spent.
- The interesting bottlenecks are usually:
  * Sentence-transformer encode (heavy CPU, single-call ~10ms)
  * sqlite3.Connection.commit (forces fsync via WAL checkpoint)
  * asyncio.wait_for / wrap_future (signals overhead)
  * httpx.Client.post (with mocked LLM this should be near-zero)
"""

from __future__ import annotations

import asyncio
import cProfile
import io
import pstats
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat.chat_engine import ChatEngine
from memory.memory_manager import MemoryManager


@pytest.mark.benchmark
@pytest.mark.asyncio
async def test_chat_profile_under_concurrency(temp_dir, mock_llm_config, capsys):
    """Profile 30 concurrent chat() calls under the production hot path
    (WriterExecutor + ml_executor wired) and print top-N hot spots."""

    # Fresh DB so we don't pick up unrelated rows.
    mm = MemoryManager(db_path=str(temp_dir / "profile.db"), llm_config=mock_llm_config)

    # Production-path executors (same wiring as main_brain.py lifespan).
    from concurrent.futures import ThreadPoolExecutor
    from memory._sqlite_executor import WriterExecutor as _Wx

    ml_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="prof-ml")
    mm.set_ml_executor(ml_executor)

    def _wx_conn_factory():
        return mm._make_pooled_connection()

    writer_executor = _Wx(_wx_conn_factory, name="prof-writer")
    mm.set_writer_executor(writer_executor)

    sub_brain = MagicMock()
    sub_brain.execute_tool = AsyncMock(return_value="ok")

    chat = ChatEngine(
        memory_manager=mm,
        sub_brain_client=sub_brain,
        llm_config=mock_llm_config,
    )

    plain_resp = {
        "choices": [
            {
                "message": {"role": "assistant", "content": "Mock reply."},
                "finish_reason": "stop",
            }
        ]
    }

    N_WARMUP = 3
    N_SAMPLES = 30

    # v2.46 — patch httpx.AsyncClient.post ONCE here, outside the chat
    # loop. The previous per-call `with patch(...)` was constructing
    # ~30 MagicMock+AsyncMock instances per call (one for the mock
    # itself, plus children for .raise_for_status and .json). The
    # profile showed mock construction taking 0.20s under conc-30
    # load — that's purely benchmark machinery overhead, not anything
    # production users see. Patch once → reuse the same mock across
    # all calls → measurement reflects real chat() perf only.
    mock_post = AsyncMock()
    mock_post.return_value.raise_for_status = MagicMock()
    mock_post.return_value.json = MagicMock(return_value=plain_resp)

    async def _one_chat(seq: int) -> float:
        with patch("httpx.AsyncClient.post", mock_post):
            t0 = time.perf_counter()
            await chat.chat(
                f"profile-{seq}",
                session_id=f"prof-{seq}",
                context={"tools_enabled": False},
            )
            return (time.perf_counter() - t0) * 1000.0

    # Warmup — runs OUTSIDE the profiler so cold-start costs don't
    # dominate. We're after the steady-state hot path.
    for i in range(N_WARMUP):
        await _one_chat(i)

    profiler = cProfile.Profile()

    async def _go() -> List[float]:
        starts = [time.perf_counter() for _ in range(N_SAMPLES)]
        tasks = []
        for i in range(N_SAMPLES):
            async def _ts(idx=i, s=starts[i]):
                await _one_chat(N_WARMUP + idx)
                return (time.perf_counter() - s) * 1000.0

            tasks.append(_ts())
        return await asyncio.gather(*tasks)

    # Note: cProfile only sees calls on the asyncio thread — the
    # writer thread and ml-executor threads run in parallel and
    # appear as a single _run_one wrapper call each. To get visibility
    # into them too we'd need threading.setprofile. For now the asyncio
    # thread's perspective is what we want: it shows the ENTRY points
    # of cross-thread calls (Future.result, asyncio.wait_for, etc.) so
    # we can quantify the bridging overhead vs the actual work.
    profiler.enable()
    samples = await _go()
    profiler.disable()

    # Save raw .pstats for offline analysis.
    pstats_path = Path(temp_dir) / "chat_profile.pstats"
    profiler.dump_stats(str(pstats_path))

    # Print top-30 by cumulative time.
    stream = io.StringIO()
    stats = pstats.Stats(profiler, stream=stream)
    stats.strip_dirs()
    stats.sort_stats("cumulative")

    print()
    print("=" * 78)
    print("CHAT cProfile — 30 concurrent (v2.45)")
    print(f"Run at: {datetime.now(timezone.utc).isoformat()}")
    print(f"P95 conc 30 = {sorted(samples)[int(N_SAMPLES * 0.95)]:.1f} ms")
    print("=" * 78)

    print("\n--- TOP 30 BY CUMULATIVE TIME ---\n")
    stats.print_stats(30)
    print(stream.getvalue())

    # Also dump top-20 by tottime — where actual CPU is burnt.
    stream2 = io.StringIO()
    stats2 = pstats.Stats(profiler, stream=stream2)
    stats2.strip_dirs()
    stats2.sort_stats("tottime")
    print("\n--- TOP 20 BY TOTAL TIME (self-only) ---\n")
    stats2.print_stats(20)
    print(stream2.getvalue())

    print(f"\nRaw .pstats: {pstats_path}")
    print("Offline: `python -m pstats chat_profile.pstats` or `snakeviz <file>`")

    # Cleanup executors so this benchmark doesn't leak threads.
    writer_executor.shutdown(wait=True)
    ml_executor.shutdown(wait=True)
