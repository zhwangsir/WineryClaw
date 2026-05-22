"""WriterExecutor + ReaderPool — v2.44 Sprint 0.7 step 2.

Why this module exists
======================

MemoryManager pre-v2.44 served ALL SQLite traffic through a single
LIFO connection pool. Under the 30-concurrent chat-latency benchmark
that pool degenerated into a thundering herd on SQLite's single-writer
lock:

  - 30 inbound chat tasks each call `store()` then `query()`
  - All 30 racing for the same write lock
  - busy_timeout=5000ms turns contention into latency, not errors
  - P95 measured at 2450 ms for the 30-conc case

This module factors out the read/write asymmetry explicitly:

  - WriterExecutor  ─ single-thread `ThreadPoolExecutor(max_workers=1)`,
                      every write goes through it. Calls are serialized
                      at the queue level, not at the SQLite layer, so we
                      pay zero busy_timeout cost.
  - ReaderPool      ─ LIFO bounded queue of long-lived connections
                      (default 8). With WAL mode, reads run concurrently
                      with the lone writer — no lock contention at all.

Both are managed lifetimes: instantiate at lifespan startup, call
.shutdown() at teardown.

This module does NOT touch MemoryManager. Integration happens in v2.44c.
Designed as drop-in primitives that MemoryManager._read_conn() and
_write_async() will use as their backing store.

Safety guarantees
=================

1. WriterExecutor.submit_sync(fn) blocks the caller until fn completes
   on the writer thread. Exceptions inside fn propagate to the caller
   (Future.result() reraises). The writer thread itself never crashes
   the process — uncaught exceptions are logged.

2. WriterExecutor.submit_async(fn) returns an awaitable for asyncio
   callers. Same semantics, but the asyncio loop stays free while the
   write executes.

3. ReaderPool is reentrant-safe within a single thread (`with` is the
   only access pattern) and thread-safe across threads via the
   underlying `queue.Queue`. Excess connections (over capacity) are
   closed on return rather than blocking the caller — matches the
   existing MemoryManager._POOL_SIZE policy.

4. .shutdown(wait=True) drains all in-flight writes before returning;
   reader connections close synchronously. Idempotent.

Failure modes
=============

- Connection factory raises during `_get_or_create()` → propagated to
  caller. WriterExecutor thread continues to accept new tasks (the
  next task gets a fresh connection attempt).
- Connection becomes unusable mid-task (e.g. SQLite disk full,
  permission revoked) → close it; subsequent tasks get a fresh connection.
- `executor.shutdown()` called twice → second call is a no-op (matches
  ThreadPoolExecutor's own semantics).

Not in scope (left for future iterations)
=========================================

- Batched commits (combining N writes <5ms apart into one transaction).
  Will be added if v2.44c benchmark shows commit overhead is the limit.
- Multi-writer support. Single writer is intentional — SQLite's design
  forbids concurrent writers, and any "writer pool" implementation just
  recreates the busy_timeout problem in user space.
- Cross-process coordination. Out of scope; we assume single-process
  main-brain (which is the architecture per docs/CLAUDE.md).
"""

from __future__ import annotations

import asyncio
import logging
import queue as _queue
import sqlite3
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Optional, TypeVar

logger = logging.getLogger("webrain.memory.sqlite_executor")

T = TypeVar("T")

# Connection factory: a zero-arg callable returning a fresh sqlite3
# connection (or pysqlcipher3 connection — duck-typed identical). Caller
# is responsible for applying PRAGMAs.
ConnFactory = Callable[[], sqlite3.Connection]


