"""v2.29 — MCP audit ledger tests (ROADMAP V2 P0 #3).

Covers:
  - record() + recent_entries() round-trip
  - filter by tool / scope / success
  - stats() aggregation
  - hash_bearer redacts (never leaks raw token)
  - summarize_args drops raw string values, keeps keys + lengths
  - record() never raises on OSError (audit must not break MCP path)
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from audit.mcp_ledger import MCPLedger, hash_bearer, summarize_args


# ── Helpers ──────────────────────────────────────────────────────────


@pytest.fixture
def ledger_file(tmp_path: Path) -> Path:
    """Per-test ledger path under tmp_path so we don't touch user data."""
    return tmp_path / "mcp_audit.jsonl"


@pytest.fixture
def ledger(ledger_file: Path) -> MCPLedger:
    return MCPLedger(path=ledger_file)


# ── hash_bearer ──────────────────────────────────────────────────────


class TestHashBearer:
    def test_returns_none_for_empty_bearer(self) -> None:
        assert hash_bearer(None) is None
        assert hash_bearer("") is None

    def test_returns_short_sha256_for_real_token(self) -> None:
        h = hash_bearer("a-secret-token-12345")
        assert h is not None
        assert h.startswith("sha256:")
        # First 12 hex chars after the prefix.
        assert len(h) == len("sha256:") + 12

    def test_deterministic_across_calls(self) -> None:
        assert hash_bearer("same") == hash_bearer("same")

    def test_different_tokens_yield_different_hashes(self) -> None:
        assert hash_bearer("a") != hash_bearer("b")

    def test_hash_does_not_leak_token(self) -> None:
        token = "supersecret-do-not-leak"
        h = hash_bearer(token)
        assert h is not None
        assert token not in h


# ── summarize_args ───────────────────────────────────────────────────


class TestSummarizeArgs:
    def test_string_values_become_length_only(self) -> None:
        out = summarize_args({"content": "hello world"})
        assert out == {"content": {"len": 11}}
        # Raw string MUST NOT appear.
        assert "hello world" not in json.dumps(out)

    def test_scalars_preserved(self) -> None:
        out = summarize_args(
            {"count": 5, "ratio": 0.7, "enabled": True, "ignore": None}
        )
        assert out == {"count": 5, "ratio": 0.7, "enabled": True, "ignore": None}

    def test_lists_collapse_to_length(self) -> None:
        out = summarize_args({"items": ["a", "b", "c"]})
        assert out == {"items": {"len": 3}}

    def test_nested_dict_keeps_keys_only(self) -> None:
        out = summarize_args({"opts": {"a": "secret", "b": "secret2"}})
        assert out == {"opts": {"keys": ["a", "b"]}}
        # Nested string values MUST NOT appear.
        assert "secret" not in json.dumps(out)

    def test_non_dict_input_returns_type_only(self) -> None:
        assert summarize_args("hello") == {"_type": "str"}
        assert summarize_args([1, 2, 3]) == {"_type": "list"}


# ── record / recent_entries / stats ──────────────────────────────────


