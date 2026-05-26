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


# ── v2.39 — Single-step file rotation ────────────────────────────────


class TestRotation:
    """Verify the single-step rotation introduced in v2.39 keeps the
    ledger file size bounded while preserving cross-rotation history.

    Design recap: when the active file exceeds `max_bytes`, it is
    renamed to `<path>.1` (overwriting any prior `.1`) and new writes
    create a fresh empty active file. Read paths (`recent_entries` and
    `stats`) read from `.1` first, then active, so history is seamless.
    """

    def test_rotation_kicks_in_at_max_bytes(self, tmp_path: Path) -> None:
        # Each row is ~200 bytes; cap at 600 bytes so 3-4 rows triggers
        # rotation. Test runs in <50ms.
        path = tmp_path / "audit.jsonl"
        l = MCPLedger(path=path, max_bytes=600)
        for i in range(10):
            l.record(
                tool=f"tool_{i}",
                scope="write",
                success=True,
                latency_ms=1.0,
                args_summary={"i": i},
            )
        # After 10 records, .1 must exist (rotation happened at least once).
        assert l.rotated_path.exists(), "rotated file .1 should be created"
        # Disk usage bounded: "check-then-write" lets active grow up to
        # ~2× max_bytes before the next rotate fires.
        assert path.stat().st_size < 2 * 600

    def test_recent_entries_spans_rotated_and_active(self, tmp_path: Path) -> None:
        """After rotation, recent_entries must read from BOTH files so
        the UI doesn't lose history at the latest rotation boundary.

        We stage the file state directly (rather than triggering rotation
        via record() calls — which depends on per-row byte size and could
        be brittle) so the assertion is on the read-path behavior only.
        """
        path = tmp_path / "audit.jsonl"
        l = MCPLedger(path=path, max_bytes=10_000)  # high cap, no live rotation
        # Stage a `.1` file containing older rows.
        l.rotated_path.write_text(
            json.dumps({"ts": "T0", "tool": "old_0", "scope": "read", "success": True}) + "\n"
            + json.dumps({"ts": "T1", "tool": "old_1", "scope": "read", "success": True}) + "\n",
            encoding="utf-8",
        )
        # Write a fresh active entry.
        l.record(tool="new_2", scope="read", success=True, latency_ms=1.0)

        entries = l.recent_entries(limit=10)
        # All 3 visible (2 rotated + 1 active), newest-first.
        assert [e["tool"] for e in entries] == ["new_2", "old_1", "old_0"]

    def test_stats_spans_rotated_and_active(self, tmp_path: Path) -> None:
        """Same as above but for stats() aggregation."""
        path = tmp_path / "audit.jsonl"
        l = MCPLedger(path=path, max_bytes=10_000)
        # Stage .1 with 3 successes + 1 failure on tool "a"
        rotated_lines = [
            json.dumps({"tool": "a", "scope": "read", "success": True}),
            json.dumps({"tool": "a", "scope": "read", "success": True}),
            json.dumps({"tool": "a", "scope": "read", "success": True}),
            json.dumps({"tool": "a", "scope": "read", "success": False}),
        ]
        l.rotated_path.write_text("\n".join(rotated_lines) + "\n", encoding="utf-8")
        # Add 2 active rows on tool "b"
        l.record(tool="b", scope="write", success=True, latency_ms=1.0)
        l.record(tool="b", scope="write", success=False, latency_ms=1.0)

        s = l.stats()
        # Across both files: 6 total, by_tool={a:4, b:2}, success=4, failure=2
        assert s["total"] == 6
        assert s["by_tool"] == {"a": 4, "b": 2}
        assert s["by_scope"] == {"read": 4, "write": 2}
        assert s["success"] == 4
        assert s["failure"] == 2

    def test_max_bytes_zero_disables_rotation(self, tmp_path: Path) -> None:
        """`max_bytes=0` preserves legacy v2.29 behavior (no rotation)."""
        path = tmp_path / "audit.jsonl"
        l = MCPLedger(path=path, max_bytes=0)
        for i in range(30):
            l.record(tool="t", scope="read", success=True, latency_ms=1.0)
        # No .1 ever created.
        assert not l.rotated_path.exists()
        # All 30 in the single active file.
        assert l.stats()["total"] == 30

    def test_default_max_bytes_is_10mb(self) -> None:
        """The default cap should NOT trigger on typical test fixtures.

        We don't want every test in the repo to accidentally start
        rotating mid-run because the default became too small.
        """
        from audit.mcp_ledger import _default_max_bytes

        assert _default_max_bytes() == 10 * 1024 * 1024

    def test_env_override_for_max_bytes(self, monkeypatch) -> None:
        from audit.mcp_ledger import _default_max_bytes

        monkeypatch.setenv("WEBRAIN_MCP_AUDIT_MAX_BYTES", "1024")
        assert _default_max_bytes() == 1024
        monkeypatch.setenv("WEBRAIN_MCP_AUDIT_MAX_BYTES", "0")
        assert _default_max_bytes() == 0
        # Invalid value falls back to default.
        monkeypatch.setenv("WEBRAIN_MCP_AUDIT_MAX_BYTES", "not-a-number")
        assert _default_max_bytes() == 10 * 1024 * 1024
        # Negative clamps to 0 (rotation disabled).
        monkeypatch.setenv("WEBRAIN_MCP_AUDIT_MAX_BYTES", "-5")
        assert _default_max_bytes() == 0

    def test_rotation_overwrites_prior_dot1(self, tmp_path: Path) -> None:
        """Single-step rotation: when called twice the .1 file is
        OVERWRITTEN, not accumulated as .1, .2, .3 — this is the design
        trade-off (bounded disk usage vs unbounded multi-generation log
        rotation). We verify by staging an initial .1 with sentinel
        content and ensuring it's gone after a triggered rotation.
        """
        path = tmp_path / "audit.jsonl"
        # Stage a pre-existing .1 with a sentinel.
        sentinel_line = json.dumps({"tool": "OLD_SENTINEL", "scope": "x"}) + "\n"
        rotated = path.with_suffix(path.suffix + ".1")
        rotated.write_text(sentinel_line, encoding="utf-8")

        # Now trigger rotation: fill active past max_bytes, then write
        # one more to cause rotate.
        l = MCPLedger(path=path, max_bytes=200)
        for i in range(5):
            l.record(tool=f"new_{i}", scope="write", success=True, latency_ms=1.0)
        # After enough writes, .1 must have been overwritten — the
        # OLD_SENTINEL is gone.
        assert l.rotated_path.exists()
        rotated_text = l.rotated_path.read_text(encoding="utf-8")
        assert "OLD_SENTINEL" not in rotated_text, (
            "single-step rotation must OVERWRITE prior .1, but old sentinel "
            "is still present — multi-generation rotation slipped in"
        )
        # And no .2 / .3 etc was created.
        assert not (tmp_path / "audit.jsonl.2").exists()

    def test_rotation_failure_does_not_break_record(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        """A failed rotation must still allow record() to append (degraded
        mode) — audit ledger NEVER crashes the MCP path."""
        import audit.mcp_ledger as mod

        path = tmp_path / "audit.jsonl"
        l = MCPLedger(path=path, max_bytes=200)
        # Fill once to seed the active file.
        for i in range(5):
            l.record(tool="seed", scope="read", success=True, latency_ms=1.0)

        # Simulate rename failure on the NEXT rotation attempt.
        def boom(*_a, **_kw):
            raise OSError("simulated rename failure")

        monkeypatch.setattr(mod.os, "replace", boom)
        # Should not raise; should still append.
        l.record(tool="post_fail", scope="read", success=True, latency_ms=1.0)
        # The active file now exists and contains at least the post_fail row.
        entries = l.recent_entries(limit=100)
        assert any(e["tool"] == "post_fail" for e in entries)
