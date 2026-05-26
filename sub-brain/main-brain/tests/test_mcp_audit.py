"""Tests for the M4b.2 MCP audit log feature.

Covers:
  - audit records successful tool calls
  - audit records failed tool calls (auth, invalid params, handler crash)
  - GET /mcp/audit endpoint returns correct format
  - limit parameter is respected
"""

from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from mcp import MCPServer
from mcp.audit_log import get_audit_logs, init_audit_db, write_audit_log


@pytest.fixture
def audit_db(tmp_path: Path) -> str:
    """Fresh audit DB with initialized schema."""
    db_path = str(tmp_path / "mcp_audit.db")
    init_audit_db(db_path)
    return db_path


def _state_with_memory_mock():
    memory = MagicMock()
    memory.query = AsyncMock(return_value=[{"id": "m1", "content": "x"}])
    memory.store = AsyncMock(return_value={"id": "m-stored"})
    return {"memory": memory}


class TestAuditLogWrite:
    @pytest.mark.asyncio
    async def test_successful_read_tool_call_is_logged(self, audit_db: str) -> None:
        state = _state_with_memory_mock()
        server = MCPServer(state, audit_db_path=audit_db)
        resp = await server.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "webrain_memory_query", "arguments": {"query": "hello"}},
            },
            client_ip="127.0.0.1",
        )
        assert "result" in resp
        logs = get_audit_logs(audit_db, limit=10)
        assert len(logs) == 1
        entry = logs[0]
        assert entry["tool_name"] == "webrain_memory_query"
        assert entry["scope"] == "read"
        assert entry["client_ip"] == "127.0.0.1"
        assert entry["success"] == 1
        assert entry["error_message"] is None

    @pytest.mark.asyncio
    async def test_successful_write_tool_call_is_logged(self, audit_db: str) -> None:
        state = _state_with_memory_mock()
        server = MCPServer(state, expected_token="secret", audit_db_path=audit_db)
        resp = await server.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "webrain_memory_store", "arguments": {"content": "save me"}},
            },
            bearer_token="secret",
            client_ip="192.168.1.2",
        )
        assert "result" in resp
        logs = get_audit_logs(audit_db, limit=10)
        assert len(logs) == 1
        entry = logs[0]
        assert entry["tool_name"] == "webrain_memory_store"
        assert entry["scope"] == "write"
        assert entry["client_ip"] == "192.168.1.2"
        assert entry["success"] == 1
        assert entry["error_message"] is None

    @pytest.mark.asyncio
    async def test_failed_auth_write_tool_is_logged(self, audit_db: str) -> None:
        state = _state_with_memory_mock()
        server = MCPServer(state, expected_token="secret", audit_db_path=audit_db)
        resp = await server.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "webrain_memory_store", "arguments": {"content": "x"}},
            },
            bearer_token="wrong",
            client_ip="10.0.0.1",
        )
        assert "error" in resp
        logs = get_audit_logs(audit_db, limit=10)
        assert len(logs) == 1
        entry = logs[0]
        assert entry["tool_name"] == "webrain_memory_store"
        assert entry["scope"] == "write"
        assert entry["client_ip"] == "10.0.0.1"
        assert entry["success"] == 0
        assert entry["error_message"] is not None
        assert "authentication" in entry["error_message"].lower()

    @pytest.mark.asyncio
    async def test_invalid_params_is_logged(self, audit_db: str) -> None:
        server = MCPServer({}, audit_db_path=audit_db)
        resp = await server.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"arguments": {}},
            },
            client_ip="127.0.0.1",
        )
        assert "error" in resp
        logs = get_audit_logs(audit_db, limit=10)
        assert len(logs) == 1
        entry = logs[0]
        assert entry["tool_name"] == "unknown"
        assert entry["scope"] == "unknown"
        assert entry["success"] == 0
        assert "name" in entry["error_message"].lower()

    @pytest.mark.asyncio
    async def test_handler_crash_is_logged(self, audit_db: str) -> None:
        memory = MagicMock()
        memory.query = AsyncMock(side_effect=RuntimeError("boom"))
        server = MCPServer({"memory": memory}, audit_db_path=audit_db)
        resp = await server.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "webrain_memory_query", "arguments": {"query": "hi"}},
            },
            client_ip="127.0.0.1",
        )
        assert "error" in resp
        logs = get_audit_logs(audit_db, limit=10)
        assert len(logs) == 1
        entry = logs[0]
        assert entry["tool_name"] == "webrain_memory_query"
        assert entry["scope"] == "read"
        assert entry["success"] == 0
        assert "boom" in entry["error_message"]

    @pytest.mark.asyncio
    async def test_no_audit_db_means_no_crash_and_no_log(self, audit_db: str) -> None:
        state = _state_with_memory_mock()
        server = MCPServer(state, audit_db_path=None)
        resp = await server.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "webrain_memory_query", "arguments": {"query": "hello"}},
            },
            client_ip="127.0.0.1",
        )
        assert "result" in resp
        # No DB path set → nothing written
        logs = get_audit_logs(audit_db, limit=10)
        assert len(logs) == 0

    @pytest.mark.asyncio
    async def test_batch_logs_each_tool_call(self, audit_db: str) -> None:
        state = _state_with_memory_mock()
        server = MCPServer(state, audit_db_path=audit_db)
        resp = await server.handle(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": "webrain_memory_query", "arguments": {"query": "a"}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "webrain_memory_query", "arguments": {"query": "b"}},
                },
            ],
            client_ip="127.0.0.1",
        )
        assert isinstance(resp, list)
        assert len(resp) == 2
        logs = get_audit_logs(audit_db, limit=10)
        assert len(logs) == 2


