"""Tests for the MCP stdio↔HTTP bridge script (M4b)."""

from __future__ import annotations

import io
import json
import sys
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# The bridge lives at sub-brain/main-brain/tools/mcp_stdio_bridge.py.
# Add that dir to sys.path so we can import it directly.
_BRIDGE_DIR = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(_BRIDGE_DIR))

import mcp_stdio_bridge  # noqa: E402


def _make_urlopen_mock(status: int = 200, body: bytes = b'{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'):
    """Build a context-manager mock matching urllib.request.urlopen()."""
    mgr = MagicMock()
    mgr.__enter__ = MagicMock(return_value=MagicMock(status=status, read=MagicMock(return_value=body)))
    mgr.__exit__ = MagicMock(return_value=False)
    return mgr


class TestPostJson:
    def test_returns_parsed_json_on_200(self) -> None:
        with patch.object(
            mcp_stdio_bridge.urllib.request,
            "urlopen",
            return_value=_make_urlopen_mock(),
        ):
            result = mcp_stdio_bridge._post_json(
                "http://x/jsonrpc", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, 5.0
            )
        assert result == {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}

    def test_returns_none_on_204(self) -> None:
        with patch.object(
            mcp_stdio_bridge.urllib.request,
            "urlopen",
            return_value=_make_urlopen_mock(status=204, body=b""),
        ):
            result = mcp_stdio_bridge._post_json(
                "http://x/jsonrpc", {"jsonrpc": "2.0", "method": "ping"}, 5.0
            )
        assert result is None

    def test_http_error_returned_as_jsonrpc_error_envelope(self) -> None:
        err = urllib.error.HTTPError(
            "http://x", 500, "Internal Server Error", {}, io.BytesIO(b'{"detail": "boom"}')
        )
        with patch.object(mcp_stdio_bridge.urllib.request, "urlopen", side_effect=err):
            result = mcp_stdio_bridge._post_json(
                "http://x/jsonrpc", {"jsonrpc": "2.0", "id": 7, "method": "ping"}, 5.0
            )
        assert result["jsonrpc"] == "2.0"
        assert result["id"] == 7
        assert result["error"]["code"] == -32000
        assert "HTTP 500" in result["error"]["message"]

    def test_transport_error_returned_as_jsonrpc_error_envelope(self) -> None:
        with patch.object(
            mcp_stdio_bridge.urllib.request,
            "urlopen",
            side_effect=ConnectionRefusedError("no listener"),
        ):
            result = mcp_stdio_bridge._post_json(
                "http://x/jsonrpc", {"jsonrpc": "2.0", "id": 7, "method": "ping"}, 5.0
            )
        assert result["error"]["code"] == -32603
        assert "transport error" in result["error"]["message"]


class TestMainStdioLoop:
    def _run_with_stdin(self, lines):
        """Drive the bridge's stdin loop with `lines` and capture stdout."""
        stdin = io.StringIO("\n".join(lines) + "\n" if lines else "")
        stdout = io.StringIO()
        with patch("sys.stdin", stdin), redirect_stdout(stdout):
            code = mcp_stdio_bridge.main(["--url", "http://x/jsonrpc"])
        return code, stdout.getvalue()

    def test_parse_error_emits_jsonrpc_envelope_on_stdout(self) -> None:
        # Don't even need to mock urlopen — invalid JSON never reaches HTTP
        code, out = self._run_with_stdin(["{not valid json"])
        assert code == 0
        lines = [l for l in out.splitlines() if l.strip()]
        assert len(lines) == 1
        env = json.loads(lines[0])
        assert env["error"]["code"] == -32700
        assert "parse error" in env["error"]["message"]

    def test_valid_request_is_forwarded_and_response_written(self) -> None:
        with patch.object(
            mcp_stdio_bridge.urllib.request,
            "urlopen",
            return_value=_make_urlopen_mock(),
        ):
            code, out = self._run_with_stdin([
                json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"})
            ])
        assert code == 0
        lines = [l for l in out.splitlines() if l.strip()]
        assert len(lines) == 1
        env = json.loads(lines[0])
        assert env["result"] == {"ok": True}

    def test_notification_produces_no_stdout(self) -> None:
        # 204 response → bridge writes nothing
        with patch.object(
            mcp_stdio_bridge.urllib.request,
            "urlopen",
            return_value=_make_urlopen_mock(status=204, body=b""),
        ):
            code, out = self._run_with_stdin([
                json.dumps({"jsonrpc": "2.0", "method": "ping"})  # no id → notification
            ])
        assert code == 0
        assert out.strip() == ""

    def test_blank_lines_skipped(self) -> None:
        with patch.object(
            mcp_stdio_bridge.urllib.request,
            "urlopen",
            return_value=_make_urlopen_mock(),
        ) as urlopen:
            code, out = self._run_with_stdin([
                "",
                "   ",
                json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}),
                "",
            ])
        assert code == 0
        # Exactly one HTTP call, exactly one response line
        assert urlopen.call_count == 1
        lines = [l for l in out.splitlines() if l.strip()]
        assert len(lines) == 1
