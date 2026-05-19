"""Tests for RAGFileWatcher — behavioral, not structural.

We focus on:
  - Event dispatch (created/modified/deleted/moved → correct retriever call)
  - Debouncer collapses rapid events
  - Glob + ignore patterns filter correctly
  - start()/stop() lifecycle (with real directories)

We test the handler logic directly via `_trigger_for_test()` to avoid flaky
real-filesystem races. One end-to-end test uses a real Observer to confirm
the wiring isn't broken in production.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any, List
from unittest.mock import MagicMock

import pytest
from watchdog.events import (
    DirCreatedEvent,
    FileCreatedEvent,
    FileDeletedEvent,
    FileModifiedEvent,
    FileMovedEvent,
)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from memory.rag_watcher import (  # noqa: E402
    DEFAULT_IGNORE_SUBSTRINGS,
    RAGFileWatcher,
    _DebouncedDispatcher,
    _should_ignore,
)


# ─── Fake retriever ──────────────────────────────────────────────────────────


class FakeRetriever:
    """Records the order of index_file / remove_file calls for assertions."""

    def __init__(self) -> None:
        self.indexed: List[str] = []
        self.removed: List[str] = []

    def index_file(self, path: str) -> Any:
        self.indexed.append(path)
        return {"indexed": True}

    def remove_file(self, path: str) -> bool:
        self.removed.append(path)
        return True


# ─── _should_ignore unit tests ───────────────────────────────────────────────


class TestShouldIgnore:
    def test_ignores_git_subdir(self):
        assert _should_ignore("/proj/.git/HEAD", DEFAULT_IGNORE_SUBSTRINGS, "**/*") is True

    def test_ignores_node_modules(self):
        assert (
            _should_ignore("/proj/node_modules/foo/index.js", DEFAULT_IGNORE_SUBSTRINGS, "**/*")
            is True
        )

    def test_ignores_pycache(self):
        assert (
            _should_ignore("/proj/__pycache__/foo.cpython-39.pyc", DEFAULT_IGNORE_SUBSTRINGS, "**/*")
            is True
        )

    def test_accepts_normal_file(self, tmp_path):
        p = tmp_path / "a.md"
        p.write_text("x")
        assert _should_ignore(str(p), DEFAULT_IGNORE_SUBSTRINGS, "**/*.md") is False

    def test_glob_filters_by_extension(self, tmp_path):
        md = tmp_path / "a.md"
        md.write_text("x")
        txt = tmp_path / "b.txt"
        txt.write_text("x")
        assert _should_ignore(str(md), DEFAULT_IGNORE_SUBSTRINGS, "**/*.md") is False
        assert _should_ignore(str(txt), DEFAULT_IGNORE_SUBSTRINGS, "**/*.md") is True


# ─── _DebouncedDispatcher tests ──────────────────────────────────────────────


class TestDebouncer:
    def test_single_event_fires_after_delay(self):
        d = _DebouncedDispatcher(delay_s=0.05)
        called: List[int] = []
        d.schedule("/a", lambda: called.append(1))
        assert called == []  # not yet
        time.sleep(0.12)
        assert called == [1]

    def test_rapid_events_collapse_to_one(self):
        d = _DebouncedDispatcher(delay_s=0.08)
        called: List[int] = []
        for _ in range(5):
            d.schedule("/a", lambda: called.append(1))
            time.sleep(0.01)
        # After all schedules + delay, expect ONE call
        time.sleep(0.2)
        assert called == [1]

    def test_different_paths_fire_independently(self):
        d = _DebouncedDispatcher(delay_s=0.05)
        called: List[str] = []
        d.schedule("/a", lambda: called.append("a"))
        d.schedule("/b", lambda: called.append("b"))
        time.sleep(0.15)
        assert sorted(called) == ["a", "b"]

    def test_cancel_all_prevents_pending_actions(self):
        d = _DebouncedDispatcher(delay_s=0.2)
        called: List[int] = []
        d.schedule("/a", lambda: called.append(1))
        assert d.pending_count() == 1
        d.cancel_all()
        time.sleep(0.3)
        assert called == []
        assert d.pending_count() == 0


# ─── RAGFileWatcher event dispatch ───────────────────────────────────────────


@pytest.fixture
def watcher_and_retriever(tmp_path):
    retriever = FakeRetriever()
    watcher = RAGFileWatcher(
        retriever=retriever,
        watch_paths=[str(tmp_path)],
        glob="**/*.md",
        debounce_ms=30,
    )
    yield watcher, retriever, tmp_path
    watcher.stop()


class TestEventDispatch:
    def test_created_event_triggers_index(self, watcher_and_retriever, tmp_path):
        watcher, retriever, _ = watcher_and_retriever
        path = str(tmp_path / "new.md")
        Path(path).write_text("hi")
        watcher._trigger_for_test(FileCreatedEvent(path))
        time.sleep(0.1)
        assert retriever.indexed == [path]

    def test_modified_event_triggers_index(self, watcher_and_retriever, tmp_path):
        watcher, retriever, _ = watcher_and_retriever
        path = str(tmp_path / "x.md")
        Path(path).write_text("hi")
        watcher._trigger_for_test(FileModifiedEvent(path))
        time.sleep(0.1)
        assert retriever.indexed == [path]

    def test_deleted_event_triggers_remove(self, watcher_and_retriever, tmp_path):
        watcher, retriever, _ = watcher_and_retriever
        path = str(tmp_path / "gone.md")
        watcher._trigger_for_test(FileDeletedEvent(path))
        time.sleep(0.1)
        assert retriever.removed == [path]

    def test_moved_event_removes_old_and_indexes_new(self, watcher_and_retriever, tmp_path):
        watcher, retriever, _ = watcher_and_retriever
        old = str(tmp_path / "old.md")
        new = str(tmp_path / "new.md")
        Path(new).write_text("hi")
        watcher._trigger_for_test(FileMovedEvent(old, new))
        time.sleep(0.1)
        assert retriever.removed == [old]
        assert retriever.indexed == [new]

    def test_directory_events_ignored(self, watcher_and_retriever, tmp_path):
        watcher, retriever, _ = watcher_and_retriever
        watcher._trigger_for_test(DirCreatedEvent(str(tmp_path / "subdir")))
        time.sleep(0.1)
        assert retriever.indexed == []
        assert retriever.removed == []

    def test_ignored_path_not_indexed(self, watcher_and_retriever):
        watcher, retriever, _ = watcher_and_retriever
        ignored = "/Users/x/proj/.git/HEAD"
        watcher._trigger_for_test(FileCreatedEvent(ignored))
        time.sleep(0.1)
        assert retriever.indexed == []

    def test_non_matching_glob_not_indexed(self, watcher_and_retriever, tmp_path):
        watcher, retriever, _ = watcher_and_retriever
        # watcher's glob is **/*.md; .txt should be filtered.
        path = str(tmp_path / "x.txt")
        Path(path).write_text("hi")
        watcher._trigger_for_test(FileCreatedEvent(path))
        time.sleep(0.1)
        assert retriever.indexed == []

    def test_debounce_collapses_rapid_modifications(self, watcher_and_retriever, tmp_path):
        watcher, retriever, _ = watcher_and_retriever
        path = str(tmp_path / "spammy.md")
        Path(path).write_text("v1")
        # Simulate 5 rapid editor save events
        for _ in range(5):
            watcher._trigger_for_test(FileModifiedEvent(path))
        time.sleep(0.1)
        # Should have indexed only once
        assert retriever.indexed.count(path) == 1


# ─── Lifecycle ──────────────────────────────────────────────────────────────


class TestLifecycle:
    def test_start_with_nonexistent_path_skips_gracefully(self, tmp_path):
        retriever = FakeRetriever()
        w = RAGFileWatcher(
            retriever=retriever,
            watch_paths=[str(tmp_path / "does-not-exist")],
            debounce_ms=20,
        )
        scheduled = w.start()
        assert scheduled == set()
        assert w.is_running is False

    def test_start_with_file_path_instead_of_dir_skips(self, tmp_path):
        f = tmp_path / "a.md"
        f.write_text("x")
        retriever = FakeRetriever()
        w = RAGFileWatcher(retriever=retriever, watch_paths=[str(f)], debounce_ms=20)
        scheduled = w.start()
        assert scheduled == set()

    def test_start_idempotent(self, tmp_path):
        retriever = FakeRetriever()
        w = RAGFileWatcher(retriever=retriever, watch_paths=[str(tmp_path)], debounce_ms=20)
        s1 = w.start()
        s2 = w.start()
        assert s1 == s2
        assert w.is_running is True
        w.stop()

    def test_stop_when_not_started_is_safe(self, tmp_path):
        w = RAGFileWatcher(
            retriever=FakeRetriever(), watch_paths=[str(tmp_path)], debounce_ms=20
        )
        w.stop()  # should not raise

    def test_stop_cancels_pending_debounced_actions(self, tmp_path):
        # Use a fresh watcher with longer debounce to avoid race on slow CI.
        retriever = FakeRetriever()
        w = RAGFileWatcher(
            retriever=retriever,
            watch_paths=[str(tmp_path)],
            glob="**/*.md",
            debounce_ms=300,
        )
        path = str(tmp_path / "pending.md")
        Path(path).write_text("hi")
        w._trigger_for_test(FileModifiedEvent(path))
        # Don't wait for debounce; stop immediately
        w.stop()
        # Wait well past the would-be fire time
        time.sleep(0.5)
        assert retriever.indexed == []


# ─── End-to-end with real Observer ───────────────────────────────────────────


class TestRealObserver:
    def test_real_file_create_triggers_index(self, tmp_path):
        retriever = FakeRetriever()
        w = RAGFileWatcher(
            retriever=retriever,
            watch_paths=[str(tmp_path)],
            glob="**/*.md",
            debounce_ms=60,
        )
        try:
            scheduled = w.start()
            assert scheduled == {str(tmp_path)}
            assert w.is_running is True

            # Create a real file
            target = tmp_path / "real.md"
            target.write_text("created via real fs")

            # Wait for watchdog + debouncer (be generous; FS notifs are slow on mac)
            deadline = time.time() + 3.0
            while time.time() < deadline and not retriever.indexed:
                time.sleep(0.05)

            assert any(p.endswith("real.md") for p in retriever.indexed), (
                f"expected real.md indexed; got {retriever.indexed!r}"
            )
        finally:
            w.stop()