class WriterExecutor:
    """Single-thread executor that serializes SQLite writes.

    Owns exactly ONE long-lived connection. All write tasks run on the
    same thread, on the same connection — no busy_timeout, no
    SQLITE_BUSY retries, deterministic transaction ordering.
    """

    def __init__(self, conn_factory: ConnFactory, name: str = "webrain-writer") -> None:
        self._conn_factory = conn_factory
        # max_workers=1 is the whole point — DO NOT increase. Use a
        # named thread so py-spy / debuggers can identify it.
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=name)
        self._conn: Optional[sqlite3.Connection] = None
        # Lock the connection only during init/replace, NOT during normal
        # write paths — only the writer thread ever touches `_conn` after
        # init, so no inter-thread races on the connection object itself.
        self._conn_init_lock = threading.Lock()
        self._shutdown = False

    def _get_or_create_conn(self) -> sqlite3.Connection:
        # Called ONLY from the writer thread. Lazy: defer connection
        # creation until the first task arrives (so tests that construct
        # but never use the executor don't pay setup cost).
        if self._conn is None:
            with self._conn_init_lock:
                if self._conn is None:
                    self._conn = self._conn_factory()
        return self._conn

    def _replace_conn(self) -> None:
        # Drop a broken connection; next task creates a fresh one.
        with self._conn_init_lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:  # pragma: no cover — close-of-closed
                    pass
                self._conn = None

    def submit_sync(self, fn: Callable[[sqlite3.Connection], T]) -> T:
        """Block until `fn(conn)` returns on the writer thread.

        Use from sync callers. Exceptions raised inside `fn` propagate
        to the caller via Future.result().
        """
        if self._shutdown:
            raise RuntimeError("WriterExecutor already shut down")
        fut: Future[T] = self._executor.submit(self._run_one, fn)
        return fut.result()

    async def submit_async(self, fn: Callable[[sqlite3.Connection], T]) -> T:
        """Awaitable variant for asyncio callers — same semantics.

        We bridge concurrent.futures.Future to asyncio.Future via
        `asyncio.wrap_future`, which is the canonical pattern. The
        event loop stays free while the write runs.
        """
        if self._shutdown:
            raise RuntimeError("WriterExecutor already shut down")
        cfut: Future[T] = self._executor.submit(self._run_one, fn)
        return await asyncio.wrap_future(cfut)

    def _run_one(self, fn: Callable[[sqlite3.Connection], T]) -> T:
        """The actual work that runs on the writer thread.

        Wraps fn in a try/except so that even if fn dies mid-transaction
        we close + replace the connection and propagate the exception
        cleanly. Doing this here (not in fn) keeps callers simple — they
        just write `conn.execute(...); conn.commit()`.
        """
        conn = self._get_or_create_conn()
        try:
            return fn(conn)
        except sqlite3.DatabaseError as e:
            # Could be SQLITE_CORRUPT, SQLITE_NOTADB, SQLITE_IOERR — any
            # of these mean the connection state is suspect. Replace it.
            logger.warning(
                "writer thread caught DatabaseError; rolling connection: %s", e
            )
            try:
                conn.rollback()
            except Exception:  # pragma: no cover
                pass
            self._replace_conn()
            raise
        # Other exceptions (ValueError, KeyError, etc.) propagate WITHOUT
        # rolling the connection — those are app-layer bugs, the
        # connection is fine.

    def shutdown(self, wait: bool = True) -> None:
        """Drain in-flight writes and close the connection.

        Idempotent — second call is a no-op.
        """
        if self._shutdown:
            return
        self._shutdown = True
        try:
            self._executor.shutdown(wait=wait, cancel_futures=not wait)
        except Exception as e:  # pragma: no cover
            logger.warning("writer executor shutdown raised: %s", e)
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:  # pragma: no cover
                pass
            self._conn = None


class ReaderPool:
    """LIFO bounded pool of long-lived read connections.

    Matches the existing MemoryManager._POOL_SIZE pattern (queue.Queue
    with maxsize). Excess returns close the connection instead of
    blocking. Connections are created lazily on first checkout.

    Usage::

        pool = ReaderPool(conn_factory, size=8)
        with pool.borrow() as conn:
            rows = conn.execute("SELECT ...").fetchall()
        # conn returned to pool here
    """

    def __init__(self, conn_factory: ConnFactory, size: int = 8) -> None:
        if size < 1:
            raise ValueError(f"ReaderPool size must be >= 1, got {size}")
        self._conn_factory = conn_factory
        self._size = size
        self._pool: "_queue.Queue[sqlite3.Connection]" = _queue.Queue(maxsize=size)
        self._shutdown = False

    @contextmanager
    def borrow(self) -> Iterator[sqlite3.Connection]:
        """Check out a connection for the duration of the with-block.

        On exit, connection returns to the pool (excess gets closed).
        Exceptions inside the block leave the connection unaffected and
        return it to the pool — sqlite3 reader connections don't carry
        transactional state across calls (with autocommit on).
        """
        if self._shutdown:
            raise RuntimeError("ReaderPool already shut down")
        conn = self._checkout()
        try:
            yield conn
        finally:
            self._return(conn)

    def _checkout(self) -> sqlite3.Connection:
        try:
            # Non-blocking get — if empty, fall through to create.
            return self._pool.get_nowait()
        except _queue.Empty:
            return self._conn_factory()

    def _return(self, conn: sqlite3.Connection) -> None:
        try:
            self._pool.put_nowait(conn)
        except _queue.Full:
            # Pool is full; close this excess connection instead of
            # blocking the caller. Same policy as MemoryManager's H2.
            try:
                conn.close()
            except Exception:  # pragma: no cover
                pass

    def shutdown(self) -> None:
        """Close every pooled connection. Idempotent."""
        if self._shutdown:
            return
        self._shutdown = True
        while True:
            try:
                c = self._pool.get_nowait()
            except _queue.Empty:
                break
            try:
                c.close()
            except Exception:  # pragma: no cover
                pass
