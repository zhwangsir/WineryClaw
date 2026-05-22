"""MCP Tool Invocation Audit Ledger — v2.29 (ROADMAP V2 P0 #3).

Append-only JSONL ledger of every MCP `tools/call` invocation so the
user can audit at any time "what did my MCP plugins actually do to my
data". One line per call; structure stable, evolution-safe.

Default location:  ~/.webrain/mcp_audit.jsonl
Override via env:  WEBRAIN_MCP_AUDIT_PATH=<absolute path>
Disable via env:   WEBRAIN_MCP_AUDIT_DISABLED=1

Each record::

    {
      "ts":              "2026-05-22T11:00:00.123456+00:00",
      "tool":            "memory_store",
      "scope":           "write",
      "success":         true,
      "latency_ms":      14.7,
      "args_summary":    {"level": "L3", "content_len": 42},
      "result_preview":  "{\"ok\": true, \"id\": ...}",
      "error":           null,
      "bearer_id":       "sha256:7c0a..." or null,
      "request_id":      "req-abc"
    }

Failure rows carry `success=false`, `error="..."`. `bearer_id` is the
first 12 chars of `sha256(token)` if a token was provided — never the
raw token. `args_summary` is a redacted view (keys + length / truthiness)
so we don't leak large/sensitive payloads to disk; the actual arguments
are only in process memory during the call.

Threading: same as NetworkLedger — append-only O_APPEND atomicity + a
threading.Lock for in-process serialization. One line per record stays
under PIPE_BUF.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional

logger = logging.getLogger("webrain.audit.mcp_ledger")


def _default_path() -> Path:
    env_path = os.environ.get("WEBRAIN_MCP_AUDIT_PATH")
    if env_path:
        return Path(env_path).expanduser()
    return Path.home() / ".webrain" / "mcp_audit.jsonl"


def _is_disabled() -> bool:
    return os.environ.get("WEBRAIN_MCP_AUDIT_DISABLED") == "1"


def hash_bearer(bearer: Optional[str]) -> Optional[str]:
    """Return a deterministic short identifier for a bearer token.

    The full SHA-256 of an MCP token is itself sensitive (still functions
    as a fingerprint), so we truncate to 12 hex chars — enough to
    distinguish callers in an audit log, not enough to brute-force back
    to the original token. Returns None on empty input.
    """
    if not bearer:
        return None
    digest = hashlib.sha256(bearer.encode("utf-8")).hexdigest()
    return f"sha256:{digest[:12]}"


def summarize_args(arguments: Any) -> Dict[str, Any]:
    """Produce a redacted summary of tool-call arguments for the audit log.

    Goals:
      - Keep keys (so reader knows what fields were used).
      - Replace string values with `{"len": N}` (length only).
      - Keep small ints / bools / nulls verbatim.
      - Lists collapse to `{"len": N}`.
      - Nested dicts recurse (bounded to 1 level — beyond that we just
        store `{"keys": [...]}`).
    Caller-supplied secret-style fields are never leaked because we never
    store raw string values.
    """
    if not isinstance(arguments, dict):
        return {"_type": type(arguments).__name__}
    out: Dict[str, Any] = {}
    for k, v in arguments.items():
        if isinstance(v, str):
            out[k] = {"len": len(v)}
        elif isinstance(v, bool) or v is None:
            out[k] = v
        elif isinstance(v, (int, float)):
            out[k] = v
        elif isinstance(v, list):
            out[k] = {"len": len(v)}
        elif isinstance(v, dict):
            # 1-level recursion ceiling — store keys but not values.
            out[k] = {"keys": list(v.keys())[:32]}
        else:
            out[k] = {"_type": type(v).__name__}
    return out


class MCPLedger:
    """Append-only audit ledger for MCP `tools/call` invocations.

    Construct once per process via `get_mcp_ledger()`. All record() calls
    are safe to fire-and-forget from asyncio handlers.
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path: Path = path or _default_path()
        self._lock = Lock()
        # Rate-limit OSError warnings so test fixtures with disappearing
        # HOME don't spam the log.
        self._warned_oserror = False
        if not _is_disabled():
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                logger.warning(
                    "Could not create MCP audit dir %s — disabled this run: %s",
                    self.path.parent,
                    e,
                )

    def record(
        self,
        *,
        tool: str,
        scope: str,
        success: bool,
        latency_ms: Optional[float],
        args_summary: Optional[Dict[str, Any]] = None,
        result_preview: Optional[str] = None,
        error: Optional[str] = None,
        bearer_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> None:
        """Append one row to the ledger. Safe to call from any thread.

        Never raises — audit must NEVER break the actual MCP path. OSError
        is logged at warn-once then debug.
        """
        if _is_disabled():
            return
        entry: Dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "tool": tool,
            "scope": scope,
            "success": success,
            "latency_ms": (
                round(latency_ms, 2) if isinstance(latency_ms, (int, float)) else None
            ),
            "args_summary": args_summary or {},
            "result_preview": (result_preview or "")[:200] if result_preview else None,
            "error": error,
            "bearer_id": bearer_id,
            "request_id": request_id,
        }
        line = json.dumps(entry, ensure_ascii=False) + "\n"
        try:
            with self._lock:
                with open(self.path, "a", encoding="utf-8") as fp:
                    fp.write(line)
        except OSError as e:
            if not self._warned_oserror:
                logger.warning(
                    "Failed to append MCP audit entry to %s: %s — suppressing further warnings",
                    self.path,
                    e,
                )
                self._warned_oserror = True
            else:
                logger.debug("MCP audit append OSError: %s", e)

    # ── read side ──────────────────────────────────────────────────────

    def recent_entries(
        self,
        limit: int = 100,
        *,
        tool: Optional[str] = None,
        scope: Optional[str] = None,
        success: Optional[bool] = None,
    ) -> List[Dict[str, Any]]:
        """Tail the ledger; return the most-recent `limit` rows (newest first).

        Filters (all optional, ANDed) — match for inclusion only:
          - tool:     exact match on tool name
          - scope:    "read" | "write"
          - success:  True / False

        Empty ledger or read failure → empty list. Malformed JSON lines
        are skipped silently (audit ledger is forward-evolving; older
        records that don't parse just don't surface).
        """
        if _is_disabled() or not self.path.exists():
            return []
        rows: List[Dict[str, Any]] = []
        try:
            with self._lock:
                with open(self.path, "r", encoding="utf-8") as fp:
                    for line in fp:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if tool is not None and entry.get("tool") != tool:
                            continue
                        if scope is not None and entry.get("scope") != scope:
                            continue
                        if success is not None and entry.get("success") is not success:
                            continue
                        rows.append(entry)
        except OSError as e:
            logger.debug("Failed reading MCP audit ledger: %s", e)
            return []
        # Most recent first — file is chronological, so reverse.
        rows.reverse()
        return rows[:limit]

    def stats(self) -> Dict[str, Any]:
        """Aggregate counters: total / per-tool / per-scope / success-rate.

        Lightweight scan of the whole file; for large ledgers a downstream
        consumer should switch to a streaming/indexed implementation.
        """
        if _is_disabled() or not self.path.exists():
            return {
                "total": 0,
                "by_tool": {},
                "by_scope": {},
                "success": 0,
                "failure": 0,
            }
        by_tool: Dict[str, int] = {}
        by_scope: Dict[str, int] = {}
        success = 0
        failure = 0
        total = 0
        try:
            with self._lock:
                with open(self.path, "r", encoding="utf-8") as fp:
                    for line in fp:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        total += 1
                        t = entry.get("tool") or "?"
                        s = entry.get("scope") or "?"
                        by_tool[t] = by_tool.get(t, 0) + 1
                        by_scope[s] = by_scope.get(s, 0) + 1
                        if entry.get("success"):
                            success += 1
                        else:
                            failure += 1
        except OSError as e:
            logger.debug("Failed reading MCP audit ledger for stats: %s", e)
        return {
            "total": total,
            "by_tool": by_tool,
            "by_scope": by_scope,
            "success": success,
            "failure": failure,
        }


_singleton: Optional[MCPLedger] = None
_singleton_lock = Lock()


def get_mcp_ledger() -> MCPLedger:
    """Process-wide singleton getter."""
    global _singleton
    with _singleton_lock:
        if _singleton is None:
            _singleton = MCPLedger()
        return _singleton
