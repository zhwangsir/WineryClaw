"""Tests for the M4b.1 MCP auth layer (token loader + verify) and the
server-level scope gating that requires bearer auth for write tools."""

from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from mcp import MCPServer, extract_bearer, resolve_token, verify
from mcp.server import UNAUTHORIZED


# ---------------------------------------------------------------------------
# extract_bearer
# ---------------------------------------------------------------------------


class TestExtractBearer:
    def test_returns_none_for_missing_header(self) -> None:
        assert extract_bearer(None) is None
        assert extract_bearer("") is None

    def test_returns_none_for_non_bearer_scheme(self) -> None:
        assert extract_bearer("Basic abcdef") is None
        assert extract_bearer("Token abcdef") is None

    def test_returns_none_for_missing_token(self) -> None:
        assert extract_bearer("Bearer") is None
        assert extract_bearer("Bearer ") is None

    def test_extracts_well_formed_bearer(self) -> None:
        assert extract_bearer("Bearer my-token-123") == "my-token-123"

    def test_case_insensitive_scheme(self) -> None:
        # Some HTTP clients normalize the scheme to all lowercase
        assert extract_bearer("bearer my-token") == "my-token"
        assert extract_bearer("BEARER my-token") == "my-token"

    def test_trims_whitespace_around_token(self) -> None:
        # Extra trailing whitespace should not change the token; leading
        # whitespace between scheme and token is the splitter.
        assert extract_bearer("Bearer my-token   ") == "my-token"


# ---------------------------------------------------------------------------
# verify (constant-time compare)
# ---------------------------------------------------------------------------


class TestVerify:
    def test_matching_tokens_return_true(self) -> None:
        assert verify("abc123", "abc123") is True

    def test_mismatched_tokens_return_false(self) -> None:
        assert verify("abc123", "abc124") is False

    def test_different_length_tokens_return_false(self) -> None:
        assert verify("short", "shorter-token") is False

    def test_empty_presented_token_returns_false(self) -> None:
        assert verify("", "expected") is False
        assert verify(None, "expected") is False

    def test_empty_expected_returns_false(self) -> None:
        # Never let a missing-config server accept any token
        assert verify("anything", "") is False


# ---------------------------------------------------------------------------
# resolve_token — env / file / generate
# ---------------------------------------------------------------------------


