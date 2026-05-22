"""v2.16 — Axis 3: NetworkLedger unit tests.

Verifies:
- record_success / record_failure write a valid JSONL line
- recent_entries returns parsed dicts in chronological order
- disabled env var fully suppresses writes
- corrupt lines tolerated by recent_entries
- ledger path env override respected
- count() returns row total
"""

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from audit import network_ledger as nl_module
from audit.network_ledger import NetworkLedger, get_ledger, reset_ledger_for_tests


@pytest.fixture
def tmp_ledger(tmp_path: Path):
    """Fresh ledger pointing at tmp file; resets module singleton."""
    path = tmp_path / "ledger.jsonl"
    ledger = reset_ledger_for_tests(path=path)
    yield ledger
    # Cleanup singleton after each test
    nl_module._singleton = None


class TestRecordSuccess:
    def test_writes_valid_jsonl(self, tmp_ledger):
        tmp_ledger.record_success(
            endpoint="openai-primary",
            base_url="https://api.openai.com/v1",
            model="gpt-4",
            latency_ms=812.5,
            request_bytes=1024,
            response_bytes=512,
        )
        lines = tmp_ledger.path.read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["endpoint"] == "openai-primary"
        assert entry["base_url"] == "https://api.openai.com/v1"
        assert entry["model"] == "gpt-4"
        assert entry["success"] is True
        assert entry["latency_ms"] == 812.5
        assert entry["request_bytes"] == 1024
        assert entry["response_bytes"] == 512
        assert entry["error"] is None
        # Timestamp is ISO-8601 with UTC offset
        assert "T" in entry["ts"]
        assert "+00:00" in entry["ts"]

    def test_multiple_records_appended(self, tmp_ledger):
        for i in range(5):
            tmp_ledger.record_success(
                endpoint=f"ep-{i}",
                base_url="https://x",
                model="m",
                latency_ms=100.0 + i,
                request_bytes=100,
                response_bytes=100,
            )
        lines = tmp_ledger.path.read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 5

    def test_latency_rounded(self, tmp_ledger):
        tmp_ledger.record_success(
            endpoint="e", base_url="u", model="m",
            latency_ms=812.567894, request_bytes=10, response_bytes=10,
        )
        entry = json.loads(tmp_ledger.path.read_text().strip())
        # Rounded to 1 decimal
        assert entry["latency_ms"] == 812.6


class TestRecordFailure:
    def test_writes_failure_row(self, tmp_ledger):
        tmp_ledger.record_failure(
            endpoint="anthropic",
            base_url="https://api.anthropic.com/v1",
            model="claude-3",
            error="ConnectError: timeout",
            latency_ms=5000.0,
        )
        entry = json.loads(tmp_ledger.path.read_text().strip())
        assert entry["success"] is False
        assert entry["error"] == "ConnectError: timeout"
        assert entry["latency_ms"] == 5000.0
        # request/response bytes None on failure
        assert entry["request_bytes"] is None
        assert entry["response_bytes"] is None

    def test_failure_without_latency(self, tmp_ledger):
        tmp_ledger.record_failure(
            endpoint="e", base_url="u", model="m",
            error="DNS lookup failed",
        )
        entry = json.loads(tmp_ledger.path.read_text().strip())
        assert entry["success"] is False
        assert entry["latency_ms"] is None


class TestRecentEntries:
    def test_empty_file_returns_empty(self, tmp_ledger):
        assert tmp_ledger.recent_entries() == []

    def test_returns_chronological(self, tmp_ledger):
        for i in range(3):
            tmp_ledger.record_success(
                endpoint=f"ep-{i}", base_url="u", model="m",
                latency_ms=float(i), request_bytes=0, response_bytes=0,
            )
        entries = tmp_ledger.recent_entries()
        assert [e["endpoint"] for e in entries] == ["ep-0", "ep-1", "ep-2"]

    def test_limit_caps_results(self, tmp_ledger):
        for i in range(10):
            tmp_ledger.record_success(
                endpoint=f"ep-{i}", base_url="u", model="m",
                latency_ms=0.0, request_bytes=0, response_bytes=0,
            )
        entries = tmp_ledger.recent_entries(limit=3)
        assert len(entries) == 3
        # Tail-3: last 3 endpoints
        assert [e["endpoint"] for e in entries] == ["ep-7", "ep-8", "ep-9"]

    def test_corrupt_line_skipped(self, tmp_ledger):
        # Write 2 valid + 1 garbage line
        tmp_ledger.record_success(
            endpoint="a", base_url="u", model="m",
            latency_ms=1.0, request_bytes=0, response_bytes=0,
        )
        with open(tmp_ledger.path, "a") as fp:
            fp.write("not-valid-json\n")
        tmp_ledger.record_success(
            endpoint="b", base_url="u", model="m",
            latency_ms=2.0, request_bytes=0, response_bytes=0,
        )
        entries = tmp_ledger.recent_entries()
        # 2 valid only
        assert len(entries) == 2
        assert [e["endpoint"] for e in entries] == ["a", "b"]

    def test_blank_line_skipped(self, tmp_ledger):
        with open(tmp_ledger.path, "w") as fp:
            fp.write("\n\n")
        assert tmp_ledger.recent_entries() == []

    def test_missing_file_returns_empty(self, tmp_path):
        ledger = NetworkLedger(path=tmp_path / "nope.jsonl")
        assert ledger.recent_entries() == []


