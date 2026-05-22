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


class NetworkLedger:
    """Append-only audit ledger for outbound LLM HTTP calls.

    Construct once per process via `get_ledger()`. All public methods are
    safe to call concurrently from asyncio tasks (the underlying file
    append is process-level atomic; an in-process `threading.Lock` keeps
    JSON serialization deterministic).
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path: Path = path or _default_ledger_path()
        self._lock = Lock()
        if not _is_disabled():
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                logger.warning(
                    "Could not create ledger dir %s — ledger disabled this run: %s",
                    self.path.parent,
                    e,
                )

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
                with open(self.path, "a", encoding="utf-8") as fp:
                    fp.write(line)
        except OSError as e:
            logger.warning("Failed to append network_ledger entry: %s", e)

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

        Corrupt lines are skipped (best-effort tolerance). Missing file
        returns `[]`. The recipient typically reverses if newest-first
        order is required.
        """
        if not self.path.exists():
            return []
        try:
            with open(self.path, "r", encoding="utf-8") as fp:
                # Tail-N: read whole file (audit logs are small),
                # take last N lines.
                lines = fp.readlines()
        except OSError as e:
            logger.warning("Failed to read network_ledger: %s", e)
            return []
        out: List[Dict[str, Any]] = []
        for line in lines[-limit:]:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    def count(self) -> int:
        """Total rows in the ledger. 0 if file missing."""
        if not self.path.exists():
            return 0
        try:
            with open(self.path, "r", encoding="utf-8") as fp:
                return sum(1 for line in fp if line.strip())
        except OSError:
            return 0


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