class TestResolveToken:
    def test_env_var_takes_priority(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setenv("WEBRAIN_MCP_TOKEN", "env-supplied-token")
        # Even if a file exists, env should win
        (tmp_path / "mcp_token").write_text("file-supplied-token")
        assert resolve_token(tmp_path) == "env-supplied-token"

    def test_falls_back_to_persisted_file(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.delenv("WEBRAIN_MCP_TOKEN", raising=False)
        (tmp_path / "mcp_token").write_text("persisted-token\n")
        assert resolve_token(tmp_path) == "persisted-token"

    def test_generates_and_persists_when_neither_env_nor_file(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.delenv("WEBRAIN_MCP_TOKEN", raising=False)
        token = resolve_token(tmp_path)
        assert token
        assert len(token) >= 32  # token_urlsafe(32) produces ~43 chars

        # Confirm it was persisted with restrictive permissions
        token_path = tmp_path / "mcp_token"
        assert token_path.exists()
        assert token_path.read_text().strip() == token
        mode = token_path.stat().st_mode & 0o777
        assert mode == 0o600

    def test_subsequent_calls_return_same_persisted_token(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.delenv("WEBRAIN_MCP_TOKEN", raising=False)
        first = resolve_token(tmp_path)
        second = resolve_token(tmp_path)
        assert first == second

    def test_env_with_whitespace_only_ignored(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setenv("WEBRAIN_MCP_TOKEN", "   ")
        token = resolve_token(tmp_path)
        # Falls through to generation
        assert token
        assert token.strip() != ""


# ---------------------------------------------------------------------------
# MCPServer scope gating — read open, write requires bearer
# ---------------------------------------------------------------------------


class TestScopeGating:
    @pytest.fixture
    def state(self):
        memory = MagicMock()
        memory.query = AsyncMock(return_value=[])
        memory.store = AsyncMock(return_value={"id": "m-stored"})
        return {"memory": memory}

    @pytest.mark.asyncio
    async def test_read_tool_works_without_token_when_server_has_token(self, state) -> None:
        server = MCPServer(state, expected_token="server-secret")
        resp = await server.handle({
            "jsonrpc": "2.0", "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_memory_query", "arguments": {"query": "x"}},
        })
        # No bearer passed — read tool should still succeed
        assert "result" in resp
        assert resp["result"]["isError"] is False

    @pytest.mark.asyncio
    async def test_write_tool_rejected_without_bearer(self, state) -> None:
        server = MCPServer(state, expected_token="server-secret")
        resp = await server.handle({
            "jsonrpc": "2.0", "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_memory_store", "arguments": {"content": "anything"}},
        })
        assert "error" in resp
        assert resp["error"]["code"] == UNAUTHORIZED
        assert "authentication" in resp["error"]["message"].lower()
        # Sanity: memory.store should NOT have been called
        state["memory"].store.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_write_tool_rejected_with_wrong_bearer(self, state) -> None:
        server = MCPServer(state, expected_token="server-secret")
        resp = await server.handle(
            {
                "jsonrpc": "2.0", "id": 1,
                "method": "tools/call",
                "params": {"name": "webrain_memory_store", "arguments": {"content": "anything"}},
            },
            bearer_token="wrong-token",
        )
        assert resp["error"]["code"] == UNAUTHORIZED
        state["memory"].store.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_write_tool_succeeds_with_correct_bearer(self, state) -> None:
        server = MCPServer(state, expected_token="server-secret")
        resp = await server.handle(
            {
                "jsonrpc": "2.0", "id": 1,
                "method": "tools/call",
                "params": {"name": "webrain_memory_store", "arguments": {"content": "save me"}},
            },
            bearer_token="server-secret",
        )
        assert "result" in resp
        parsed = json.loads(resp["result"]["content"][0]["text"])
        assert parsed["stored"] is True
        state["memory"].store.assert_awaited_once()
        store_arg = state["memory"].store.await_args.args[0]
        assert store_arg["content"] == "save me"
        assert store_arg["level"] == "L2"  # default
        assert store_arg["source"] == "mcp"

    @pytest.mark.asyncio
    async def test_write_tool_with_explicit_level_and_source(self, state) -> None:
        server = MCPServer(state, expected_token="server-secret")
        await server.handle(
            {
                "jsonrpc": "2.0", "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "webrain_memory_store",
                    "arguments": {"content": "x", "level": "L3", "source": "test-client"},
                },
            },
            bearer_token="server-secret",
        )
        store_arg = state["memory"].store.await_args.args[0]
        assert store_arg["level"] == "L3"
        assert store_arg["source"] == "test-client"

    @pytest.mark.asyncio
    async def test_write_tool_rejects_invalid_level(self, state) -> None:
        server = MCPServer(state, expected_token="server-secret")
        resp = await server.handle(
            {
                "jsonrpc": "2.0", "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "webrain_memory_store",
                    "arguments": {"content": "x", "level": "L99"},
                },
            },
            bearer_token="server-secret",
        )
        assert "error" in resp
        assert "L99" in resp["error"]["message"] or "level" in resp["error"]["message"].lower()
        state["memory"].store.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_when_server_has_no_expected_token_write_tool_is_open(self, state) -> None:
        # expected_token=None: e.g. dev mode where no token was configured.
        # Write tools work without bearer in this case — by design.
        server = MCPServer(state, expected_token=None)
        resp = await server.handle({
            "jsonrpc": "2.0", "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_memory_store", "arguments": {"content": "dev"}},
        })
        assert "result" in resp
        state["memory"].store.assert_awaited_once()


# ---------------------------------------------------------------------------
# wiki_create and rag_index_file write tools — handler shape
# ---------------------------------------------------------------------------


class TestWikiAndRagWriteTools:
    @pytest.mark.asyncio
    async def test_wiki_create_dispatches_with_tags(self) -> None:
        wiki = MagicMock()
        wiki.create_note = MagicMock(return_value={"id": "n1", "title": "X"})
        state = {"wiki": wiki}
        server = MCPServer(state, expected_token="t")
        resp = await server.handle(
            {
                "jsonrpc": "2.0", "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "webrain_wiki_create",
                    "arguments": {"title": "Hello", "content": "Body text", "tags": ["a", "b"]},
                },
            },
            bearer_token="t",
        )
        parsed = json.loads(resp["result"]["content"][0]["text"])
        assert parsed["created"] is True
        wiki.create_note.assert_called_once_with(title="Hello", content="Body text", tags=["a", "b"])

    @pytest.mark.asyncio
    async def test_wiki_create_rejects_non_list_tags(self) -> None:
        wiki = MagicMock()
        wiki.create_note = MagicMock(return_value={"id": "n1"})
        state = {"wiki": wiki}
        server = MCPServer(state, expected_token="t")
        resp = await server.handle(
            {
                "jsonrpc": "2.0", "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "webrain_wiki_create",
                    "arguments": {"title": "X", "content": "Y", "tags": "not-a-list"},
                },
            },
            bearer_token="t",
        )
        assert "error" in resp
        wiki.create_note.assert_not_called()

    @pytest.mark.asyncio
    async def test_rag_index_file_dispatches(self) -> None:
        rag = MagicMock()
        rag.index_file = MagicMock(return_value={"indexed": True, "chunks_count": 5})
        server = MCPServer({"rag": rag}, expected_token="t")
        resp = await server.handle(
            {
                "jsonrpc": "2.0", "id": 1,
                "method": "tools/call",
                "params": {"name": "webrain_rag_index_file", "arguments": {"path": "/tmp/x.md"}},
            },
            bearer_token="t",
        )
        parsed = json.loads(resp["result"]["content"][0]["text"])
        assert parsed["indexed"] is True
        rag.index_file.assert_called_once_with("/tmp/x.md")
