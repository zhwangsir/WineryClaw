"""v2.44b — unit tests for WriterExecutor + ReaderPool.

These tests cover the executor primitives in isolation (no MemoryManager
involvement). v2.44c will add integration tests that verify the
end-to-end serialization in the context of memory.store / memory.query.
"""

from __future__ import annotations

import asyncio
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from memory._sqlite_executor import ReaderPool, WriterExecutor


# ── Helpers ──────────────────────────────────────────────────────────


def _make_conn_factory(db_path: Path):
    """Return a zero-arg factory yielding fresh sqlite3 connections to
    db_path, with WAL + busy_timeout (matches the production MemoryManager
    PRAGMA setup so tests catch real lock-contention semantics).
    """

    def _factory() -> sqlite3.Connection:
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    return _factory


@pytest.fixture
def fresh_db(tmp_path: Path) -> Path:
    db = tmp_path / "exec.db"
    # Create schema once outside the executor + flip WAL on the db
    # header here, NOT in the per-connection factory below. WAL is a
    # header-level switch; once set it's sticky. If we set it per
    # connection (as the production MemoryManager does), 20 threads
    # racing to open fresh connections to a brand-new DB all try the
    # WAL PRAGMA simultaneously and N-1 get SQLITE_BUSY. That's a
    # test artifact, not a real bug — in prod connections trickle in
    # via lazy pool growth and there's no race.
    with sqlite3.connect(str(db)) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)"
        )
        conn.commit()
    return db


# ── WriterExecutor ──────────────────────────────────────────────────