class TestRecord:
    def test_record_then_recent_entries_round_trip(self, ledger: MCPLedger) -> None:
        ledger.record(
            tool="memory_store",
            scope="write",
            success=True,
            latency_ms=12.34,
            args_summary={"level": "L3", "content": {"len": 42}},
            result_preview='{"ok":true}',
            bearer_id="sha256:abcdef012345",
        )
        rows = ledger.recent_entries()
        assert len(rows) == 1
        row = rows[0]
        assert row["tool"] == "memory_store"
        assert row["scope"] == "write"
        assert row["success"] is True
        assert row["latency_ms"] == 12.34
        assert row["args_summary"] == {"level": "L3", "content": {"len": 42}}
        assert row["result_preview"] == '{"ok":true}'
        assert row["bearer_id"] == "sha256:abcdef012345"
        assert "ts" in row

    def test_recent_entries_returns_newest_first(self, ledger: MCPLedger) -> None:
        for i in range(3):
            ledger.record(
                tool=f"tool-{i}",
                scope="read",
                success=True,
                latency_ms=1.0,
            )
        rows = ledger.recent_entries()
        assert [r["tool"] for r in rows] == ["tool-2", "tool-1", "tool-0"]

    def test_filter_by_tool(self, ledger: MCPLedger) -> None:
        ledger.record(tool="a", scope="read", success=True, latency_ms=1.0)
        ledger.record(tool="b", scope="read", success=True, latency_ms=1.0)
        ledger.record(tool="a", scope="write", success=True, latency_ms=1.0)
        rows = ledger.recent_entries(tool="a")
        assert len(rows) == 2
        assert all(r["tool"] == "a" for r in rows)

    def test_filter_by_scope(self, ledger: MCPLedger) -> None:
        ledger.record(tool="a", scope="read", success=True, latency_ms=1.0)
        ledger.record(tool="b", scope="write", success=True, latency_ms=1.0)
        rows = ledger.recent_entries(scope="write")
        assert len(rows) == 1
        assert rows[0]["tool"] == "b"

    def test_filter_by_success(self, ledger: MCPLedger) -> None:
        ledger.record(tool="a", scope="read", success=True, latency_ms=1.0)
        ledger.record(tool="b", scope="read", success=False, latency_ms=1.0, error="boom")
        rows = ledger.recent_entries(success=False)
        assert len(rows) == 1
        assert rows[0]["tool"] == "b"
        assert rows[0]["error"] == "boom"

    def test_limit_clamps_returned_count(self, ledger: MCPLedger) -> None:
        for i in range(5):
            ledger.record(tool=f"t-{i}", scope="read", success=True, latency_ms=1.0)
        assert len(ledger.recent_entries(limit=2)) == 2

    def test_empty_ledger_returns_empty_list(self, ledger_file: Path) -> None:
        l = MCPLedger(path=ledger_file)
        assert l.recent_entries() == []

    def test_record_truncates_result_preview_at_200(self, ledger: MCPLedger) -> None:
        big = "x" * 1000
        ledger.record(
            tool="t",
            scope="read",
            success=True,
            latency_ms=1.0,
            result_preview=big,
        )
        row = ledger.recent_entries()[0]
        assert row["result_preview"] is not None
        assert len(row["result_preview"]) == 200

    def test_malformed_lines_skipped(self, ledger: MCPLedger, ledger_file: Path) -> None:
        ledger.record(tool="ok", scope="read", success=True, latency_ms=1.0)
        # Inject a garbage line directly into the file.
        with open(ledger_file, "a", encoding="utf-8") as fp:
            fp.write("THIS-IS-NOT-JSON\n")
        ledger.record(tool="ok2", scope="read", success=True, latency_ms=1.0)
        tools = [r["tool"] for r in ledger.recent_entries()]
        # Both valid records survive, garbage line silently dropped.
        assert tools == ["ok2", "ok"]


# ── stats ────────────────────────────────────────────────────────────


class TestStats:
    def test_empty_stats(self, ledger: MCPLedger) -> None:
        s = ledger.stats()
        assert s == {
            "total": 0,
            "by_tool": {},
            "by_scope": {},
            "success": 0,
            "failure": 0,
        }

    def test_aggregates_counts(self, ledger: MCPLedger) -> None:
        ledger.record(tool="a", scope="read", success=True, latency_ms=1.0)
        ledger.record(tool="a", scope="read", success=False, latency_ms=1.0)
        ledger.record(tool="b", scope="write", success=True, latency_ms=1.0)
        s = ledger.stats()
        assert s["total"] == 3
        assert s["by_tool"] == {"a": 2, "b": 1}
        assert s["by_scope"] == {"read": 2, "write": 1}
        assert s["success"] == 2
        assert s["failure"] == 1


# ── Robustness ───────────────────────────────────────────────────────


class TestRobustness:
    def test_record_with_unwritable_path_does_not_raise(self, tmp_path: Path) -> None:
        """Audit must never break the MCP path — even if disk is full."""
        bad = tmp_path / "no" / "such" / "subdir" / "audit.jsonl"
        l = MCPLedger(path=bad)
        # Delete the parent we tried to create so write definitely fails.
        # On Linux/macOS rm of a nonexistent path is fine.
        try:
            os.rmdir(bad.parent)
        except OSError:
            pass
        # Should NOT raise even though we know the path is broken.
        l.record(tool="t", scope="read", success=True, latency_ms=1.0)
        # And reads from a missing path return [].
        assert l.recent_entries() == []

    def test_disabled_via_env(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setenv("WEBRAIN_MCP_AUDIT_DISABLED", "1")
        l = MCPLedger(path=tmp_path / "audit.jsonl")
        l.record(tool="t", scope="read", success=True, latency_ms=1.0)
        # When disabled, record is a no-op and the file should not exist.
        assert not (tmp_path / "audit.jsonl").exists()
        assert l.recent_entries() == []
