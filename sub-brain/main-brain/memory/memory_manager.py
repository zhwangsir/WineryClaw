"""
WeBrain Memory Manager — Phase 3 RAG Enhanced
L1-L4 分层记忆 + Hybrid Search (BM25 + Vector) + Re-ranking + Chunking
"""

import asyncio
import json
import logging
import os
import sqlite3
import uuid
import math
import re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import httpx
import numpy as np

logger = logging.getLogger("webrain.memory")

# ---------------------------------------------------------------------------
# Memory layer semantics — M-Memory-1
# ---------------------------------------------------------------------------
# Default importance per level. New L1 entries are "raw events" with modest
# importance; L2 are session summaries (higher signal); L3 are extracted
# semantic facts (high); L4 are long-term identity (highest baseline).
#
# These are *defaults* — callers may pass an explicit importance. Stays
# inside [0.0, 1.0] regardless of upstream value.
DEFAULT_IMPORTANCE_BY_LEVEL: Dict[str, float] = {
    "L1": 0.4,
    "L2": 0.6,
    "L3": 0.7,
    "L4": 0.9,
}

# Forgetting-curve half-lives in days. effective = importance * exp(-elapsed / half_life).
# L4 is effectively immortal — a sufficiently large number that decay is
# imperceptible over any realistic lifetime.
HALF_LIFE_DAYS_BY_LEVEL: Dict[str, float] = {
    "L1": 2.0,
    "L2": 14.0,
    "L3": 90.0,
    "L4": 1.0e9,
}

# On every retrieve, importance is bumped by this amount (clamped to 1.0).
# Frequent recall → memory stays alive against decay; never-recalled →
# eventually drowned by stronger memories at query time.
RETRIEVAL_BOOST = 0.05

# Query-time blending of textual relevance vs decayed importance.
# final_score = relevance * RELEVANCE_WEIGHT + effective_importance * IMPORTANCE_WEIGHT
#
# Default 0.7 / 0.3 chosen by Round D2 grid search (2026-05-20) which
# re-ran the B3 grid with use_rerank=True (the production default).
# This corrects an error in B3, which measured with rerank disabled and
# incorrectly concluded "relevance should dominate". Under production
# (rerank=True) conditions:
#
#   rel=1.0 imp=0.0  recall@5 0.575  recall@10 0.675  MRR 0.562
#   rel=0.9 imp=0.1  recall@5 0.625  recall@10 0.675  MRR 0.568  (B3 chose this)
#   rel=0.7 imp=0.3  recall@5 0.625  recall@10 0.675  MRR 0.590  ← chosen
#   rel=0.5 imp=0.5  recall@5 0.625  recall@10 0.675  MRR 0.590
#   rel=0.0 imp=1.0  recall@5 0.000  recall@10 0.200  MRR 0.020  (sanity)
#
# Why 0.7 over 0.5 — both share the MRR peak at 0.590. 0.7 stays closer
# to the rerank-driven ordering (rerank IS already a strong relevance
# signal); 0.3 importance is enough to break near-ties when the
# cross-encoder gives close scores. Pushing importance higher than 0.5
# starts to degrade.
#
# Why importance matters MORE with rerank ON, not less: the cross-encoder
# produces distinct, well-separated scores, so the candidate ranking is
# mostly determined by rerank. The blender's only job becomes
# "if rerank gives two candidates similar scores, prefer the one with
# higher decayed importance" — exactly the use case importance is
# designed for.
#
# Env-overridable so the grid-search benchmark can sweep weights without
# monkey-patching, and so deployments can tune without code changes.
# WEBRAIN_RELEVANCE_WEIGHT alone is enough; importance weight is derived
# as 1 - relevance unless explicitly set. Both clamped to [0,1] and the
# pair is renormalized to sum==1.
def _resolve_blender_weights() -> tuple:
    try:
        rel = float(os.environ.get("WEBRAIN_RELEVANCE_WEIGHT", "0.7"))
    except ValueError:
        rel = 0.7
    try:
        imp_env = os.environ.get("WEBRAIN_IMPORTANCE_WEIGHT")
        imp = float(imp_env) if imp_env is not None else (1.0 - rel)
    except ValueError:
        imp = 1.0 - rel
    rel = max(0.0, min(1.0, rel))
    imp = max(0.0, min(1.0, imp))
    total = rel + imp
    if total <= 1e-9:
        # Degenerate input — fall back to default split
        return 0.7, 0.3
    return rel / total, imp / total


RELEVANCE_WEIGHT, IMPORTANCE_WEIGHT = _resolve_blender_weights()


def _parse_iso(ts: Optional[str]) -> Optional[datetime]:
    """Lenient ISO-8601 parser that returns None for empty / unparseable input.

    SQLite stores timestamps as TEXT; rows from before M-Memory-1 may have
    last_accessed_at = NULL despite the backfill (race conditions, manual
    inserts in tests, etc.). Callers handle None as "treat as freshly
    created" rather than crashing.
    """
    if not ts:
        return None
    try:
        # datetime.fromisoformat accepts the format we write
        dt = datetime.fromisoformat(ts)
        # Treat naive timestamps as UTC for consistent math
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (TypeError, ValueError):
        return None


def effective_importance(
    importance: float,
    level: str,
    last_accessed_at: Optional[str],
    now: Optional[datetime] = None,
) -> float:
    """Apply forgetting-curve decay to a memory's stored importance.

    Formula: effective = importance * exp(-elapsed_days / half_life)

    Half-life depends on level (see HALF_LIFE_DAYS_BY_LEVEL). L4 has an
    effectively infinite half-life so it does not decay over any
    realistic timescale.

    `last_accessed_at` is the reference timestamp — typically set to
    created_at on insert, then bumped by `_increment_access` on every
    retrieve. If missing or unparseable, returns the raw importance
    (no decay applied) — safer than zeroing out the memory.
    """
    if importance is None:
        importance = 0.5
    importance = max(0.0, min(1.0, float(importance)))
    half_life = HALF_LIFE_DAYS_BY_LEVEL.get(level, 14.0)
    anchor = _parse_iso(last_accessed_at)
    if anchor is None:
        return importance
    now = now or datetime.now(timezone.utc)
    elapsed = (now - anchor).total_seconds() / 86400.0
    if elapsed <= 0:
        return importance
    return importance * math.exp(-elapsed / half_life)

# ---------------------------------------------------------------------------
# Re-ranking model (lazy-loaded with double-checked lock — same pattern as
# the embedder. Code-review found this was unprotected: a cold-start race
# could load the ~100 MB CrossEncoder twice and drop one instance, wasting
# RAM and load time. Round E1 fix.)
# ---------------------------------------------------------------------------
_reranker = None
_reranker_lock = None  # threading.Lock — initialized lazily to avoid import order issues


def _get_reranker():
    """Lazy-load cross-encoder re-ranker, thread-safe."""
    global _reranker, _reranker_lock
    # First check (no lock) — fast path once loaded.
    if _reranker is not None:
        return _reranker if _reranker is not False else None
    # Initialize lock on first slow-path entry. Using the module's
    # threading guard mirrors what _get_embedder does.
    if _reranker_lock is None:
        import threading as _threading
        _reranker_lock = _threading.Lock()
    with _reranker_lock:
        # Second check inside the lock — another thread may have loaded
        # it while we were waiting.
        if _reranker is None:
            try:
                from sentence_transformers import CrossEncoder
                _reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
                logger.info("[memory] Re-ranker loaded: ms-marco-MiniLM-L-6-v2")
            except Exception as e:
                logger.warning(f"[memory] Failed to load re-ranker: {e}")
                _reranker = False
    return _reranker if _reranker is not False else None


# ---------------------------------------------------------------------------
# Sentence-transformer embedding model (lazy-loaded, cached, thread-safe)
# ---------------------------------------------------------------------------
# Why a module-level singleton: BEFORE this cache existed, _local_embedding
# instantiated `SentenceTransformer("all-MiniLM-L6-v2")` on every call.
# Smoke trial 2026-05-20 measured first L3 store = 19.9s, second = 4.8s —
# the model was being re-loaded from disk into RAM every embedding call.
# Caching once at module level drops second+ calls to ~50ms.
#
# Why a lock: the warm-up task runs in a thread executor concurrently with
# the FastAPI request handler thread. Without the lock both can observe
# `_embedder is None` and both load the model — measured as 2× the
# 15-second cost on parallel cold starts. The lock ensures the first
# call pays the load cost ONCE and every subsequent caller (including
# the racing one) waits for the cached instance.
import threading as _threading

_embedder = None
_embedder_lock = _threading.Lock()