class TestWriterExecutor:
    def test_submit_sync_runs_on_writer_thread(self, fresh_db: Path) -> None:
        ex = WriterExecutor(_make_conn_factory(fresh_db), name="t-w")
        try:
            seen_threads = []

            def insert(conn: sqlite3.Connection) -> int:
                seen_threads.append(threading.current_thread().name)
                conn.execute("INSERT INTO items (value) VALUES ('hello')")
                conn.commit()
                return conn.execute("SELECT count(*) FROM items").fetchone()[0]

            count = ex.submit_sync(insert)
            assert count == 1
            # The task ran on a thread that is NOT the main thread.
            assert seen_threads[0] != threading.current_thread().name
            assert seen_threads[0].startswith("t-w")
        finally:
            ex.shutdown()

    def test_all_writes_share_one_thread(self, fresh_db: Path) -> None:
        ex = WriterExecutor(_make_conn_factory(fresh_db), name="t-w")
        seen_threads: list[str] = []
        try:

            def insert(conn: sqlite3.Connection) -> None:
                seen_threads.append(threading.current_thread().name)
                conn.execute("INSERT INTO items (value) VALUES ('x')")
                conn.commit()

            for _ in range(20):
                ex.submit_sync(insert)
            # Single-thread executor → all writes happen on the same
            # named thread.
            assert len(set(seen_threads)) == 1
        finally:
            ex.shutdown()

    def test_submit_async_works_from_event_loop(self, fresh_db: Path) -> None:
        async def _go() -> int:
            ex = WriterExecutor(_make_conn_factory(fresh_db), name="t-async")
            try:

                def insert(conn: sqlite3.Connection) -> int:
                    conn.execute("INSERT INTO items (value) VALUES ('async')")
                    conn.commit()
                    return conn.execute(
                        "SELECT count(*) FROM items WHERE value='async'"
                    ).fetchone()[0]

                return await ex.submit_async(insert)
            finally:
                ex.shutdown()

        result = asyncio.run(_go())
        assert result == 1

    def test_exception_in_fn_propagates_to_caller(self, fresh_db: Path) -> None:
        ex = WriterExecutor(_make_conn_factory(fresh_db), name="t-err")
        try:

            def boom(conn: sqlite3.Connection) -> None:
                raise ValueError("intentional")

            with pytest.raises(ValueError, match="intentional"):
                ex.submit_sync(boom)
            # Executor still works after a task exception.
            def insert(conn: sqlite3.Connection) -> int:
                conn.execute("INSERT INTO items (value) VALUES ('post')")
                conn.commit()
                return conn.execute("SELECT count(*) FROM items").fetchone()[0]

            assert ex.submit_sync(insert) == 1
        finally:
            ex.shutdown()

    def test_database_error_rolls_and_replaces_connection(
        self, fresh_db: Path
    ) -> None:
        """When a sqlite3.DatabaseError fires, the writer thread closes
        the (suspect) connection so the NEXT task gets a fresh one."""
        ex = WriterExecutor(_make_conn_factory(fresh_db), name="t-dberr")
        try:
            conns_seen: list[int] = []

            def task_with_db_err(conn: sqlite3.Connection) -> None:
                conns_seen.append(id(conn))
                # Force a DatabaseError — duplicate-PK insert.
                conn.execute("INSERT INTO items (id, value) VALUES (1, 'a')")
                conn.commit()
                conn.execute("INSERT INTO items (id, value) VALUES (1, 'b')")
                conn.commit()

            with pytest.raises(sqlite3.IntegrityError):
                ex.submit_sync(task_with_db_err)

            def get_id(conn: sqlite3.Connection) -> int:
                conns_seen.append(id(conn))
                return 42

            ex.submit_sync(get_id)
            # First task got conn A; after DatabaseError, second task gets
            # a DIFFERENT conn (B).
            assert conns_seen[0] != conns_seen[1]
        finally:
            ex.shutdown()

    def test_shutdown_is_idempotent(self, fresh_db: Path) -> None:
        ex = WriterExecutor(_make_conn_factory(fresh_db), name="t-shut")
        ex.shutdown()
        # Second call: no-op, no exception.
        ex.shutdown()
        # Submitting after shutdown raises.
        with pytest.raises(RuntimeError, match="shut down"):
            ex.submit_sync(lambda c: None)

    def test_submit_async_after_shutdown_raises(self, fresh_db: Path) -> None:
        async def _go() -> None:
            ex = WriterExecutor(_make_conn_factory(fresh_db), name="t-shut2")
            ex.shutdown()
            with pytest.raises(RuntimeError, match="shut down"):
                await ex.submit_async(lambda c: None)

        asyncio.run(_go())

    def test_serializes_under_concurrent_callers(self, fresh_db: Path) -> None:
        """Concurrent submit_sync from N threads must produce N inserts,
        ordered (no lost updates from race conditions).
        """
        ex = WriterExecutor(_make_conn_factory(fresh_db), name="t-serial")
        try:
            N = 50
            barrier = threading.Barrier(N)

            def insert_one(seq: int) -> None:
                def fn(conn: sqlite3.Connection) -> None:
                    conn.execute(
                        "INSERT INTO items (value) VALUES (?)", (str(seq),)
                    )
                    conn.commit()

                ex.submit_sync(fn)

            def worker(seq: int) -> None:
                barrier.wait()  # release N threads simultaneously
                insert_one(seq)

            threads = [threading.Thread(target=worker, args=(i,)) for i in range(N)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            # All N writes landed.
            def count(conn: sqlite3.Connection) -> int:
                return conn.execute("SELECT count(*) FROM items").fetchone()[0]

            assert ex.submit_sync(count) == N
        finally:
            ex.shutdown()


# ── ReaderPool ──────────────────────────────────────────────────────


class TestReaderPool:
    def test_borrow_returns_to_pool(self, fresh_db: Path) -> None:
        pool = ReaderPool(_make_conn_factory(fresh_db), size=4)
        try:
            with pool.borrow() as conn:
                rows = conn.execute("SELECT count(*) FROM items").fetchall()
                assert rows == [(0,)]
            # After exit, pool should have 1 reusable connection.
            assert pool._pool.qsize() == 1
        finally:
            pool.shutdown()

    def test_pool_reuses_connections(self, fresh_db: Path) -> None:
        pool = ReaderPool(_make_conn_factory(fresh_db), size=4)
        try:
            with pool.borrow() as c1:
                id1 = id(c1)
            # Second borrow gets the SAME connection back.
            with pool.borrow() as c2:
                assert id(c2) == id1
        finally:
            pool.shutdown()

    def test_pool_creates_new_conn_when_empty(self, fresh_db: Path) -> None:
        pool = ReaderPool(_make_conn_factory(fresh_db), size=4)
        try:
            with pool.borrow() as c1:
                with pool.borrow() as c2:
                    # Pool was empty after c1 checkout → c2 is a NEW conn.
                    assert id(c1) != id(c2)
        finally:
            pool.shutdown()

    def test_size_zero_rejected(self, fresh_db: Path) -> None:
        with pytest.raises(ValueError, match=">= 1"):
            ReaderPool(_make_conn_factory(fresh_db), size=0)

    def test_excess_returns_close_instead_of_block(self, fresh_db: Path) -> None:
        pool = ReaderPool(_make_conn_factory(fresh_db), size=2)
        try:
            # Open 4 concurrent borrows; all return in a row.
            conns = []
            ctxs = [pool.borrow() for _ in range(4)]
            for c in ctxs:
                conns.append(c.__enter__())
            assert pool._pool.qsize() == 0
            for c in ctxs:
                c.__exit__(None, None, None)
            # Pool capacity is 2 → 2 connections retained, 2 closed.
            assert pool._pool.qsize() == 2
        finally:
            pool.shutdown()

    def test_concurrent_readers_dont_deadlock(self, fresh_db: Path) -> None:
        """N threads each call borrow() → execute → return. Verifies
        the pool doesn't get into a deadlock under contention.
        """
        pool = ReaderPool(_make_conn_factory(fresh_db), size=4)
        try:
            N = 20
            counts = []
            lock = threading.Lock()

            def worker() -> None:
                with pool.borrow() as conn:
                    n = conn.execute("SELECT count(*) FROM items").fetchone()[0]
                    with lock:
                        counts.append(n)

            threads = [threading.Thread(target=worker) for _ in range(N)]
            t0 = time.time()
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=5)
            elapsed = time.time() - t0
            assert all(not t.is_alive() for t in threads), (
                f"deadlock detected after {elapsed:.1f}s"
            )
            assert len(counts) == N
        finally:
            pool.shutdown()

    def test_shutdown_closes_all_pooled_conns(self, fresh_db: Path) -> None:
        pool = ReaderPool(_make_conn_factory(fresh_db), size=2)
        # Cycle a connection through to fill the pool.
        with pool.borrow():
            pass
        assert pool._pool.qsize() == 1
        pool.shutdown()
        assert pool._pool.qsize() == 0
        # Double shutdown is idempotent.
        pool.shutdown()
        with pytest.raises(RuntimeError, match="shut down"):
            with pool.borrow():
                pass


# ── Co-existence: writer + readers run in parallel (WAL) ──────────────


class TestWriterReaderCoexistence:
    """End-to-end sanity: with WAL on, readers can fetch rows while a
    write is in flight on a separate thread, no SQLITE_BUSY raised.
    """

    def test_reader_sees_committed_writes_immediately(
        self, fresh_db: Path
    ) -> None:
        factory = _make_conn_factory(fresh_db)
        writer = WriterExecutor(factory, name="t-coex-w")
        pool = ReaderPool(factory, size=4)
        try:
            def insert(conn: sqlite3.Connection) -> None:
                conn.execute("INSERT INTO items (value) VALUES ('coex')")
                conn.commit()

            writer.submit_sync(insert)
            with pool.borrow() as r:
                assert (
                    r.execute(
                        "SELECT count(*) FROM items WHERE value='coex'"
                    ).fetchone()[0]
                    == 1
                )
        finally:
            writer.shutdown()
            pool.shutdown()
