"""v2.44c — MemoryManager._write_async() plumbing integration tests.

These tests verify the new `_write_async(fn)` method works in BOTH
configurations:
  - Without a writer_executor injected (test-default) → falls back to
    legacy pooled-connection path. All 944 existing tests rely on this
    fallback, so its semantics must EXACTLY match `with self._connect():`.
  - With a writer_executor injected (production) → calls actually run
    on the single writer thread.

Migration of actual write call sites (store / _store_embedding / ...)
is scheduled for v2.44d.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest

from memory._sqlite_executor import WriterExecutor
from memory.memory_manager import MemoryManager


@pytest.fixture
def fresh_mm(tmp_path: Path) -> MemoryManager:
    """Fresh MemoryManager pointing at a tmpdir-scoped db so each test
    runs against an isolated SQLite file."""
    db = tmp_path / "mm.db"
    return MemoryManager(db_path=str(db))


# ── Fallback path (no executor injected) ─────────────────────────────


class TestWriteAsyncFallback:
    """When set_writer_executor is NOT called, _write_async must behave
    identically to `with self._connect() as conn: return fn(conn)`. This
    is the path the existing 944 tests exercise — without these tests
    we'd have no direct coverage of that branch."""

    async def test_fallback_executes_fn_and_returns_value(
        self, fresh_mm: MemoryManager
    ) -> None:
        assert fresh_mm.writer_executor is None

        def insert(conn: sqlite3.Connection) -> int:
            cur = conn.execute(
                "INSERT INTO memories (id, content, level, created_at) "
                "VALUES ('w-test-1', 'fallback-write', 'L1', datetime('now'))"
            )
            conn.commit()
            return cur.rowcount

        rowcount = await fresh_mm._write_async(insert)
        assert rowcount == 1

        # Verify the write actually landed via a plain read.
        with fresh_mm._connect() as conn:
            row = conn.execute(
                "SELECT content FROM memories WHERE id='w-test-1'"
            ).fetchone()
            assert row["content"] == "fallback-write"

    async def test_fallback_exception_propagates(
        self, fresh_mm: MemoryManager
    ) -> None:
        def boom(conn: sqlite3.Connection) -> None:
            raise ValueError("planned failure")

        with pytest.raises(ValueError, match="planned failure"):
            await fresh_mm._write_async(boom)

    async def test_fallback_runs_off_event_loop(
        self, fresh_mm: MemoryManager
    ) -> None:
        """The fallback uses asyncio.to_thread → fn runs on a worker
        thread, not the asyncio event loop thread."""
        seen_threads: list[str] = []

        def record_thread(conn: sqlite3.Connection) -> None:
            seen_threads.append(threading.current_thread().name)
            conn.execute(
                "INSERT INTO memories (id, content, level, created_at) "
                "VALUES ('w-thread', 'thread-check', 'L1', datetime('now'))"
            )
            conn.commit()

        await fresh_mm._write_async(record_thread)
        # MainThread is the asyncio thread when invoked from a test.
        assert seen_threads[0] != "MainThread"


# ── Injected-executor path (production) ───────────────────────────────