def _get_embedder():
    """Lazy-load the sentence-transformers embedder. Single instance per process.

    Thread-safe via double-checked locking. Returns None if
    sentence-transformers isn't installed or the model fails to load.
    Callers should treat None as "embedding unavailable" and fall back
    to whatever they do without a vector (FTS-only search, in
    MemoryManager's case).
    """
    global _embedder
    # Fast path: already loaded — no lock needed
    if _embedder is not None:
        return _embedder if _embedder is not False else None
    # Slow path: contend for the load
    with _embedder_lock:
        if _embedder is not None:  # someone else loaded while we waited
            return _embedder if _embedder is not False else None
        try:
            from sentence_transformers import SentenceTransformer
            _embedder = SentenceTransformer("all-MiniLM-L6-v2")
            logger.info("[memory] Embedder loaded: all-MiniLM-L6-v2")
        except Exception as e:
            logger.warning(f"[memory] Failed to load local embedder: {e}")
            _embedder = False
    return _embedder if _embedder is not False else None


def _build_fts5_safe_query(query: str) -> str:
    """Quote each whitespace-delimited token in `query` for safe FTS5 MATCH.

    FTS5 has its own query DSL: bare hyphens are NOT, `column:` is a
    column qualifier, parentheses group, `*` is prefix-match. Any of
    these in a user query causes either silent no-match or a hard error
    ("no such column: l1"). The fix is to wrap each token in a phrase
    quote, which makes FTS5 treat it as a literal match.

    Examples:
      "apples oranges"          → `"apples" "oranges"`     (implicit AND)
      "unique-l1-token-xyz123"  → `"unique-l1-token-xyz123"` (one literal)
      "Hello, world!"           → `"Hello," "world!"`      (punctuation kept inside literal)
      ""                        → `""`                      (caller bails)
      'don\\'t'                 → `"don\\'t"`               (single quotes are FTS-safe)

    Internal double quotes are escaped to `""` per FTS5 phrase-literal
    rules. Empty tokens (multiple whitespace) drop out — they'd produce
    `""` which FTS5 treats as an empty-match no-op.
    """
    if not query or not query.strip():
        return ""
    out_tokens = []
    for tok in query.split():
        tok = tok.replace('"', '""')
        if not tok:
            continue
        out_tokens.append(f'"{tok}"')
    return " ".join(out_tokens)


async def backfill_missing_embeddings(
    manager: "MemoryManager",
    batch_size: int = 50,
    max_per_run: int = 500,
) -> Dict[str, int]:
    """Backfill embeddings for memories that don't have a vector row yet.

    Necessary for users who upgrade FROM a pre-M-Memory-1 install: their
    existing L1 (and pre-fix L2/L3) rows have schema columns but no row
    in the `vectors` table. Without embeddings, semantic search misses
    the entire historical corpus — silently. User-trial #5.

    Strategy:
      - Find memory rows with no matching vectors row, for levels where
        embedding is enabled (L1 if WEBRAIN_MEMORY_EMBED_L1!=0, plus
        L2/L3/L4 always).
      - Skip rows with empty / blank content (nothing to embed).
      - Process in batches of `batch_size`, up to `max_per_run` total per
        call. The default 500/run keeps backfill bounded — a 10k-row DB
        completes over ~20 startups (or one explicit /memory/backfill call).
      - Each row's embedding goes through the cached singleton — first call
        in this run still pays warmup cost; everything after is fast.
      - Fire-and-forget from lifespan; failure leaves rows un-embedded so
        the next startup retries them.

    Returns counts: {"scanned", "embedded", "skipped_empty", "failed"}.
    """
    import os as _os
    embed_l1 = _os.environ.get("WEBRAIN_MEMORY_EMBED_L1", "1") != "0"
    levels = ["L2", "L3", "L4"] + (["L1"] if embed_l1 else [])

    placeholders = ",".join(["?"] * len(levels))
    # LEFT JOIN to find rows whose id is not in `vectors`. We compare by
    # memory_id since vectors.memory_id is the FK. SQL filter only does
    # a coarse non-NULL check — the whitespace-only check below is in
    # Python because SQLite's default TRIM only handles spaces, not
    # tabs / newlines (caught by user-trial backfill tests).
    with manager._connect() as conn:
        rows = conn.execute(
            f"""SELECT m.id, m.content, m.level
                FROM memories m
                LEFT JOIN vectors v ON v.memory_id = m.id
                WHERE v.memory_id IS NULL
                  AND m.level IN ({placeholders})
                  AND m.content IS NOT NULL
                  AND m.archived = 0
                ORDER BY m.created_at DESC
                LIMIT ?""",
            (*levels, max_per_run),
        ).fetchall()

    embedded = 0
    failed = 0
    skipped_empty = 0
    scanned = 0
    for i in range(0, len(rows), batch_size):
        chunk = rows[i:i + batch_size]
        for r in chunk:
            content = (r["content"] or "")
            if not content.strip():
                # Python-level whitespace check — covers tabs, newlines, etc
                # that SQLite TRIM misses. Skip silently.
                skipped_empty += 1
                continue
            scanned += 1
            try:
                await manager._store_embedding(r["id"], content)
                embedded += 1
            except Exception as e:
                logger.warning(
                    "[memory] backfill failed for id=%s level=%s: %s",
                    r["id"][:8], r["level"], e,
                )
                failed += 1

    if scanned > 0 or skipped_empty > 0:
        logger.info(
            "[memory] backfill embeddings: scanned=%d embedded=%d skipped_empty=%d failed=%d (max_per_run=%d)",
            scanned, embedded, skipped_empty, failed, max_per_run,
        )
    return {"scanned": scanned, "embedded": embedded, "skipped_empty": skipped_empty, "failed": failed}


async def warm_local_embedder() -> bool:
    """Warm the local embedder out-of-band so the first user request doesn't
    pay the model-load cost.

    Called from main_brain.py lifespan as `asyncio.create_task(...)` so it
    doesn't block startup completion. Returns True if the model loaded
    successfully (cache populated), False otherwise. Idempotent.
    """
    # get_running_loop (not get_event_loop, which is deprecated in 3.10+
    # for the no-running-loop path). This function is always called from
    # inside a running loop via asyncio.create_task — Round E1 fix.
    loop = asyncio.get_running_loop()
    model = await loop.run_in_executor(None, _get_embedder)
    if model is None:
        return False
    # Force a one-shot encode so any deferred kernels (mps device init,
    # tokenizer warmup) finish during warmup, not during the user's
    # first request.
    try:
        await loop.run_in_executor(None, lambda: model.encode("warm").tolist())
        return True
    except Exception as e:
        logger.warning(f"[memory] Embedder warm-up encode failed: {e}")
        return False


import queue as _queue


