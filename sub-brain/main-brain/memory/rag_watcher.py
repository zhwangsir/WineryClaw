"""
RAG file watcher — auto-reindex on filesystem changes.

Sits next to RAGRetriever. Given a list of directories to watch, it:
  - On file create/modify → debounced re-index
  - On file delete → remove from index
  - On file move → remove old + index new

Debouncing matters: editors trigger 3-5 events per save (rename-temp, write,
chmod, ...). Without debounce we'd re-embed the same file repeatedly. We
collapse all events for the same path within `debounce_ms` into one action.

Design choices:
  - watchdog `Observer` runs on a background thread
  - Debouncer is a simple `threading.Timer` per path; on new event, cancel
    + reschedule. No event loop, no asyncio entanglement.
  - Ignore patterns (`.git/`, `node_modules/`, ...) match on resolved path
    substrings. Cheaper than gitignore parsing and good enough for v1.
"""

from __future__ import annotations

import fnmatch
import logging
import threading
from pathlib import Path
from typing import Callable, Iterable, List, Optional, Set

from watchdog.events import (
    FileSystemEvent,
    FileSystemEventHandler,
)
from watchdog.observers import Observer

logger = logging.getLogger("webrain.memory.rag_watcher")


# Patterns to never index. Match anywhere in the resolved absolute path.
DEFAULT_IGNORE_SUBSTRINGS: tuple[str, ...] = (
    "/.git/",
    "/node_modules/",
    "/__pycache__/",
    "/.venv/",
    "/venv/",
    "/dist/",
    "/.cache/",
    "/.DS_Store",
    "/.idea/",
    "/.vscode/",
    "/coverage/",
    "/htmlcov/",
)


class IndexCallback:
    """Protocol — anything with index_file(path) and remove_file(path)."""

    def index_file(self, path: str) -> object: ...  # noqa: E704
    def remove_file(self, path: str) -> bool: ...  # noqa: E704


class _DebouncedDispatcher:
    """Coalesces rapid-fire events for the same path into one delayed action.

    Thread-safe. Each path has at most one pending Timer at a time.
    """

    def __init__(self, delay_s: float):
        self.delay_s = delay_s
        self._timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()

    def schedule(self, path: str, action: Callable[[], None]) -> None:
        with self._lock:
            existing = self._timers.get(path)
            if existing is not None:
                existing.cancel()

            def _fire() -> None:
                with self._lock:
                    self._timers.pop(path, None)
                try:
                    action()
                except Exception as e:  # pragma: no cover — caller logs
                    logger.warning("rag_watcher: action failed for %s: %s", path, e)

            t = threading.Timer(self.delay_s, _fire)
            t.daemon = True
            t.start()
            self._timers[path] = t

    def cancel_all(self) -> None:
        with self._lock:
            for t in self._timers.values():
                t.cancel()
            self._timers.clear()

    def pending_count(self) -> int:
        with self._lock:
            return len(self._timers)


def _should_ignore(path: str, ignore_substrings: Iterable[str], glob: str) -> bool:
    """Returns True iff the path should NOT be indexed.

    Ignore rules (any match → skip):
      1. Path contains a denylisted substring (e.g. "/.git/")
      2. Path basename does NOT match `glob` (uses fnmatch)
    """
    p = str(Path(path).resolve())
    for sub in ignore_substrings:
        if sub in p:
            return True
    # glob check — match against basename so "**/*.md" → "*.md"
    bare_pattern = glob.split("/")[-1] if "/" in glob else glob
    return not fnmatch.fnmatch(Path(p).name, bare_pattern)