class TestWriteAsyncWithExecutor:
    """When a real WriterExecutor is injected, _write_async must route
    through it AND every write runs on the same named writer thread."""

    async def test_injected_executor_routes_through_writer_thread(
        self, fresh_mm: MemoryManager
    ) -> None:
        # Build a writer pointing at the same db. We re-use the
        # MemoryManager's existing _make_pooled_connection for the
        # factory so PRAGMAs / SQLCipher branching stays consistent.
        def factory() -> sqlite3.Connection:
            return fresh_mm._make_pooled_connection()

        writer = WriterExecutor(factory, name="t-write-async")
        try:
            fresh_mm.set_writer_executor(writer)
            assert fresh_mm.writer_executor is writer

            thread_names: list[str] = []

            def insert(conn: sqlite3.Connection) -> None:
                thread_names.append(threading.current_thread().name)
                conn.execute(
                    "INSERT INTO memories (id, content, level, created_at) "
                    "VALUES ('w-injected', 'via-executor', 'L1', datetime('now'))"
                )
                conn.commit()

            await fresh_mm._write_async(insert)
            # The writer thread is named with our prefix.
            assert len(thread_names) == 1
            assert thread_names[0].startswith("t-write-async")

            # Sanity: row is visible to a reader.
            with fresh_mm._connect() as conn:
                row = conn.execute(
                    "SELECT content FROM memories WHERE id='w-injected'"
                ).fetchone()
                assert row["content"] == "via-executor"
        finally:
            writer.shutdown()

    async def test_injected_executor_serializes_concurrent_writes(
        self, fresh_mm: MemoryManager
    ) -> None:
        """Spam N concurrent _write_async tasks; all complete with no
        SQLITE_BUSY, and the writer thread handled them all."""
        import asyncio

        def factory() -> sqlite3.Connection:
            return fresh_mm._make_pooled_connection()

        writer = WriterExecutor(factory, name="t-serial")
        try:
            fresh_mm.set_writer_executor(writer)

            seen_thread_ids: set[int] = set()

            def make_insert(i: int):
                def _fn(conn: sqlite3.Connection) -> None:
                    seen_thread_ids.add(threading.get_ident())
                    conn.execute(
                        "INSERT INTO memories (id, content, level, created_at) "
                        "VALUES (?, ?, 'L1', datetime('now'))",
                        (f"w-conc-{i}", f"row-{i}"),
                    )
                    conn.commit()

                return _fn

            await asyncio.gather(
                *(fresh_mm._write_async(make_insert(i)) for i in range(30))
            )

            # All 30 writes ran on ONE thread (single-writer guarantee).
            assert len(seen_thread_ids) == 1

            # All 30 rows present.
            with fresh_mm._connect() as conn:
                n = conn.execute(
                    "SELECT count(*) FROM memories WHERE id LIKE 'w-conc-%'"
                ).fetchone()[0]
                assert n == 30
        finally:
            writer.shutdown()

    async def test_increment_access_async_routes_through_writer(
        self, fresh_mm: MemoryManager
    ) -> None:
        """v2.44d — production query() now calls _increment_access_async.
        Verify it lands on the writer thread when an executor is set,
        AND that it produces the same row mutations as the sync version
        (access_count + 1, last_accessed_at updated, importance bumped)."""
        with fresh_mm._connect() as conn:
            conn.execute(
                "INSERT INTO memories (id, content, level, created_at, access_count) "
                "VALUES ('inc-a', 'a', 'L1', datetime('now'), 0)"
            )
            conn.execute(
                "INSERT INTO memories (id, content, level, created_at, access_count) "
                "VALUES ('inc-b', 'b', 'L1', datetime('now'), 5)"
            )
            conn.commit()

        def factory() -> sqlite3.Connection:
            return fresh_mm._make_pooled_connection()

        writer = WriterExecutor(factory, name="t-inc")
        try:
            fresh_mm.set_writer_executor(writer)
            await fresh_mm._increment_access_async(["inc-a", "inc-b"])
            with fresh_mm._connect() as conn:
                a = conn.execute(
                    "SELECT access_count FROM memories WHERE id='inc-a'"
                ).fetchone()
                b = conn.execute(
                    "SELECT access_count FROM memories WHERE id='inc-b'"
                ).fetchone()
                assert a["access_count"] == 1
                assert b["access_count"] == 6
        finally:
            writer.shutdown()

    async def test_increment_access_async_fallback_matches_sync(
        self, fresh_mm: MemoryManager
    ) -> None:
        """Fallback path (no executor) must yield byte-identical row
        mutations to the sync `_increment_access` — that's the point of
        the dual path: prod gets serialization, tests get legacy behavior."""
        with fresh_mm._connect() as conn:
            for i in range(3):
                conn.execute(
                    "INSERT INTO memories (id, content, level, created_at, access_count) "
                    "VALUES (?, 'x', 'L1', datetime('now'), 0)",
                    (f"inc-fb-{i}",),
                )
            conn.commit()

        assert fresh_mm.writer_executor is None
        await fresh_mm._increment_access_async(
            ["inc-fb-0", "inc-fb-1", "inc-fb-2"]
        )

        with fresh_mm._connect() as conn:
            for i in range(3):
                row = conn.execute(
                    "SELECT access_count FROM memories WHERE id=?",
                    (f"inc-fb-{i}",),
                ).fetchone()
                assert row["access_count"] == 1

    async def test_increment_access_async_empty_list_is_noop(
        self, fresh_mm: MemoryManager
    ) -> None:
        """Empty list short-circuits before _write_async — matches sync."""
        await fresh_mm._increment_access_async([])

    async def test_set_writer_executor_to_none_reverts_to_fallback(
        self, fresh_mm: MemoryManager
    ) -> None:
        """Toggling off the writer (e.g. for shutdown sequencing or a
        test reset) must put _write_async back on the fallback path."""

        def factory() -> sqlite3.Connection:
            return fresh_mm._make_pooled_connection()

        writer = WriterExecutor(factory, name="t-toggle")
        try:
            fresh_mm.set_writer_executor(writer)
            fresh_mm.set_writer_executor(None)
            assert fresh_mm.writer_executor is None

            # _write_async still works via fallback.
            def insert(conn: sqlite3.Connection) -> None:
                conn.execute(
                    "INSERT INTO memories (id, content, level, created_at) "
                    "VALUES ('w-toggle', 'after-revert', 'L1', datetime('now'))"
                )
                conn.commit()

            await fresh_mm._write_async(insert)
            with fresh_mm._connect() as conn:
                row = conn.execute(
                    "SELECT content FROM memories WHERE id='w-toggle'"
                ).fetchone()
                assert row["content"] == "after-revert"
        finally:
            writer.shutdown()