class MemoryManager:
    """Orchestrates L1-L4 hierarchical memory with advanced RAG."""

    # Round H2 (2026-05-20): SQLite connection pool size. Chosen to be
    # small (most chat workflows are sequential) but >1 so a slow query
    # in one place doesn't block all others. Tune via the env if needed;
    # the F2 chat-latency benchmark uses 30 concurrent + most are
    # write-heavy so 4 is a reasonable middle ground (above 4, contention
    # on the SQLite write lock outweighs connect-cost savings).
    #
    # v2.43 (Sprint 0.7 quick win): bumped default 4 → 6. database-reviewer
    # audit found that 30-concurrent benchmarks burn ~12-15% of P95 on
    # "pool empty → fall through to ad-hoc connect-and-close" rather than
    # write-lock contention. A pool of 6 keeps the steady-state hit rate
    # higher without hitting the SQLite write-lock saturation cliff. The
    # bigger conc-30 P95 win comes from v2.44 (writer thread + read pool).
    _POOL_SIZE = int(os.environ.get("WEBRAIN_SQLITE_POOL_SIZE", "6"))

    def __init__(self, db_path: Optional[str] = None, llm_config: Optional[Dict] = None):
        self._db_path = db_path or str(Path.home() / ".webrain" / "memory.db")
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        # H2: bounded LIFO pool of long-lived connections. We use Queue
        # for thread-safety. Connections are created lazily — the first
        # _connect() call opens one; subsequent calls reuse it. Excess
        # connections (over _POOL_SIZE) get closed on return rather than
        # blocking the caller.
        self._pool: "_queue.Queue[sqlite3.Connection]" = _queue.Queue(maxsize=self._POOL_SIZE)
        self.llm_config = llm_config or {
            "base_url": "http://localhost:1234/v1",
            "model_id": "minimax/minimax-m2.7",
        }
        # Embedding providers: ordered by preference
        self._embedding_providers = self._load_embedding_providers()
        # In-memory ANN index (numpy + sklearn)
        self._vector_ids: List[str] = []      # memory_id list
        self._vector_matrix: Optional[np.ndarray] = None  # (n, dim) float32
        self._ann_index: Optional[Any] = None  # sklearn NearestNeighbors
        self._ann_dirty = True
        self._http_client: Optional[httpx.AsyncClient] = None
        # M-Memory-1: optional L3 conflict detector. None → no contradiction
        # check (backward compatible default). Wire via set_conflict_detector
        # after construction so we don't introduce a circular import.
        self._conflict_detector: Optional[Any] = None
        # v2.44a (Sprint 0.7 step 5) — named ML thread pool injected at
        # lifespan startup. When None, run_in_executor falls back to the
        # event loop's default pool (preserves behavior for tests and any
        # caller that constructs MemoryManager directly). When set, the
        # CPU-bound rerank.predict + embedder.encode calls run on this
        # dedicated pool so they don't fight SQLite IO for default-pool
        # slots. Wire via set_ml_executor() after construction.
        self._ml_executor: Optional[Any] = None
        self._init_db()
        self._load_vector_index()  # build index from existing DB vectors

    def set_conflict_detector(self, detector: Optional[Any]) -> None:
        """Plug in (or remove) the L3 conflict detector.

        Production code calls this after MemoryManager construction in
        main_brain.py lifespan, once an LLM caller is available. Tests
        either skip wiring (no detector → no conflict checks) or inject
        a stub that returns canned verdicts.
        """
        self._conflict_detector = detector

    def set_ml_executor(self, executor: Optional[Any]) -> None:
        """v2.44a — inject a dedicated ThreadPoolExecutor for ML calls
        (rerank + embedder). Passing None reverts to default-pool
        behavior, which is what unit tests with bare MemoryManager
        instances want.

        Production main_brain.py lifespan creates a single
        `ThreadPoolExecutor(max_workers=2, thread_name_prefix="webrain-ml")`
        and calls this once. The executor is then read inside
        _embed_async / rerank / encode paths.
        """
        self._ml_executor = executor

    @property
    def ml_executor(self) -> Optional[Any]:
        """Read-only access for ChatEngine + other modules that share
        the same ML thread pool."""
        return self._ml_executor

    def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=30.0)
        return self._http_client

    async def close(self) -> None:
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()
        # H2: drain and close pooled SQLite connections so file handles
        # don't leak in test fixtures that build many MemoryManagers.
        while True:
            try:
                conn = self._pool.get_nowait()
            except _queue.Empty:
                break
            try:
                conn.close()
            except sqlite3.DatabaseError:
                pass

    @staticmethod
    def _in_placeholders(count: int) -> str:
        """Generate '?,?,?' for IN clause parameters."""
        return ",".join(["?"] * count)

    def _make_pooled_connection(self) -> sqlite3.Connection:
        """Build a long-lived connection with PRAGMAs applied once.

        H2: now that connections are pooled, PRAGMA setup cost
        amortizes across many queries. We can enable WAL mode + tighter
        busy timeout without the H1 per-connect overhead trap.

        ROADMAP V2 Axis 3 — opt-in SQLCipher encryption.
        When WEBRAIN_SQLCIPHER_KEY is set:
          - try import pysqlcipher3 → use encrypted driver + PRAGMA key
          - if pysqlcipher3 is missing → warn loudly, fall back to plain
            sqlite3 (fail-open so dev / CI without the binding stays green)
        When the env var is unset, behavior is identical to pre-encryption.
        """
        sqlcipher_key = os.environ.get("WEBRAIN_SQLCIPHER_KEY")
        conn: sqlite3.Connection
        if sqlcipher_key:
            try:
                from pysqlcipher3 import dbapi2 as sqlcipher  # type: ignore[import-not-found]

                conn = sqlcipher.connect(self._db_path, check_same_thread=False)
                # PRAGMA key MUST run before any other SQL on a SQLCipher conn.
                # Parametrized binding is not supported for PRAGMA — escape
                # single quotes to keep the literal safe against quote injection.
                escaped = sqlcipher_key.replace("'", "''")
                conn.execute(f"PRAGMA key = '{escaped}'")
                logger.info("[memory] SQLCipher enabled (db=%s)", self._db_path)
            except ImportError:
                logger.warning(
                    "[memory] WEBRAIN_SQLCIPHER_KEY set but pysqlcipher3 not "
                    "installed — falling back to UNENCRYPTED sqlite3. Install "
                    "pysqlcipher3 to enable at-rest encryption."
                )
                conn = sqlite3.connect(self._db_path, check_same_thread=False)
        else:
            conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # PRAGMAs are idempotent on existing DBs. journal_mode=WAL is
        # sticky in the DB header but harmless to re-set per connection
        # at pool fill time.
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA busy_timeout=5000")
            # v2.43 (Sprint 0.7 quick win, zero-risk per database-reviewer
            # audit): negative cache_size = "KiB", so -8000 = 8 MiB page
            # cache per connection. With pool size 6 that's 48 MiB
            # steady-state — fine on any modern host. temp_store=MEMORY
            # keeps intermediate FTS5 / ORDER BY tmps off disk. Both are
            # idempotent and SQLCipher-compatible.
            conn.execute("PRAGMA cache_size=-8000")
            conn.execute("PRAGMA temp_store=MEMORY")
        except sqlite3.DatabaseError as e:
            logger.debug("sqlite pool pragma setup partial: %s", e)
        return conn

    @contextmanager
    def _connect(self):
        """Check out a connection from the pool; create one if empty.

        H2 (2026-05-20): pooled connections. F2 found seq P95 = 94ms
        with no LLM cost, dominated by `sqlite3.connect()` per query.
        H1 added WAL pragmas and made it worse (PRAGMA per-connect
        cost). H2 amortizes both: pool of {_POOL_SIZE} long-lived
        connections, PRAGMA setup once per connection at creation.
        """
        try:
            conn = self._pool.get_nowait()
        except _queue.Empty:
            conn = self._make_pooled_connection()
        try:
            yield conn
        except Exception:
            # Caller raised mid-transaction — roll back so we don't
            # poison the pool with half-committed state.
            try:
                if conn.in_transaction:
                    conn.rollback()
            except sqlite3.DatabaseError:
                pass
            raise
        finally:
            # Defensive: any open transaction at clean exit means a
            # caller forgot to commit. Rollback rather than persist
            # incomplete writes silently. (Writers in this codebase
            # commit explicitly — this guard only fires on bugs.)
            try:
                if conn.in_transaction:
                    conn.rollback()
            except sqlite3.DatabaseError:
                pass
            try:
                self._pool.put_nowait(conn)
            except _queue.Full:
                # Excess connection (created above the pool cap during
                # a contention spike). Close it rather than block.
                try:
                    conn.close()
                except sqlite3.DatabaseError:
                    pass

    def _init_db(self) -> None:
        with self._connect() as conn:
            # Round H1 finding (2026-05-20): we evaluated WAL mode here.
            # On THIS codebase's connection-per-query pattern, both WAL
            # (sticky at init) AND PRAGMA-per-connect made the chat
            # latency benchmark slower by 25-46%. The real bottleneck
            # is fresh `sqlite3.connect()` per SQL statement, not the
            # journal mode. Connection pooling would help — out of
            # scope for this round. Leaving default rollback journal.
            # See PROJECT_STATE §15 H1 entry for the full measurement.
            conn.execute("""
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY, level TEXT NOT NULL, content TEXT NOT NULL,
                    source TEXT DEFAULT '', session_id TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT, metadata TEXT DEFAULT '{}', embedding TEXT, access_count INTEGER DEFAULT 0
                )
            """)
            conn.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                    content, source, session_id, content='memories', content_rowid='rowid'
                )
            """)
            conn.execute("""
                CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
                    INSERT INTO memories_fts(rowid, content, source, session_id) VALUES (new.rowid, new.content, new.source, new.session_id);
                END
            """)
            conn.execute("""
                CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
                    INSERT INTO memories_fts(memories_fts, rowid, content, source, session_id) VALUES ('delete', old.rowid, old.content, old.source, old.session_id);
                END
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS entities (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
                    description TEXT, mention_count INTEGER DEFAULT 1,
                    created_at TEXT NOT NULL, updated_at TEXT
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS facts (
                    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, predicate TEXT NOT NULL,
                    object_value TEXT NOT NULL, confidence REAL DEFAULT 1.0, created_at TEXT NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS skills (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
                    trigger_pattern TEXT, template TEXT, success_count INTEGER DEFAULT 0,
                    failure_count INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS vectors (
                    id TEXT PRIMARY KEY, memory_id TEXT, vector TEXT, dim INTEGER,
                    vector_blob BLOB, created_at TEXT NOT NULL
                )
            """)
            # Migrate old JSON vectors to BLOB if needed
            try:
                rows = conn.execute("SELECT id, vector FROM vectors WHERE vector_blob IS NULL AND vector IS NOT NULL").fetchall()
                for row in rows:
                    vec = json.loads(row["vector"])
                    blob = np.array(vec, dtype=np.float32).tobytes()
                    conn.execute("UPDATE vectors SET vector_blob = ?, dim = ? WHERE id = ?",
                                 (blob, len(vec), row["id"]))
                if rows:
                    conn.commit()
                    logger.info(f"[memory] Migrated {len(rows)} old JSON vectors to BLOB")
            except Exception as e:
                logger.debug(f"[memory] Vector migration skipped: {e}")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_level ON memories(level)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_vectors_memory ON vectors(memory_id)")
            # TTL / archive support
            try:
                conn.execute("ALTER TABLE memories ADD COLUMN ttl_days INTEGER DEFAULT NULL")
            except sqlite3.OperationalError:
                pass  # Column already exists
            try:
                conn.execute("ALTER TABLE memories ADD COLUMN archived INTEGER DEFAULT 0")
            except sqlite3.OperationalError:
                pass  # Column already exists
            # M-Memory-1 migration: importance + decay + provenance + conflict
            # All idempotent (catch duplicate-column). Defaults chosen so that
            # rows created before the migration still behave sensibly:
            #   - importance defaults to 0.5 (mid-range; was effectively None before)
            #   - last_accessed_at defaults to created_at via UPDATE below
            #   - is_current defaults to 1 (everything pre-migration is "current")
            for col_sql in (
                "ALTER TABLE memories ADD COLUMN importance REAL DEFAULT 0.5",
                "ALTER TABLE memories ADD COLUMN last_accessed_at TEXT",
                "ALTER TABLE memories ADD COLUMN provenance_source TEXT",
                "ALTER TABLE memories ADD COLUMN provenance_refs TEXT DEFAULT '[]'",
                "ALTER TABLE memories ADD COLUMN superseded_by TEXT",
                "ALTER TABLE memories ADD COLUMN conflict_group TEXT",
                "ALTER TABLE memories ADD COLUMN is_current INTEGER DEFAULT 1",
            ):
                try:
                    conn.execute(col_sql)
                except sqlite3.OperationalError:
                    pass  # Column already exists
            # Backfill last_accessed_at for pre-migration rows so decay math
            # doesn't see NULL and crash. Use created_at as the seed.
            try:
                conn.execute(
                    "UPDATE memories SET last_accessed_at = created_at "
                    "WHERE last_accessed_at IS NULL"
                )
            except sqlite3.OperationalError:
                pass
            conn.execute("""
                CREATE TABLE IF NOT EXISTS memories_archive (
                    id TEXT PRIMARY KEY, level TEXT NOT NULL, content TEXT NOT NULL,
                    source TEXT DEFAULT '', session_id TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT, metadata TEXT DEFAULT '{}', embedding TEXT,
                    archived_at TEXT NOT NULL
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived)")

    # ========== Vector Index (In-memory ANN) ==========
    def _load_vector_index(self) -> None:
        """Load all vectors from DB into memory index."""
        try:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT memory_id, vector_blob, dim FROM vectors WHERE vector_blob IS NOT NULL ORDER BY created_at"
                ).fetchall()
            if not rows:
                return
            ids = []
            vectors = []
            for row in rows:
                vec = np.frombuffer(row["vector_blob"], dtype=np.float32)
                if len(vec) == row["dim"]:
                    ids.append(row["memory_id"])
                    vectors.append(vec)
            if not vectors:
                return
            self._vector_ids = ids
            self._vector_matrix = np.vstack(vectors).astype(np.float32)
            self._ann_dirty = True
            self._build_ann_index()
            logger.info(f"[memory] Loaded {len(ids)} vectors into ANN index, dim={vectors[0].shape[0]}")
        except Exception as e:
            logger.warning(f"[memory] Failed to load vector index: {e}")

    def _build_ann_index(self) -> None:
        """Build or rebuild sklearn NearestNeighbors BallTree index."""
        if not self._ann_dirty or self._vector_matrix is None or len(self._vector_ids) < 10:
            return
        try:
            from sklearn.neighbors import NearestNeighbors
            # BallTree supports cosine via 'haversine' hack or brute in high-dim
            # For cosine similarity, we use 'brute' with cosine metric for accuracy
            # or normalize vectors and use 'euclidean' with BallTree for speed
            n_neighbors = min(64, len(self._vector_ids))
            self._ann_index = NearestNeighbors(
                n_neighbors=n_neighbors,
                metric="cosine",
                algorithm="brute",  # brute is fast enough for <100K vectors with numpy
            )
            self._ann_index.fit(self._vector_matrix)
            self._ann_dirty = False
            logger.info(f"[memory] ANN index built: {len(self._vector_ids)} vectors")
        except Exception as e:
            logger.warning(f"[memory] ANN index build failed: {e}")
            self._ann_index = None

    def _add_to_index(self, memory_id: str, vector: List[float]) -> None:
        """Add a single vector to the in-memory index."""
        vec = np.array(vector, dtype=np.float32)
        self._vector_ids.append(memory_id)
        if self._vector_matrix is None:
            self._vector_matrix = vec.reshape(1, -1)
        else:
            self._vector_matrix = np.vstack([self._vector_matrix, vec])
        self._ann_dirty = True
        # Rebuild index periodically (every 50 new vectors)
        if len(self._vector_ids) % 50 == 0:
            self._build_ann_index()

    # ========== L1-L4 CRUD ==========
    async def store(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Store a memory entry.

        Beyond the original fields, M-Memory-1 accepts:
          - importance: 0.0-1.0, defaults per-level (see DEFAULT_IMPORTANCE_BY_LEVEL)
          - provenance_source: free-form label ("chat", "channel:tg",
            "consolidation_l1_l2", "fact_extraction_l2_l3", "promotion_l3_l4")
          - provenance_refs: list of source memory IDs this entry was derived from
        These get persisted on every chunk produced by the chunker so lineage
        survives chunking.
        """
        mem_id = str(uuid.uuid4())
        level = data.get("level", "L1")
        content = data.get("content", "")
        source = data.get("source", "")
        session_id = data.get("session_id", "")
        now = datetime.now(timezone.utc).isoformat()

        # M-Memory-1 new fields
        raw_importance = data.get("importance")
        if raw_importance is None:
            importance = DEFAULT_IMPORTANCE_BY_LEVEL.get(level, 0.5)
        else:
            try:
                importance = max(0.0, min(1.0, float(raw_importance)))
            except (TypeError, ValueError):
                importance = DEFAULT_IMPORTANCE_BY_LEVEL.get(level, 0.5)
        provenance_source = data.get("provenance_source") or ""
        raw_refs = data.get("provenance_refs") or []
        if not isinstance(raw_refs, list):
            raw_refs = []
        provenance_refs_json = json.dumps([str(r) for r in raw_refs])

        # Smart chunking for long content
        chunks = self._chunk_text(content)
        stored_ids = []

        with self._connect() as conn:
            if len(chunks) <= 1:
                # Single chunk — store as-is
                conn.execute(
                    """INSERT INTO memories
                       (id, level, content, source, session_id, created_at,
                        importance, last_accessed_at, provenance_source, provenance_refs)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (mem_id, level, content, source, session_id, now,
                     importance, now, provenance_source, provenance_refs_json),
                )
                stored_ids.append(mem_id)
            else:
                # Multiple chunks — store each with chunk metadata. All chunks
                # share the same importance + provenance — they're the same
                # logical memory, just sliced.
                for i, chunk in enumerate(chunks):
                    cid = str(uuid.uuid4()) if i > 0 else mem_id
                    meta = json.dumps({"chunk_index": i, "total_chunks": len(chunks), "parent_id": mem_id})
                    conn.execute(
                        """INSERT INTO memories
                           (id, level, content, source, session_id, created_at, metadata,
                            importance, last_accessed_at, provenance_source, provenance_refs)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (cid, level, chunk, source, session_id, now, meta,
                         importance, now, provenance_source, provenance_refs_json),
                    )
                    stored_ids.append(cid)
            conn.commit()

        # Auto-extract semantic info for L2+ and L3
        if level in ("L2", "L3") and len(content) > 10:
            await self.extract_semantic(content)

        # Generate embeddings.
        # M-Memory-1: L1 now gets embeddings by default — SQLite FTS5's
        # default tokenizer does not segment CJK text, so vector search is
        # the ONLY way Chinese chat history is retrievable. Cost is one
        # local sentence-transformers call per chunk (~5-10ms on CPU for
        # the multilingual MiniLM).  Heavy-write deployments can opt out
        # via WEBRAIN_MEMORY_EMBED_L1=0.
        import os as _os
        embed_l1 = _os.environ.get("WEBRAIN_MEMORY_EMBED_L1", "1") != "0"
        levels_to_embed = {"L2", "L3", "L4"}
        if embed_l1:
            levels_to_embed.add("L1")
        if level in levels_to_embed:
            for sid, chunk in zip(stored_ids, chunks):
                await self._store_embedding(sid, chunk)

        # M-Memory-1: contradiction check on L3 only. Runs AFTER persistence
        # + embedding generation so the detector can use the live vector
        # index. The new memory is already addressable; any conflict mark
        # is applied as a follow-up UPDATE, never blocking the return value.
        conflict_result: Optional[Dict[str, Any]] = None
        if level == "L3" and self._conflict_detector is not None and content.strip():
            try:
                conflict_result = await self._conflict_detector.detect_and_mark(
                    self, mem_id, content,
                )
            except Exception as e:
                # Detection is best-effort — never sabotage a store() that
                # otherwise succeeded.
                logger.warning("conflict detector failed (non-fatal): %s", e)
                conflict_result = None

        ret: Dict[str, Any] = {
            "id": mem_id,
            "level": level,
            "stored": True,
            "chunks": len(stored_ids),
            "importance": importance,
            "provenance_source": provenance_source,
        }
        if conflict_result is not None:
            ret["conflict"] = conflict_result
        return ret

    # ========== Advanced Query: Hybrid Search + Re-ranking ==========
    async def query(self, query_data: Dict[str, Any], hyde_doc: Optional[str] = None) -> List[Dict[str, Any]]:
        q = query_data.get("query", "")
        levels = query_data.get("levels", ["L1", "L2", "L3"])
        limit = query_data.get("limit", 10)
        use_vector = query_data.get("use_vector", True)
        use_rerank = query_data.get("use_rerank", True)
        top_k = query_data.get("top_k", limit * 3)  # Retrieve more for re-ranking

        if not q.strip():
            return []

        # Phase 1: Retrieve candidates from multiple sources
        fts_results = await self._fts_search(q, levels, top_k)
        vec_results = []
        if use_vector:
            vec_results = await self._vector_search(
                q, top_k,
                exclude_ids=[r["id"] for r in fts_results],
                levels=levels,  # honor caller's level scope in BOTH sources
                **({"embed_text": hyde_doc} if hyde_doc else {}),  # HyDE：用假设文档向量代替原始查询向量
            )

        # Phase 2: Hybrid fusion (RRF) — annotates each row with rrf_score
        fused = self._rrf_fuse([fts_results, vec_results], k=60)

        # Phase 3: Re-ranking (if enabled and available) — annotates rerank_score
        # on each row. We keep a larger pool here (top_k, not limit) so the
        # importance blender has enough candidates to re-order; final truncation
        # happens in phase 4.
        if use_rerank and len(fused) > 1:
            fused = await self._rerank(q, fused, limit=top_k)

        # Phase 4 (M-Memory-1): blend textual relevance with decayed importance.
        # Memories with high importance survive against fresher but weaker
        # matches; never-recalled memories naturally fade as their decay grows.
        # _blend_with_importance also truncates to `limit`.
        fused = self._blend_with_importance(fused, limit=limit)

        # Increment access count + reset last_accessed_at + bump importance.
        # Order matters: blender ran on PRE-bump state so this query's results
        # don't influence their own ranking via the boost they just earned.
        self._increment_access([r["id"] for r in fused])

        # User-trial #2: the rows we return still hold the PRE-bump values
        # because we fetched them before _increment_access. Reflect the
        # bump in the returned payload so callers don't see "access_count=0"
        # right after retrieving a row. Pure in-memory mutation — the DB
        # has already been updated by _increment_access. No second query.
        now_iso = datetime.now(timezone.utc).isoformat()
        for r in fused:
            r["access_count"] = (r.get("access_count") or 0) + 1
            r["last_accessed_at"] = now_iso

        return fused

    # ========== FTS5 Search ==========
    async def _fts_search(self, query: str, levels: List[str], limit: int) -> List[Dict]:
        try:
            with self._connect() as conn:
                placeholders = ",".join(["?"] * len(levels))
                # FTS5 syntax safety. The bare user query can contain
                # characters FTS5 parses specially:
                #   `-` → negation (so "abc-def" means "abc AND NOT def")
                #   `:` → column qualifier (so "level:L1" tries column "level")
                #   `(` `)` `*` → grouping / prefix wildcard
                # The 2026-05-20 freshness test caught this: querying
                # "unique-l1-token-xyz123" produced
                #   FTS search failed: no such column: l1
                # because "-l1-" was parsed as a NOT-clause on column l1.
                # Fix: wrap each whitespace-delimited token in a phrase
                # quote so FTS5 treats it as a literal. Preserves the
                # implicit AND across tokens that two-word queries rely
                # on (e.g. "apples oranges" → `"apples" "oranges"`).
                safe_query = _build_fts5_safe_query(query)
                if not safe_query:
                    return []
                rows = conn.execute(
                    f"""SELECT m.*, rank as fts_rank FROM memories m
                        JOIN memories_fts fts ON m.rowid = fts.rowid
                        WHERE memories_fts MATCH ? AND m.level IN ({placeholders})
                        ORDER BY rank LIMIT ?""",
                    (safe_query, *levels, limit),
                ).fetchall()
                return [dict(r) for r in rows]
        except Exception as e:
            logger.warning(f"FTS search failed: {e}")
            return []

    # ========== Vector Search ==========
    async def _vector_search(
        self,
        query: str,
        limit: int,
        exclude_ids: Optional[List[str]] = None,
        levels: Optional[List[str]] = None,
        embed_text: Optional[str] = None,  # HyDE：若提供则用此文本生成向量，FTS 仍使用原始 query
    ) -> List[Dict]:
        """Vector search using in-memory ANN index (BallTree/brute) with numpy.

        levels: when provided, results are filtered to rows whose `level`
        is in the set. Previously _vector_search ignored the level filter
        entirely — only _fts_search honored it — so a query for L2-only
        could return L1 rows via the vector path, leaking lower-level
        noise into the result. Discovered by the dreaming smoke test
        2026-05-20: an L2 query returned an L1 row with empty
        provenance_refs (because L1 doesn't have provenance), breaking
        lineage assertions.
        """
        try:
            query_vec = await self._get_embedding(embed_text if embed_text else query)  # HyDE：优先使用假设文档
            exclude_ids = set(exclude_ids or [])
            level_filter = set(levels) if levels else None
            qvec = np.array(query_vec, dtype=np.float32)

            def _apply_level_filter(rows: List[Dict]) -> List[Dict]:
                if level_filter is None:
                    return rows
                return [r for r in rows if r.get("level") in level_filter]

            # Fast path: ANN index search
            if self._ann_index is not None and not self._ann_dirty and len(self._vector_ids) >= 10:
                try:
                    # Pull MORE candidates than `limit` when level_filter is
                    # active, since post-filtering may drop matches. 4x is
                    # arbitrary but covers the case where the index has many
                    # L1 rows competing with few L2/L3 rows.
                    pool_mult = 8 if level_filter else 4
                    n_candidates = min(max(limit * pool_mult, 20), len(self._vector_ids))
                    distances, indices = self._ann_index.kneighbors(qvec.reshape(1, -1), n_neighbors=n_candidates)
                    matched_ids = []
                    matched_scores = []
                    for dist, idx in zip(distances[0], indices[0]):
                        mid = self._vector_ids[idx]
                        if mid in exclude_ids:
                            continue
                        matched_ids.append(mid)
                        matched_scores.append(1.0 - dist)  # cosine distance → similarity
                    # Fetch full memory records
                    with self._connect() as conn:
                        placeholders = ",".join(["?"] * len(matched_ids)) if matched_ids else "''"
                        rows = conn.execute(
                            f"SELECT m.* FROM memories m WHERE m.id IN ({self._in_placeholders(len(matched_ids))})",
                            tuple(matched_ids),
                        ).fetchall()
                    id_to_row = {r["id"]: dict(r) for r in rows}
                    results = []
                    for mid, score in zip(matched_ids, matched_scores):
                        if mid in id_to_row:
                            item = id_to_row[mid]
                            item["vector_score"] = score
                            results.append(item)
                    return _apply_level_filter(results)[:limit]
                except Exception as e:
                    logger.debug(f"ANN search failed, falling back to brute force: {e}")

            # Fallback: brute-force with numpy batch computation (still much faster than JSON loop)
            if self._vector_matrix is not None and len(self._vector_ids) > 0:
                # Batch cosine similarity: (query · matrix) / (|query| * |matrix|)
                qnorm = np.linalg.norm(qvec) or 1.0
                mnorms = np.linalg.norm(self._vector_matrix, axis=1)
                mnorms[mnorms == 0] = 1.0
                dots = self._vector_matrix.dot(qvec)
                sims = dots / (mnorms * qnorm)
                # Sort by similarity
                top_idx = np.argsort(sims)[::-1]
                matched_ids = []
                matched_scores = []
                # Pull extras for the same reason as ANN path
                target = limit * (8 if level_filter else 1)
                for idx in top_idx:
                    mid = self._vector_ids[idx]
                    if mid in exclude_ids:
                        continue
                    matched_ids.append(mid)
                    matched_scores.append(float(sims[idx]))
                    if len(matched_ids) >= target:
                        break
                if matched_ids:
                    with self._connect() as conn:
                        placeholders = ",".join(["?"] * len(matched_ids))
                        rows = conn.execute(
                            f"SELECT m.* FROM memories m WHERE m.id IN ({self._in_placeholders(len(matched_ids))})",
                            tuple(matched_ids),
                        ).fetchall()
                    id_to_row = {r["id"]: dict(r) for r in rows}
                    results = []
                    for mid, score in zip(matched_ids, matched_scores):
                        if mid in id_to_row:
                            item = id_to_row[mid]
                            item["vector_score"] = score
                            results.append(item)
                    return _apply_level_filter(results)[:limit]

            # Ultimate fallback: old DB scan (for backward compat or empty index)
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT v.*, m.* FROM vectors v JOIN memories m ON v.memory_id = m.id"
                ).fetchall()
            scored = []
            for row in rows:
                if row["memory_id"] in exclude_ids:
                    continue
                vec_json = row.get("vector")
                if not vec_json:
                    continue
                vec = json.loads(vec_json)
                sim = self._cosine_similarity(query_vec, vec)
                item = dict(row)
                item["vector_score"] = sim
                scored.append((sim, item))
            scored.sort(key=lambda x: x[0], reverse=True)
            filtered = _apply_level_filter([item[1] for item in scored])
            return filtered[:limit]
        except Exception as e:
            logger.warning(f"Vector search failed: {e}")
            return []

    # ========== RRF Fusion ==========
    def _rrf_fuse(self, result_lists: List[List[Dict]], k: int = 60) -> List[Dict]:
        """Reciprocal Rank Fusion across multiple result lists.

        Annotates each surviving item with `rrf_score` so the downstream
        blender (M-Memory-1) can normalise + combine with importance.
        """
        scores: Dict[str, float] = {}
        items: Dict[str, Dict] = {}

        for results in result_lists:
            for rank, item in enumerate(results):
                item_id = item["id"]
                items[item_id] = item
                scores[item_id] = scores.get(item_id, 0.0) + 1.0 / (k + rank + 1)

        # Sort by fused score descending and attach the score on each item
        fused = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        out: List[Dict] = []
        for iid, sc in fused:
            row = dict(items[iid])
            row["rrf_score"] = sc
            out.append(row)
        return out

    # ========== Importance Blending (M-Memory-1) ==========
    def _blend_with_importance(
        self,
        candidates: List[Dict],
        limit: int,
        now: Optional[datetime] = None,
    ) -> List[Dict]:
        """Blend textual relevance with decayed importance, re-sort, truncate.

        Each candidate must already carry a relevance score under either
        `rerank_score` (when re-ranking ran) or `rrf_score` (when it didn't).
        We min-max normalize within the candidate set so the score lives in
        [0, 1] regardless of source — RRF scores cluster near 0, cross-encoder
        scores can be negative. Then:

            final_score = relevance_norm * RELEVANCE_WEIGHT
                        + effective_importance * IMPORTANCE_WEIGHT

        The blender annotates each item with `effective_importance` and
        `final_score` for debugging + frontend display.

        Empty / singleton candidate lists are returned untouched (no blend
        to do — nothing to compare against).
        """
        if not candidates:
            return []
        if len(candidates) == 1:
            row = dict(candidates[0])
            row.setdefault("effective_importance", effective_importance(
                row.get("importance", 0.5), row.get("level", "L1"),
                row.get("last_accessed_at"), now=now,
            ))
            row.setdefault("final_score", row["effective_importance"])
            return [row]

        # Pick the relevance source per item — rerank wins when present
        def _relevance(c: Dict) -> float:
            if "rerank_score" in c:
                return float(c["rerank_score"])
            return float(c.get("rrf_score", 0.0))

        rels = [_relevance(c) for c in candidates]
        r_min, r_max = min(rels), max(rels)
        spread = r_max - r_min
        # If every candidate has the same score, normalised value is 0.5
        # (a neutral choice — pushes importance to break the tie).
        def _normalize(r: float) -> float:
            if spread <= 1e-9:
                return 0.5
            return (r - r_min) / spread

        # Re-resolve weights from env on every blend so the grid-search
        # benchmark (Round B3) can sweep without restarting the process.
        # Cost: two env lookups per query — negligible vs. the embedding
        # work that already happened upstream.
        rel_w, imp_w = _resolve_blender_weights()

        blended: List[Dict] = []
        for c, r in zip(candidates, rels):
            row = dict(c)
            eff = effective_importance(
                row.get("importance", 0.5),
                row.get("level", "L1"),
                row.get("last_accessed_at"),
                now=now,
            )
            final = _normalize(r) * rel_w + eff * imp_w
            row["effective_importance"] = eff
            row["final_score"] = final
            blended.append(row)

        blended.sort(key=lambda x: x["final_score"], reverse=True)
        return blended[:limit]

    # ========== Re-ranking ==========
    async def _rerank(self, query: str, candidates: List[Dict], limit: int = 10) -> List[Dict]:
        """Cross-encoder re-ranking of candidates.

        Round E1 fix: both `_get_reranker()` cold load (~10-30s for the
        ~100 MB model) and `reranker.predict(pairs)` (CPU-bound torch
        inference) used to run directly on the asyncio event loop,
        blocking every other coroutine — including chat streams and
        health pings — for their duration. Now both are off-loaded to
        the default thread executor so the loop stays responsive.
        """
        loop = asyncio.get_running_loop()
        # v2.44a — route through self._ml_executor when set (prod), else
        # fall back to default pool (tests / direct construction). The
        # named pool isolates CPU-bound rerank from SQLite IO so they
        # don't contend for default-pool slots under concurrent load.
        ex = self._ml_executor
        # Off-load the (potentially cold) model load to a thread —
        # _get_reranker is internally thread-safe via the double-checked
        # lock above.
        reranker = await loop.run_in_executor(ex, _get_reranker)
        if reranker is None or len(candidates) == 0:
            return candidates[:limit]

        try:
            pairs = [(query, c.get("content", "")[:512]) for c in candidates]
            # Predict is the CPU-bound bit — off-load it too.
            scores = await loop.run_in_executor(ex, reranker.predict, pairs)

            scored = []
            for cand, score in zip(candidates, scores):
                cand = dict(cand)
                cand["rerank_score"] = float(score)
                scored.append(cand)

            scored.sort(key=lambda x: x["rerank_score"], reverse=True)
            return scored[:limit]
        except Exception as e:
            logger.warning(f"Re-ranking failed: {e}")
            return candidates[:limit]

    # ========== Chunking ==========
    def _chunk_text(self, text: str, max_chunk_size: int = 800, overlap: int = 100) -> List[str]:
        """Smart semantic chunking by paragraphs with overlap."""
        if len(text) <= max_chunk_size:
            return [text]

        # Split by paragraphs
        paragraphs = re.split(r'\n\s*\n', text.strip())
        chunks = []
        current_chunk = ""

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            if len(current_chunk) + len(para) + 2 <= max_chunk_size:
                current_chunk += ("\n\n" if current_chunk else "") + para
            else:
                if current_chunk:
                    chunks.append(current_chunk)
                # If single paragraph is too long, split by sentences
                if len(para) > max_chunk_size:
                    sentences = re.split(r'(?<=[。！？.!?])\s+', para)
                    current_chunk = ""
                    for sent in sentences:
                        if len(current_chunk) + len(sent) + 1 <= max_chunk_size:
                            current_chunk += (" " if current_chunk else "") + sent
                        else:
                            if current_chunk:
                                chunks.append(current_chunk)
                            current_chunk = sent
                else:
                    current_chunk = para

        if current_chunk:
            chunks.append(current_chunk)

        # Add overlap between chunks
        if len(chunks) > 1 and overlap > 0:
            overlapped = []
            for i, chunk in enumerate(chunks):
                if i > 0:
                    prev_tail = chunks[i - 1][-overlap:]
                    chunk = prev_tail + "\n" + chunk
                overlapped.append(chunk)
            return overlapped

        return chunks

    # ========== Access Tracking + Reinforcement (M-Memory-1) ==========
    def _increment_access(self, ids: List[str]) -> None:
        """Called by query() after retrieval. Updates three signals:

          1. access_count — raw retrieval counter (used in stats)
          2. last_accessed_at — resets the decay clock for forgetting curve
          3. importance — bumped by RETRIEVAL_BOOST (capped at 1.0) so
             repeatedly-recalled memories climb the ranking

        SQL uses MIN(1.0, importance + boost) for the cap. We do this in
        one statement per call (small N) rather than per-memory.
        """
        if not ids:
            return
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            placeholders = ",".join(["?"] * len(ids))
            conn.execute(
                f"""UPDATE memories
                    SET access_count = access_count + 1,
                        last_accessed_at = ?,
                        importance = MIN(1.0, COALESCE(importance, 0.5) + ?)
                    WHERE id IN ({placeholders})""",
                (now, RETRIEVAL_BOOST, *ids),
            )
            conn.commit()

    # ========== Recent / Stats ==========
    async def get_recent(self, level: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            if level:
                rows = conn.execute(
                    "SELECT * FROM memories WHERE level = ? ORDER BY created_at DESC LIMIT ?",
                    (level, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM memories ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]

    async def get_top_l4(self, limit: int = 2) -> List[Dict[str, Any]]:
        """S13: 按 importance 降序返回前 K 条非归档的 L4 记忆。

        L4 是高频 L3 事实晋升的长期身份层（importance=0.9 基准），
        用于 ChatEngine 的 _get_l4_anchors() 强制注入机制。
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT * FROM memories
                   WHERE level = 'L4' AND (archived IS NULL OR archived = 0)
                   ORDER BY importance DESC, access_count DESC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    async def get_skills(self, limit: int = 100) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM skills LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    # ========== NLP Semantic Extraction (via LLM) ==========
    async def extract_semantic(self, text: str) -> Dict[str, Any]:
        try:
            prompt = f"""从以下文本中提取实体和事实。以JSON格式返回：
{{"entities": [{{"name": "实体名", "type": "PERSON/ORG/LOCATION/TECH/OTHER", "description": "描述"}}],
 "facts": [{{"subject": "主语", "predicate": "谓语", "object": "宾语"}}]}}

文本：{text}"""

            result = await self._llm_call([
                {"role": "system", "content": "你是一个信息提取专家。"},
                {"role": "user", "content": prompt},
            ], max_tokens=1024)

            content = result["choices"][0]["message"]["content"]
            json_str = content
            if "```json" in content:
                json_str = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                json_str = content.split("```")[1].split("```")[0].strip()

            parsed = json.loads(json_str)
            entities = parsed.get("entities", [])
            facts = parsed.get("facts", [])

            stored_entities = 0
            with self._connect() as conn:
                for ent in entities:
                    eid = str(uuid.uuid4())
                    conn.execute(
                        "INSERT INTO entities (id, name, type, description, created_at) VALUES (?, ?, ?, ?, ?)",
                        (eid, ent.get("name", ""), ent.get("type", "OTHER"), ent.get("description", ""), datetime.now(timezone.utc).isoformat()),
                    )
                    stored_entities += 1
                conn.commit()

            stored_facts = 0
            with self._connect() as conn:
                for fact in facts:
                    entity_name = fact.get("subject", "")
                    row = conn.execute("SELECT id FROM entities WHERE name = ?", (entity_name,)).fetchone()
                    entity_id = row["id"] if row else str(uuid.uuid4())
                    if not row:
                        conn.execute(
                            "INSERT INTO entities (id, name, type, created_at) VALUES (?, ?, ?, ?)",
                            (entity_id, entity_name, "OTHER", datetime.now(timezone.utc).isoformat()),
                        )
                    conn.execute(
                        "INSERT INTO facts (id, entity_id, predicate, object_value, created_at) VALUES (?, ?, ?, ?, ?)",
                        (str(uuid.uuid4()), entity_id, fact.get("predicate", ""), fact.get("object", ""), datetime.now(timezone.utc).isoformat()),
                    )
                    stored_facts += 1
                conn.commit()

            return {"extracted": stored_entities + stored_facts, "entities": entities, "facts": facts}
        except Exception as e:
            logger.error(f"Semantic extraction failed: {e}")
            return {"extracted": 0, "entities": [], "facts": [], "error": str(e)}

    async def get_entities(self, entity_type: Optional[str] = None, limit: int = 50) -> List[Dict]:
        with self._connect() as conn:
            if entity_type:
                rows = conn.execute("SELECT * FROM entities WHERE type = ? LIMIT ?", (entity_type, limit)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM entities LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    # ========== Vector Embeddings ==========
    async def _store_embedding(self, memory_id: str, text: str) -> None:
        try:
            vector = await self._get_embedding(text)
            vec_blob = np.array(vector, dtype=np.float32).tobytes()
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO vectors (id, memory_id, vector, vector_blob, dim, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), memory_id, json.dumps(vector), vec_blob, len(vector), datetime.now(timezone.utc).isoformat()),
                )
                conn.commit()
            # Update in-memory index
            self._add_to_index(memory_id, vector)
        except Exception as e:
            logger.warning(f"Embedding generation failed: {e}")

    def _load_embedding_providers(self) -> List[Dict]:
        """Load embedding provider configs from env / llm_config."""
        providers = []
        # 1. Ollama (local, preferred)
        ollama_url = self.llm_config.get("ollama_url") or "http://localhost:11434"
        if ollama_url:
            providers.append({
                "name": "ollama",
                "url": ollama_url.rstrip("/") + "/api/embeddings",
                "model": self.llm_config.get("ollama_embedding_model", "nomic-embed-text"),
                "headers": {},
                "payload_fmt": "ollama",
            })
        # 2. OpenAI-compatible API (cloud or local)
        base = self.llm_config.get("base_url", "").rstrip("/")
        if base:
            providers.append({
                "name": "openai-compatible",
                "url": base + "/embeddings",
                "model": self.llm_config.get("embedding_model", self.llm_config.get("model_id", "text-embedding-3-small")),
                "headers": {"Authorization": f"Bearer {self.llm_config.get('api_key', '')}"} if self.llm_config.get("api_key") else {},
                "payload_fmt": "openai",
            })
        # 3. Direct OpenAI
        openai_key = self.llm_config.get("openai_api_key") or self.llm_config.get("api_key")
        if openai_key:
            providers.append({
                "name": "openai",
                "url": "https://api.openai.com/v1/embeddings",
                "model": self.llm_config.get("openai_embedding_model", "text-embedding-3-small"),
                "headers": {"Authorization": f"Bearer {openai_key}"},
                "payload_fmt": "openai",
            })
        return providers

    async def _get_embedding(self, text: str) -> List[float]:
        """Try multiple embedding providers, fallback to local model, then hash."""
        # Try configured providers
        for provider in self._embedding_providers:
            try:
                vec = await self._call_embedding_provider(provider, text)
                if vec:
                    logger.debug(f"[embedding] {provider['name']} succeeded, dim={len(vec)}")
                    return vec
            except Exception as e:
                logger.debug(f"[embedding] {provider['name']} failed: {e}")
                continue

        # Try local sentence-transformers
        try:
            vec = await self._local_embedding(text)
            if vec:
                logger.info(f"[embedding] local sentence-transformers succeeded, dim={len(vec)}")
                return vec
        except Exception as e:
            logger.debug(f"[embedding] local model failed: {e}")

        # Last resort: hash-based deterministic fallback
        logger.warning("[embedding] All providers failed, using hash fallback")
        return self._fallback_embedding(text)

    async def _call_embedding_provider(self, provider: Dict, text: str) -> Optional[List[float]]:
        """Call a single embedding provider.

        Timeout dropped from 30s to 5s after the 2026-05-20 user trial:
        every store iterated unreachable providers in sequence, each
        burning the full 30s before falling through. 5s is enough for
        a healthy provider to respond from local LAN; anything slower
        is broken enough that we'd rather fall through faster. Tune via
        WEBRAIN_EMBEDDING_PROVIDER_TIMEOUT_S env var.
        """
        import os as _os
        try:
            _provider_timeout = float(_os.environ.get("WEBRAIN_EMBEDDING_PROVIDER_TIMEOUT_S", "5.0"))
        except ValueError:
            _provider_timeout = 5.0
        async with httpx.AsyncClient(timeout=_provider_timeout) as client:
            if provider["payload_fmt"] == "ollama":
                resp = await client.post(provider["url"], json={
                    "model": provider["model"],
                    "prompt": text,
                }, headers=provider["headers"])
                if resp.status_code == 200:
                    data = resp.json()
                    return data.get("embedding")
            elif provider["payload_fmt"] == "openai":
                resp = await client.post(provider["url"], json={
                    "model": provider["model"],
                    "input": text,
                }, headers=provider["headers"])
                if resp.status_code == 200:
                    data = resp.json()
                    emb = data.get("data", [{}])[0].get("embedding")
                    if emb:
                        return emb
        return None

    async def _local_embedding(self, text: str) -> Optional[List[float]]:
        """Use the cached sentence-transformers embedder (loaded once per process).

        See `_get_embedder` for the cache rationale. Encoding itself runs
        in the default executor so a sync CPU-bound encode doesn't block
        the FastAPI event loop.
        """
        model = _get_embedder()
        if model is None:
            return None
        try:
            # Round E1: get_running_loop is the correct call in async ctx
            loop = asyncio.get_running_loop()
            # v2.44a — route through self._ml_executor when injected.
            vec = await loop.run_in_executor(
                self._ml_executor, lambda: model.encode(text).tolist()
            )
            return vec
        except Exception:
            return None

    def _fallback_embedding(self, text: str, dim: int = 128) -> List[float]:
        vec = [0.0] * dim
        text = text.lower()
        for i in range(len(text) - 2):
            tri = text[i:i+3]
            h = hash(tri) % dim
            vec[h] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    def _cosine_similarity(self, a: List[float], b: List[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a)) or 1.0
        norm_b = math.sqrt(sum(x * x for x in b)) or 1.0
        return dot / (norm_a * norm_b)

    # ========== Context Compression ==========
    async def compress_context(self, messages: List[Dict], current_tokens: int) -> Dict[str, Any]:
        if len(messages) <= 4:
            return {"messages": messages, "original_tokens": current_tokens, "compressed_tokens": current_tokens, "compression_ratio": 0.0}

        preserved = [messages[0], messages[-1]]
        middle = messages[1:-1]
        summary = f"[摘要: {len(middle)} 条消息已压缩]"
        compressed = preserved[:1] + [{"role": "system", "content": summary}] + preserved[1:]
        return {"messages": compressed, "original_tokens": current_tokens, "compressed_tokens": len(compressed) * 50, "compression_ratio": 0.5}

    async def should_compress(self, current_tokens: int, threshold: int = 8000) -> bool:
        return current_tokens > threshold

    # ========== LLM Helper (Multi-endpoint aware) ==========
    async def _llm_call(self, messages: List[Dict], max_tokens: int = 1024) -> Dict[str, Any]:
        """Call LLM with multi-endpoint fallback support."""
        endpoints = self.llm_config.get("endpoints", [{
            "base_url": self.llm_config.get("base_url", "http://localhost:1234/v1"),
            "model_id": self.llm_config.get("model_id", "minimax/minimax-m2.7"),
            "api_key": self.llm_config.get("api_key"),
        }])

        last_error = None
        for ep in endpoints:
            base_url = ep.get("base_url", ep.get("baseUrl", "")).rstrip("/")
            model_id = ep.get("model_id", ep.get("modelId", "default"))
            api_key = ep.get("api_key", ep.get("apiKey"))

            url = f"{base_url}/chat/completions"
            payload = {
                "model": model_id,
                "messages": messages,
                "temperature": 0.3,
                "max_tokens": max_tokens,
            }
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    resp = await client.post(url, json=payload, headers=headers)
                    resp.raise_for_status()
                    return resp.json()
            except Exception as e:
                last_error = e
                logger.warning(f"LLM call failed for {base_url}: {e}, trying next endpoint...")
                continue

        raise RuntimeError(f"All LLM endpoints failed. Last error: {last_error}")

    # ========== Stats ==========
    async def get_stats(self) -> Dict[str, Any]:
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) as c FROM memories").fetchone()["c"]
            by_level = {}
            for row in conn.execute("SELECT level, COUNT(*) as c FROM memories GROUP BY level").fetchall():
                by_level[row["level"]] = row["c"]
            entity_count = conn.execute("SELECT COUNT(*) as c FROM entities").fetchone()["c"]
            fact_count = conn.execute("SELECT COUNT(*) as c FROM facts").fetchone()["c"]
            vector_count = conn.execute("SELECT COUNT(*) as c FROM vectors").fetchone()["c"]
            skill_count = conn.execute("SELECT COUNT(*) as c FROM skills").fetchone()["c"]
            archived = conn.execute("SELECT COUNT(*) as c FROM memories WHERE archived = 1").fetchone()["c"]
            return {"total": total, "by_level": by_level, "entities": entity_count, "facts": fact_count, "vectors": vector_count, "skills": skill_count, "archived": archived}

    # ========== TTL / Archive ==========

    async def archive_expired(self) -> Dict[str, Any]:
        """Archive memories whose ttl_days have expired."""
        now = datetime.now(timezone.utc)
        archived_count = 0

        with self._connect() as conn:
            # Find expired memories
            rows = conn.execute("""
                SELECT * FROM memories
                WHERE ttl_days IS NOT NULL
                  AND archived = 0
                  AND datetime(created_at, '+' || ttl_days || ' days') < datetime('now')
            """).fetchall()

            for row in rows:
                # Move to archive
                conn.execute("""
                    INSERT OR REPLACE INTO memories_archive
                    (id, level, content, source, session_id, created_at, updated_at, metadata, embedding, archived_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    row["id"], row["level"], row["content"], row["source"], row["session_id"],
                    row["created_at"], row["updated_at"], row["metadata"], row["embedding"],
                    now.isoformat(),
                ))
                # Delete from main + fts
                conn.execute("DELETE FROM memories WHERE id = ?", (row["id"],))
                archived_count += 1

            conn.commit()

        logger.info(f"[memory] Archived {archived_count} expired memories")
        return {"archived_count": archived_count}

    async def list_archived(self, limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM memories_archive ORDER BY archived_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            return [dict(r) for r in rows]

    async def restore_archived(self, memory_id: str) -> Dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM memories_archive WHERE id = ?", (memory_id,)).fetchone()
            if not row:
                return {"ok": False, "error": "Memory not found in archive"}

            conn.execute("""
                INSERT INTO memories (id, level, content, source, session_id, created_at, updated_at, metadata, embedding, archived)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """, (
                row["id"], row["level"], row["content"], row["source"], row["session_id"],
                row["created_at"], row["updated_at"], row["metadata"], row["embedding"],
            ))
            conn.execute("DELETE FROM memories_archive WHERE id = ?", (memory_id,))
            conn.commit()

        return {"ok": True, "restored_id": memory_id}

    async def delete(self, memory_id: str) -> Dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT id FROM memories WHERE id = ?", (memory_id,)).fetchone()
            if not row:
                return {"ok": False, "error": "Memory not found"}
            conn.execute("DELETE FROM vectors WHERE memory_id = ?", (memory_id,))
            conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
            conn.commit()
        return {"ok": True, "deleted_id": memory_id}

    async def get_session_memories(self, session_id: str, limit: int = 50) -> List[Dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM memories WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
                (session_id, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    # ========== M-Memory-1: conflict listing + manual resolution ==========

    async def list_conflicts(self) -> Dict[str, Any]:
        """Group all rows that share a non-null conflict_group into pairs/sets.

        Returns:
            {
              "groups": [
                {
                  "conflict_group": "<uuid>",
                  "memories": [<row dict>, <row dict>, ...],
                  "current_id": "<id of is_current=1 row>",
                },
                ...
              ]
            }

        Skips conflict groups where every member has is_current=1 — that's
        a malformed state that shouldn't happen but we don't surface it.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT * FROM memories
                   WHERE conflict_group IS NOT NULL AND conflict_group != ''
                   ORDER BY conflict_group, created_at DESC"""
            ).fetchall()

        groups: Dict[str, List[Dict[str, Any]]] = {}
        for row in rows:
            groups.setdefault(row["conflict_group"], []).append(dict(row))

        out: List[Dict[str, Any]] = []
        for cg, members in groups.items():
            current = next((m for m in members if m.get("is_current") == 1), None)
            out.append({
                "conflict_group": cg,
                "memories": members,
                "current_id": current["id"] if current else None,
            })
        return {"groups": out, "count": len(out)}

    async def mark_current(self, memory_id: str) -> Dict[str, Any]:
        """User-driven override: pick which row in a conflict group is current.

        Flips is_current to 1 on the named memory; sets is_current=0 on every
        other member of the same conflict_group. No-op if the memory has no
        conflict_group (return ok=False with explanation).
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT conflict_group FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
            if not row:
                return {"ok": False, "error": f"Memory {memory_id} not found"}
            cg = row["conflict_group"]
            if not cg:
                return {"ok": False, "error": "Memory is not part of a conflict group"}
            conn.execute(
                "UPDATE memories SET is_current = 0 WHERE conflict_group = ?", (cg,),
            )
            conn.execute(
                "UPDATE memories SET is_current = 1 WHERE id = ?", (memory_id,),
            )
            conn.commit()
        return {"ok": True, "current_id": memory_id, "conflict_group": cg}

    # ========== M-Memory-1: provenance lineage walk ==========

    async def get_with_lineage(self, memory_id: str) -> Dict[str, Any]:
        """Fetch a memory + one-level provenance lineage.

        Returns:
            {
              "memory": <row dict>,
              "sources": [<row dict>, ...],   # one-level ancestors via provenance_refs
              "supersedes": <row dict | None>, # what this row replaced (L1→L2)
              "superseded_by": <row dict | None>, # what replaced this row (L1 perspective)
            }

        We walk exactly ONE level. Deeper lineage (L4 → L3 → L2 → L1) would
        require recursion + cycle guards; the v1 UI only renders one level.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
            if not row:
                return {"ok": False, "error": f"Memory {memory_id} not found"}
            mem = dict(row)

            # Sources: rows named in this memory's provenance_refs
            try:
                refs = json.loads(mem.get("provenance_refs") or "[]")
            except (ValueError, TypeError):
                refs = []
            sources: List[Dict[str, Any]] = []
            if refs:
                placeholders = ",".join(["?"] * len(refs))
                src_rows = conn.execute(
                    f"SELECT * FROM memories WHERE id IN ({placeholders})",
                    tuple(refs),
                ).fetchall()
                sources = [dict(r) for r in src_rows]

            # supersedes: what THIS memory replaced (when level == L2,
            # we can find L1s whose superseded_by == memory_id)
            supersedes_rows = conn.execute(
                "SELECT * FROM memories WHERE superseded_by = ? LIMIT 50",
                (memory_id,),
            ).fetchall()
            supersedes = [dict(r) for r in supersedes_rows] if supersedes_rows else []

            # superseded_by: the L2 that replaced this memory
            superseded_by_row = None
            if mem.get("superseded_by"):
                sb = conn.execute(
                    "SELECT * FROM memories WHERE id = ?", (mem["superseded_by"],),
                ).fetchone()
                if sb:
                    superseded_by_row = dict(sb)

        return {
            "ok": True,
            "memory": mem,
            "sources": sources,
            "supersedes": supersedes,
            "superseded_by": superseded_by_row,
        }

    async def get_knowledge_context(self, query: str, session_id: Optional[str] = None) -> Dict[str, Any]:
        """Get combined L3+L4 knowledge context for a query."""
        memories = await self.query({"query": query, "levels": ["L2", "L3", "L4"], "limit": 10})
        entities = await self.get_entities(limit=20)
        return {
            "memories": memories,
            "entities": entities,
            "query": query,
            "session_id": session_id,
        }