class TestCount:
    def test_empty_returns_zero(self, tmp_ledger):
        assert tmp_ledger.count() == 0

    def test_returns_total_rows(self, tmp_ledger):
        for i in range(7):
            tmp_ledger.record_success(
                endpoint=f"e{i}", base_url="u", model="m",
                latency_ms=0.0, request_bytes=0, response_bytes=0,
            )
        assert tmp_ledger.count() == 7

    def test_missing_file_zero(self, tmp_path):
        ledger = NetworkLedger(path=tmp_path / "nope.jsonl")
        assert ledger.count() == 0


class TestDisabledMode:
    def test_disabled_env_no_writes(self, tmp_path, monkeypatch):
        monkeypatch.setenv("WEBRAIN_NETWORK_LEDGER_DISABLED", "1")
        ledger = NetworkLedger(path=tmp_path / "ledger.jsonl")
        ledger.record_success(
            endpoint="e", base_url="u", model="m",
            latency_ms=1.0, request_bytes=10, response_bytes=10,
        )
        # File never created
        assert not (tmp_path / "ledger.jsonl").exists()


class TestPathOverride:
    def test_env_path_respected(self, tmp_path, monkeypatch):
        custom = tmp_path / "custom.jsonl"
        monkeypatch.setenv("WEBRAIN_NETWORK_LEDGER_PATH", str(custom))
        ledger = NetworkLedger()  # picks up env
        assert ledger.path == custom

    def test_no_env_uses_home(self, monkeypatch):
        monkeypatch.delenv("WEBRAIN_NETWORK_LEDGER_PATH", raising=False)
        # Mock Path.home() so we don't depend on actual home
        with patch("audit.network_ledger.Path.home") as mock_home:
            mock_home.return_value = Path("/tmp/fake-home")
            ledger = NetworkLedger()
            assert str(ledger.path) == "/tmp/fake-home/.webrain/network_ledger.jsonl"


class TestSingleton:
    def test_get_ledger_same_instance(self, tmp_path, monkeypatch):
        monkeypatch.setenv(
            "WEBRAIN_NETWORK_LEDGER_PATH", str(tmp_path / "x.jsonl")
        )
        # Reset singleton
        nl_module._singleton = None
        a = get_ledger()
        b = get_ledger()
        assert a is b
        # Clean up
        nl_module._singleton = None

    def test_reset_helper_makes_new_instance(self, tmp_path):
        nl_module._singleton = None
        a = reset_ledger_for_tests(path=tmp_path / "a.jsonl")
        b = reset_ledger_for_tests(path=tmp_path / "b.jsonl")
        assert a is not b
        assert b.path == tmp_path / "b.jsonl"
        nl_module._singleton = None


class TestUnicodeAndLargePayload:
    def test_chinese_characters_roundtrip(self, tmp_ledger):
        tmp_ledger.record_success(
            endpoint="zh-endpoint",
            base_url="https://api.example.cn/v1",
            model="智谱清言",
            latency_ms=100.0,
            request_bytes=200,
            response_bytes=400,
        )
        entry = json.loads(tmp_ledger.path.read_text(encoding="utf-8").strip())
        assert entry["model"] == "智谱清言"

    def test_long_error_message_preserved(self, tmp_ledger):
        long_err = "ConnectError: " + ("very long stack trace " * 50)
        tmp_ledger.record_failure(
            endpoint="e", base_url="u", model="m", error=long_err,
        )
        entry = json.loads(tmp_ledger.path.read_text(encoding="utf-8").strip())
        assert entry["error"] == long_err
