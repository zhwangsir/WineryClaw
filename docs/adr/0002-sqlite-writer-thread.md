# ADR-0002 — SQLite writer thread + reader pool (Sprint 0.7)

* Status: **Accepted, partial delivery** (2026-05-23)
* Postscript (2026-05-23, v2.45): The follow-up profiling step
  predicted in "Triggers for revisiting" identified the actual
  bottleneck — per-call `httpx.AsyncClient()` creation (CA bundle
  reload at 65% CPU under load), NOT the SQLite write lock. Fixed
  in v2.45 by routing all chat-path HTTP through `self._get_client()`.
  Result: seq P95 203→40.7 ms (target ≤ 80 ✅), conc 30 P95
  5184→960 ms (target ≤ 800, 20% over but 5.4x improved).
  Sprint 0.7 architecture (writer thread) remains in place — it is
  the right design for future SQLite-heavy workloads even though it
  wasn't the dominant bottleneck on the v2.44 measurement hardware.
* Postscript (2026-05-23, v2.48 dev — knob retired): A/B benchmark
  on the same hardware tested `WEBRAIN_ML_EXECUTOR_WORKERS ∈ {2, 4, 8}`
  with `WEBRAIN_BENCH_WIRE_EXECUTORS=1`. Result is counter-intuitive
  and worth recording so the next round doesn't re-test:
  | workers | conc 30 P95 |
  |---:|---:|
  | 2 | 917 ms |
  | 4 | 989 ms |
  | 8 | 1052 ms |
  More workers actively **hurt**. sentence-transformers `model.encode`
  on CPU (torch.float32) doesn't release the GIL for the bulk of its
  work and cache-thrashes when ≥3 threads contend. The remaining
  gap to ≤ 800 ms cannot be closed by worker-count tuning alone — the
  next surgical play is **embedder microbatch** (collect concurrent
  `_local_embedding` requests in a small async coalescing layer, call
  `model.encode([t1, t2, ...])` once; SentenceTransformers throughput
  is 4-8x higher with batching). That's the next round's hypothesis,
  not this one's. The latency benchmark (`tests/test_chat_latency_benchmark.py`)
  honors `WEBRAIN_ML_EXECUTOR_WORKERS` so the A/B is reproducible.
* Round: v2.44b–g
* Deciders: project owner; architect sub-agent designed the plan
* Supersedes: implicit "single connection pool serves both reads + writes" policy
* Superseded by: n/a

## Context

ROADMAP V2 §4 sets two latency targets for v2 completion:

| Metric | Target | Pre-v2.44 baseline (PROJECT_STATE §15) |
|---|---:|---:|
| Sequential chat P95 | ≤ 80 ms | ~140 ms |
| Concurrent (30) chat P95 | ≤ 800 ms | ~2450 ms |

The concurrent number is the painful one: 30 simultaneous `chat()` calls
all race for SQLite's single-writer lock. With `busy_timeout=5000` the
contention turns into latency (not errors), so P95 explodes.

An architect sub-agent assessed the codebase and recommended **Plan B:
single writer thread + read pool**, supported by a database-reviewer
audit confirming the change is safe (WAL already enabled, SQLCipher
compatible, no nested-transaction landmines).

This ADR records the design that was shipped and the measurement
result, including the gap between predicted and observed performance.

## Decision

Implement two new executor primitives in
`sub-brain/main-brain/memory/_sqlite_executor.py`:

- **`WriterExecutor`** — `ThreadPoolExecutor(max_workers=1)` with one
  long-lived SQLite connection. Every write submits a closure
  `(conn) -> T`; the executor queue serializes them. Calls bridge
  `concurrent.futures.Future` ↔ `asyncio.Future` so async callers
  stay non-blocking.
- **`ReaderPool`** — LIFO `queue.Queue` of long-lived read
  connections (size 8). With WAL on, readers run concurrently with
  the lone writer — no lock contention.

`MemoryManager` gains a parallel async write path
`_write_async(fn)` that:

- Routes through the injected `WriterExecutor` in production.
- Falls back to `asyncio.to_thread(_with_pool_conn_block)` when no
  executor is injected — preserves byte-identical behaviour for the
  944 pre-existing unit tests that construct `MemoryManager` directly.

Three write call sites migrated in order of risk:

| Step | Commit | Site | Risk |
|---|---|---|---|
| 4a | v2.44d `ea1e7b8` | `_increment_access` (query path UPDATE) | Lowest — single UPDATE, no FTS triggers |
| 4b | v2.44e `e8cb37e` | `_store_embedding` (vector BLOB write) | Medium — adds BLOB, has in-memory index update |
| 4c | v2.44f `8af4720` | `store()` INSERT (single + multi chunk) | Highest — unifies two branches, downstream consumers |

