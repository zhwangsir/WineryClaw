"""Network Outgoing Audit Ledger — v2.16 (Axis 3).

Append-only JSONL ledger of every outbound LLM HTTP request so the user
can audit at any time "where did my data actually go". One line per
call; structure stable, evolution-safe.

Default location:  ~/.webrain/network_ledger.jsonl
Override via env:  WEBRAIN_NETWORK_LEDGER_PATH=<absolute path>
Disable via env:   WEBRAIN_NETWORK_LEDGER_DISABLED=1

Each record::

    {
      "ts":             "2026-05-22T08:30:11.123456+00:00",
      "event":          "llm_call",
      "endpoint":       "openai-primary",
      "base_url":       "https://api.openai.com/v1",
      "model":          "gpt-4",
      "success":        true,
      "latency_ms":     842,
      "request_bytes":  4221,
      "response_bytes": 1872,
      "error":          null
    }

Failure rows carry `success=false`, `latency_ms` to the point of failure
(may be null if connection never opened), and `error="ConnectError: ..."`.

Thread safety: append-only O_APPEND on POSIX is atomic at the line
boundary for writes <= PIPE_BUF (typically 4 KiB). Each row well under
that ceiling, so concurrent writers cannot interleave.

This module is intentionally minimal — no rotation, no Pydantic, no DB.
Audit data is read sequentially by `recent_entries()` for the
`GET /audit/network_ledger` endpoint or a CLI consumer.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional

logger = logging.getLogger("webrain.audit.network_ledger")


def _default_ledger_path() -> Path:
    """Resolve ledger path: env > ~/.webrain/network_ledger.jsonl."""
    env_path = os.environ.get("WEBRAIN_NETWORK_LEDGER_PATH")
    if env_path:
        return Path(env_path).expanduser()
    home = Path.home() / ".webrain"
    return home / "network_ledger.jsonl"


def _is_disabled() -> bool:
    return os.environ.get("WEBRAIN_NETWORK_LEDGER_DISABLED") == "1"


def _default_max_bytes() -> int:
    """Hard ceiling for the .jsonl file before single-step rotation kicks
    in. 10 MB is generous for the compact rows here (~150 B each), capped
    so a chatty deployment can't fill the user's disk silently.

    Override via `WEBRAIN_NETWORK_LEDGER_MAX_BYTES`. Set to `0` to
    disable rotation entirely (legacy v2.16 behavior — append forever).
    """
    raw = os.environ.get("WEBRAIN_NETWORK_LEDGER_MAX_BYTES")
    if raw is None:
        return 10 * 1024 * 1024
    try:
        n = int(raw)
        return max(0, n)
    except ValueError:
        logger.warning(
            "Invalid WEBRAIN_NETWORK_LEDGER_MAX_BYTES=%r — defaulting to 10 MB",
            raw,
        )
        return 10 * 1024 * 1024


class NetworkLedger:
    """Append-only audit ledger for outbound LLM HTTP calls.

    Construct once per process via `get_ledger()`. All public methods are
    safe to call concurrently from asyncio tasks (the underlying file
    append is process-level atomic; an in-process `threading.Lock` keeps
    JSON serialization deterministic).
    """

    def __init__(
        self,
        path: Optional[Path] = None,
        *,
        max_bytes: Optional[int] = None,
    ) -> None:
        self.path: Path = path or _default_ledger_path()
        # v2.39: single-step rotation (see mcp_ledger.py for the design).
        # When the active file exceeds `max_bytes` we rename it to
        # `<path>.1` (overwriting any prior `.1`) and continue writing
        # to a fresh empty primary. max_bytes == 0 disables rotation.
        self._max_bytes: int = (
            max_bytes if max_bytes is not None else _default_max_bytes()
        )
        self._lock = Lock()
        self._warned_rotate_err = False
        if not _is_disabled():
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                logger.warning(
                    "Could not create ledger dir %s — ledger disabled this run: %s",
                    self.path.parent,
                    e,
                )

    @property
    def rotated_path(self) -> Path:
        """Path of the single rotated-out file."""
        return self.path.with_suffix(self.path.suffix + ".1")

    def _rotate_if_needed(self) -> None:
        """Atomically rotate active file → `.1` if over `max_bytes`.

        Best-effort. Called with `self._lock` held. Failures are
        logged-once at warn, then debug — never raised (audit must not
        crash the LLM call path).
        """
        if self._max_bytes <= 0:
            return
        try:
            size = self.path.stat().st_size
        except FileNotFoundError:
            return
        except OSError as e:
            logger.debug("network_ledger size-check failed: %s", e)
            return
        if size < self._max_bytes:
            return
        try:
            os.replace(self.path, self.rotated_path)
            logger.info(
                "network_ledger rotated at %d bytes: %s -> %s",
                size,
                self.path,
                self.rotated_path,
            )
        except OSError as e:
            if not self._warned_rotate_err:
                logger.warning(
                    "Could not rotate network_ledger %s -> %s: %s — "
                    "continuing to append (file may grow past max_bytes)",
                    self.path,
                    self.rotated_path,
                    e,
                )
                self._warned_rotate_err = True

    # ── write side ─────────────────────────────────────────────────────

    def record(
        self,
        *,
        event: str = "llm_call",
        endpoint: str,
        base_url: str,
        model: str,
        success: bool,
        latency_ms: Optional[float],
        request_bytes: Optional[int] = None,
        response_bytes: Optional[int] = None,
        error: Optional[str] = None,
    ) -> None:
        """Append a single audit row. Never raises — failures are logged."""
        if _is_disabled():
            return
        entry: Dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "endpoint": endpoint,
            "base_url": base_url,
            "model": model,
            "success": success,
            "latency_ms": (
                round(float(latency_ms), 1) if latency_ms is not None else None
            ),
            "request_bytes": request_bytes,
            "response_bytes": response_bytes,
            "error": error,
        }
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        try:
            with self._lock:
                # v2.39: rotate BEFORE append so a single oversized row
                # still lands in the rotated file. Lock guarantees the
                # rotate+append sequence is atomic w.r.t. other recorders.
                self._rotate_if_needed()
                with open(self.path, "a", encoding="utf-8") as fp:
                    fp.write(line)
        except OSError as e:
            # v2.22: rate-limit this warning. In tests (esp. main-brain pytest
            # with tmp HOME that pytest cleans between modules) the parent dir
            # can vanish, producing ~hundreds of identical noisy lines per run.
            # Log once at warning, then escalate to debug-only.
            if not getattr(self, "_warned_oserror", False):
                logger.warning(
                    "Failed to append network_ledger entry to %s: %s — suppressing further warnings",
                    self.path,
                    e,
                )
                self._warned_oserror = True
            else:
                logger.debug("network_ledger append OSError: %s", e)

    def record_success(
        self,
        endpoint: str,
        base_url: str,
        model: str,
        latency_ms: float,
        request_bytes: int,
        response_bytes: int,
    ) -> None:
        self.record(
            endpoint=endpoint,
            base_url=base_url,
            model=model,
            success=True,
            latency_ms=latency_ms,
            request_bytes=request_bytes,
            response_bytes=response_bytes,
        )

    def record_failure(
        self,
        endpoint: str,
        base_url: str,
        model: str,
        error: str,
        latency_ms: Optional[float] = None,
    ) -> None:
        self.record(
            endpoint=endpoint,
            base_url=base_url,
            model=model,
            success=False,
            latency_ms=latency_ms,
            error=error,
        )

    # ── read side ──────────────────────────────────────────────────────

    def recent_entries(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Return the last `limit` parsed JSONL entries, oldest→newest.

        v2.39: also reads `<path>.1` (the rotated-out file) when present
        so callers don't see history vanish across a rotation boundary.
        `.1` lines come first (older), then active file (newer); the
        oldest→newest contract is preserved.

        Corrupt lines are skipped (best-effort tolerance). Missing files
        return `[]`. The recipient typically reverses for newest-first
        display.
        """
        all_lines: List[str] = []
        for target in (self.rotated_path, self.path):
            if not target.exists():
                continue
            try:
                with open(target, "r", encoding="utf-8") as fp:
                    all_lines.extend(fp.readlines())
            except OSError as e:
                logger.warning("Failed to read %s: %s", target, e)
        out: List[Dict[str, Any]] = []
        # Tail-N across the combined oldest→newest stream.
        for line in all_lines[-limit:]:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    def count(self) -> int:
        """Total rows across active + rotated file. 0 if both missing."""
        total = 0
        for target in (self.path, self.rotated_path):
            if not target.exists():
                continue
            try:
                with open(target, "r", encoding="utf-8") as fp:
                    total += sum(1 for line in fp if line.strip())
            except OSError:
                continue
        return total


# Module-level singleton for the running process.
_singleton: Optional[NetworkLedger] = None
_singleton_lock = Lock()


def get_ledger() -> NetworkLedger:
    """Lazy singleton accessor used by chat_engine.py and the audit API."""
    global _singleton
    with _singleton_lock:
        if _singleton is None:
            _singleton = NetworkLedger()
    return _singleton


def reset_ledger_for_tests(path: Optional[Path] = None) -> NetworkLedger:
    """Test-only helper — wipe singleton and reinit with a fresh path."""
    global _singleton
    with _singleton_lock:
        _singleton = NetworkLedger(path=path)
    return _singleton