class _RAGEventHandler(FileSystemEventHandler):
    """Translates watchdog events into index/remove calls on the retriever."""

    def __init__(
        self,
        retriever: IndexCallback,
        dispatcher: _DebouncedDispatcher,
        ignore_substrings: tuple[str, ...],
        glob: str,
    ):
        self.retriever = retriever
        self.dispatcher = dispatcher
        self.ignore_substrings = ignore_substrings
        self.glob = glob

    # ---- helpers ----

    def _accept(self, path: str) -> bool:
        return not _should_ignore(path, self.ignore_substrings, self.glob)

    def _schedule_index(self, path: str) -> None:
        self.dispatcher.schedule(path, lambda: self.retriever.index_file(path))

    def _schedule_remove(self, path: str) -> None:
        self.dispatcher.schedule(path, lambda: self.retriever.remove_file(path))

    # ---- watchdog callbacks ----

    def on_created(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        path = str(event.src_path)
        if self._accept(path):
            self._schedule_index(path)

    def on_modified(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        path = str(event.src_path)
        if self._accept(path):
            self._schedule_index(path)

    def on_deleted(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        path = str(event.src_path)
        # Always attempt remove (no glob filter on delete — index might exist
        # from before glob narrowed).
        self._schedule_remove(path)

    def on_moved(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        old_path = str(event.src_path)
        new_path = str(getattr(event, "dest_path", "") or "")
        self._schedule_remove(old_path)
        if new_path and self._accept(new_path):
            self._schedule_index(new_path)


class RAGFileWatcher:
    """Watch one or more directories, auto-update RAG index on file changes.

    Usage:
        w = RAGFileWatcher(retriever, watch_paths=["~/Documents/notes"])
        w.start()
        # ... agent runs ...
        w.stop()
    """

    def __init__(
        self,
        retriever: IndexCallback,
        watch_paths: List[str],
        *,
        glob: str = "**/*.md",
        recursive: bool = True,
        debounce_ms: int = 500,
        ignore_substrings: Optional[Iterable[str]] = None,
    ):
        self.retriever = retriever
        self.watch_paths = [str(Path(p).expanduser().resolve()) for p in watch_paths]
        self.glob = glob
        self.recursive = recursive
        self.debounce_s = debounce_ms / 1000.0
        self.ignore_substrings: tuple[str, ...] = tuple(
            ignore_substrings if ignore_substrings is not None else DEFAULT_IGNORE_SUBSTRINGS
        )
        self._observer: Optional[Observer] = None
        self._dispatcher = _DebouncedDispatcher(self.debounce_s)
        self._handler: Optional[_RAGEventHandler] = None
        self._started: bool = False

    @property
    def is_running(self) -> bool:
        return self._started

    @property
    def pending_count(self) -> int:
        return self._dispatcher.pending_count()

    def start(self) -> Set[str]:
        """Start watching. Returns the set of paths that were successfully scheduled."""
        if self._started:
            return set(self.watch_paths)

        self._handler = _RAGEventHandler(
            retriever=self.retriever,
            dispatcher=self._dispatcher,
            ignore_substrings=self.ignore_substrings,
            glob=self.glob,
        )
        self._observer = Observer()

        scheduled: Set[str] = set()
        for path in self.watch_paths:
            if not Path(path).exists():
                logger.warning("rag_watcher: skip nonexistent path %s", path)
                continue
            if not Path(path).is_dir():
                logger.warning("rag_watcher: skip non-directory %s", path)
                continue
            self._observer.schedule(self._handler, path, recursive=self.recursive)
            scheduled.add(path)

        if not scheduled:
            logger.warning("rag_watcher: no valid paths to watch")
            self._observer = None
            return scheduled

        self._observer.start()
        self._started = True
        logger.info("rag_watcher: watching %d path(s) with glob=%s", len(scheduled), self.glob)
        return scheduled

    def stop(self) -> None:
        """Stop watching. Cancels pending debounced actions.

        Always cancels the dispatcher (even when not started) because tests
        and direct trigger paths can schedule actions without start().
        """
        self._dispatcher.cancel_all()
        if not self._started:
            return
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=5.0)
        self._observer = None
        self._handler = None
        self._started = False

    # ---- testing-only helpers (not for production use) ----

    def _trigger_for_test(self, event: FileSystemEvent) -> None:
        """Direct event injection for tests that don't want a real Observer."""
        if self._handler is None:
            # Build handler without starting observer
            self._handler = _RAGEventHandler(
                retriever=self.retriever,
                dispatcher=self._dispatcher,
                ignore_substrings=self.ignore_substrings,
                glob=self.glob,
            )
        if event.event_type == "created":
            self._handler.on_created(event)
        elif event.event_type == "modified":
            self._handler.on_modified(event)
        elif event.event_type == "deleted":
            self._handler.on_deleted(event)
        elif event.event_type == "moved":
            self._handler.on_moved(event)