The synchronous `_increment_access` is intentionally **kept** as a
public method because 4 unit tests call it directly without an asyncio
loop. Production paths use `_increment_access_async`.

`main_brain.py` lifespan creates both `ml_executor` (v2.44a, separate
ADR-worthy decision in itself) and the `WriterExecutor`, injects them
via setters, and shuts down in reverse order (writer first, ml last)
so any in-flight chat handler that triggers a write from an ML
callback completes cleanly.

## Measured outcome (honest)

On the development laptop (macOS, 2026-05-23 02:30 UTC):

| Configuration | Seq P95 | Conc 30 P95 |
|---|---:|---:|
| Pre-v2.44 baseline (per PROJECT_STATE §15) | 140 ms | 2450 ms |
| **Post-v2.44, fallback path (no executors)** | 242 ms | 5393 ms |
| **Post-v2.44, executors wired** | 203 ms | 5184 ms |

The architect predicted 75–85 ms / 700–900 ms. We did not hit it.

What we can infer:

- The two post-v2.44 numbers are within noise of each other, so the
  WriterExecutor doesn't *hurt*; the migration is functionally clean
  (969 tests still green) but doesn't deliver the predicted speedup on
  this hardware.
- The post-v2.44 numbers are *worse* than the recorded baseline, but
  not in a way that proves regression: the baseline numbers were
  captured on different hardware months ago. Without re-running the
  pre-v2.44 code on the same laptop right now, we don't have a
  same-machine A/B.
- The conc 30 P95 is ~5 seconds for both new variants. That is
  significantly more than the SQLite write lock alone would explain
  with `busy_timeout=5000` — the bottleneck is probably elsewhere
  (embedder inference, FTS5 trigger overhead, asyncio scheduling).

The architect's design assumption "write lock is the primary
contention source under conc 30" was not validated on this hardware.

## Status of the v2 GA target

- **P95 ≤ 80 ms / 800 ms is NOT yet demonstrated.** ROADMAP V2 §4
  item "Axis 1 single-call P95 ≤ 80ms" remains open.
- The architecture is in place, correct, and reversible. Future
  profiling work (py-spy under conc-30 load) can localize the actual
  bottleneck without re-doing the executor wiring.
- The Sprint 0.7 design is recorded as **partial delivery**: the
  refactor shipped (correct), the perf result has not landed (still
  open).

## Why we are not rolling back

1. **Functional value remains.** `_write_async` correctly serializes
   writes when the executor is wired; this is the right architecture
   for any future SQLite-heavy work (e.g., batch consolidation of L1→L2
   in the dreaming engine).
2. **Code is cleaner.** `store()` now has a single INSERT block
   instead of branching on `len(chunks) <= 1`; `_store_embedding`
   keeps its critical section minimal; ML inference no longer fights
   SQLite IO on the default executor.
3. **Rollback cost > leave-in cost.** Reverting v2.44b–f would mean
   removing ~750 lines of working tested code, including 25 new tests
   that pin the design contract. The code passes all existing tests
   and is opt-in (production path lights up only when lifespan injects
   the executor; tests get the fallback).

## Triggers for revisiting

Re-open this ADR if:

- A profiling run identifies a different primary bottleneck and we
  want to deprecate the writer thread (e.g., the real win is in
  batched commits or async sqlite — `aiosqlite`).
- We see actual `SQLITE_BUSY` errors in production logs (would mean
  the executor is bypassed somewhere).
- Multi-process deployment becomes a requirement (writer thread is
  in-process; multi-process needs a different design).
- Write throughput target moves above ~200 QPS (single thread caps
  out around there even with the queue).

## Test coverage

| File | Count | Coverage |
|---|---:|---|
| `tests/test_sqlite_executor.py` | 16 | WriterExecutor + ReaderPool primitives |
| `tests/test_memory_writer_async.py` | 9 | `_write_async` plumbing + `_increment_access_async` |

All 969 main-brain unit tests still pass.

## Knobs

- `WEBRAIN_ML_EXECUTOR_WORKERS` (default 2) — sentence-transformers +
  cross-encoder thread count.
- `WEBRAIN_BENCH_WIRE_EXECUTORS=1` — opt-in inside the chat latency
  benchmark to compare fallback vs production-path numbers on the
  same machine.

## References

- `sub-brain/main-brain/memory/_sqlite_executor.py` — primitives
- `sub-brain/main-brain/memory/memory_manager.py` — `_write_async`,
  `set_writer_executor`, `_increment_access_async`, migrated write
  call sites
- `sub-brain/main-brain/main_brain.py` lifespan — executor
  construction + shutdown
- Commits: `310d3df` (v2.44b), `c06e8e6` (v2.44c), `ea1e7b8` (v2.44d),
  `e8cb37e` (v2.44e), `8af4720` (v2.44f), this commit (v2.44g/h).