class TestAuditLogQuery:
    def test_get_audit_logs_format(self, audit_db: str) -> None:
        write_audit_log(audit_db, "t1", "read", "1.2.3.4", True, None)
        logs = get_audit_logs(audit_db, limit=10)
        assert len(logs) == 1
        entry = logs[0]
        assert isinstance(entry["id"], int)
        assert isinstance(entry["timestamp"], str)
        assert entry["tool_name"] == "t1"
        assert entry["scope"] == "read"
        assert entry["client_ip"] == "1.2.3.4"
        assert entry["success"] == 1
        assert entry["error_message"] is None

    def test_get_audit_logs_limit(self, audit_db: str) -> None:
        for i in range(5):
            write_audit_log(audit_db, f"tool_{i}", "read", None, True, None)
        logs = get_audit_logs(audit_db, limit=3)
        assert len(logs) == 3
        # Most recent first (descending by id)
        assert logs[0]["tool_name"] == "tool_4"
        assert logs[1]["tool_name"] == "tool_3"
        assert logs[2]["tool_name"] == "tool_2"

    def test_get_audit_logs_default_limit(self, audit_db: str) -> None:
        for i in range(55):
            write_audit_log(audit_db, f"tool_{i}", "read", None, True, None)
        logs = get_audit_logs(audit_db)
        assert len(logs) == 50


class TestMCPAuditEndpoint:
    def test_endpoint_returns_correct_format(self, monkeypatch) -> None:
        import main_brain

        db_path = str(Path(tempfile.mkdtemp()) / "audit_endpoint.db")
        init_audit_db(db_path)
        write_audit_log(db_path, "webrain_memory_store", "write", "10.0.0.1", False, "auth failed")

        monkeypatch.setitem(main_brain._state, "mcp_audit_db_path", db_path)

        import asyncio

        result = asyncio.run(main_brain.mcp_audit(limit=10))
        assert result["ok"] is True
        assert "logs" in result
        assert len(result["logs"]) == 1
        entry = result["logs"][0]
        assert entry["tool_name"] == "webrain_memory_store"
        assert entry["scope"] == "write"
        assert entry["client_ip"] == "10.0.0.1"
        assert entry["success"] == 0
        assert entry["error_message"] == "auth failed"

    def test_endpoint_limit_parameter(self, monkeypatch) -> None:
        import main_brain

        db_path = str(Path(tempfile.mkdtemp()) / "audit_limit.db")
        init_audit_db(db_path)
        for i in range(10):
            write_audit_log(db_path, f"t{i}", "read", None, True, None)

        monkeypatch.setitem(main_brain._state, "mcp_audit_db_path", db_path)

        import asyncio

        result = asyncio.run(main_brain.mcp_audit(limit=3))
        assert len(result["logs"]) == 3

    def test_endpoint_without_db_path(self, monkeypatch) -> None:
        import main_brain

        monkeypatch.setitem(main_brain._state, "mcp_audit_db_path", None)

        import asyncio

        result = asyncio.run(main_brain.mcp_audit(limit=10))
        assert result["ok"] is False
        assert "error" in result
