"""Tests for the M4b MCP server (JSON-RPC 2.0 protocol + tool dispatch)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from unittest.mock import AsyncMock, MagicMock

import pytest

from mcp import (
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    INTERNAL_ERROR,
    MCPServer,
    TOOL_REGISTRY,
    error_response,
    success_response,
)
from mcp.protocol import MCP_PROTOCOL_VERSION, MCPError, validate_request, is_notification


# ---------------------------------------------------------------------------
# Protocol primitives
# ---------------------------------------------------------------------------


class TestProtocolPrimitives:
    def test_success_response_shape(self) -> None:
        r = success_response(1, {"x": 1})
        assert r == {"jsonrpc": "2.0", "id": 1, "result": {"x": 1}}

    def test_error_response_shape(self) -> None:
        r = error_response(2, METHOD_NOT_FOUND, "nope")
        assert r == {"jsonrpc": "2.0", "id": 2, "error": {"code": METHOD_NOT_FOUND, "message": "nope"}}

    def test_error_response_with_data(self) -> None:
        r = error_response(2, INVALID_PARAMS, "bad", data={"field": "x"})
        assert r["error"]["data"] == {"field": "x"}

    def test_is_notification_true_when_id_missing(self) -> None:
        assert is_notification({"jsonrpc": "2.0", "method": "ping"}) is True
        assert is_notification({"jsonrpc": "2.0", "method": "ping", "id": None}) is False

    def test_validate_request_accepts_well_formed(self) -> None:
        assert validate_request({"jsonrpc": "2.0", "method": "ping", "id": 1}) is None

    def test_validate_request_rejects_non_object(self) -> None:
        err = validate_request("not an object")
        assert err is not None
        assert err["error"]["code"] == INVALID_REQUEST

    def test_validate_request_rejects_wrong_version(self) -> None:
        err = validate_request({"jsonrpc": "1.0", "method": "ping", "id": 1})
        assert err is not None
        assert err["error"]["code"] == INVALID_REQUEST

    def test_validate_request_rejects_missing_method(self) -> None:
        err = validate_request({"jsonrpc": "2.0", "id": 1})
        assert err is not None
        assert err["error"]["code"] == INVALID_REQUEST


# ---------------------------------------------------------------------------
# Tool registry sanity
# ---------------------------------------------------------------------------


class TestToolRegistry:
    def test_registry_lists_expected_tools(self) -> None:
        names = {t.name for t in TOOL_REGISTRY}
        # Don't pin the exact set in case we add more later; spot-check
        # the v1 commitments
        for required in (
            "webrain_memory_query",
            "webrain_memory_recent",
            "webrain_rag_query",
            "webrain_rag_stats",
            "webrain_wiki_search",
            "webrain_kg_search",
        ):
            assert required in names, f"missing tool {required}"

    def test_each_tool_has_valid_input_schema(self) -> None:
        for t in TOOL_REGISTRY:
            schema = t.input_schema
            assert isinstance(schema, dict)
            assert schema.get("type") == "object"
            # Properties must be a dict (may be empty)
            assert isinstance(schema.get("properties", {}), dict)

    def test_to_dict_emits_mcp_camelcase_input_schema_key(self) -> None:
        spec = TOOL_REGISTRY[0]
        d = spec.to_dict()
        assert d["name"] == spec.name
        assert d["description"] == spec.description
        assert "inputSchema" in d  # MCP uses camelCase here


# ---------------------------------------------------------------------------
# MCPServer — protocol-level dispatch
# ---------------------------------------------------------------------------


def _state_with_memory_mock():
    memory = MagicMock()
    memory.query = AsyncMock(return_value=[{"id": "m1", "content": "x"}])
    memory.get_recent = AsyncMock(return_value=[{"id": "r1", "content": "y"}])
    return {"memory": memory}


class TestInitialize:
    @pytest.mark.asyncio
    async def test_returns_protocol_and_server_info(self) -> None:
        server = MCPServer({})
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}},
        })
        assert resp["id"] == 1
        result = resp["result"]
        assert result["protocolVersion"] == MCP_PROTOCOL_VERSION
        assert "tools" in result["capabilities"]
        assert result["serverInfo"]["name"] == "webrain-mcp"
        # Anti-leak: server identity must not mention Claude/Anthropic
        identity_str = json.dumps(result, ensure_ascii=False).lower()
        assert "claude" not in identity_str
        assert "anthropic" not in identity_str


class TestToolsList:
    @pytest.mark.asyncio
    async def test_returns_full_tool_registry(self) -> None:
        server = MCPServer({})
        resp = await server.handle({"jsonrpc": "2.0", "id": "list-1", "method": "tools/list"})
        assert resp["id"] == "list-1"
        tools = resp["result"]["tools"]
        assert len(tools) == len(TOOL_REGISTRY)
        names = {t["name"] for t in tools}
        assert "webrain_memory_query" in names


class TestToolsCall:
    @pytest.mark.asyncio
    async def test_dispatches_to_correct_handler(self) -> None:
        state = _state_with_memory_mock()
        server = MCPServer(state)
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": "webrain_memory_query", "arguments": {"query": "hello"}},
        })
        assert resp["id"] == 7
        # MCP shape: {content: [{type: "text", text: <json>}], isError: false}
        content = resp["result"]["content"]
        assert content[0]["type"] == "text"
        parsed = json.loads(content[0]["text"])
        assert parsed["count"] == 1
        # Verify the memory mock was called with the right shape
        state["memory"].query.assert_awaited_once()
        args = state["memory"].query.await_args.args[0]
        assert args["query"] == "hello"
        # Defaults applied
        assert args["levels"] == ["L2", "L3"]
        assert args["limit"] == 10

    @pytest.mark.asyncio
    async def test_unknown_tool_returns_method_not_found(self) -> None:
        server = MCPServer({})
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "no_such_tool", "arguments": {}},
        })
        assert "error" in resp
        assert resp["error"]["code"] == METHOD_NOT_FOUND

    @pytest.mark.asyncio
    async def test_invalid_params_when_name_missing(self) -> None:
        server = MCPServer({})
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"arguments": {}},
        })
        assert resp["error"]["code"] == INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_invalid_params_when_arguments_wrong_type(self) -> None:
        server = MCPServer({})
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_memory_query", "arguments": "string"},
        })
        assert resp["error"]["code"] == INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_handler_invalid_params_surfaces_as_invalid_params_error(self) -> None:
        # _memory_query requires a non-empty 'query' string
        state = _state_with_memory_mock()
        server = MCPServer(state)
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_memory_query", "arguments": {"query": ""}},
        })
        assert resp["error"]["code"] == INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_handler_internal_error_surfaces_when_subsystem_missing(self) -> None:
        # No memory in state — handler must surface INTERNAL_ERROR cleanly
        server = MCPServer({})
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_memory_query", "arguments": {"query": "hi"}},
        })
        assert resp["error"]["code"] == INTERNAL_ERROR
        assert "memory" in resp["error"]["message"]


class TestNotificationsAndUnknownMethods:
    @pytest.mark.asyncio
    async def test_notification_returns_none(self) -> None:
        server = MCPServer({})
        # No `id` field → notification
        resp = await server.handle({"jsonrpc": "2.0", "method": "ping"})
        assert resp is None

    @pytest.mark.asyncio
    async def test_unknown_method_returns_method_not_found(self) -> None:
        server = MCPServer({})
        resp = await server.handle({"jsonrpc": "2.0", "id": 1, "method": "no/such/method"})
        assert resp["error"]["code"] == METHOD_NOT_FOUND

    @pytest.mark.asyncio
    async def test_ping_returns_empty_result(self) -> None:
        server = MCPServer({})
        resp = await server.handle({"jsonrpc": "2.0", "id": "p", "method": "ping"})
        assert resp["result"] == {}


class TestBatch:
    @pytest.mark.asyncio
    async def test_batch_returns_array_of_responses(self) -> None:
        server = MCPServer({})
        resp = await server.handle([
            {"jsonrpc": "2.0", "id": 1, "method": "ping"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ])
        assert isinstance(resp, list)
        assert len(resp) == 2
        assert {r["id"] for r in resp} == {1, 2}

    @pytest.mark.asyncio
    async def test_batch_filters_notification_responses(self) -> None:
        server = MCPServer({})
        resp = await server.handle([
            {"jsonrpc": "2.0", "method": "ping"},  # notification — no response
            {"jsonrpc": "2.0", "id": 5, "method": "ping"},
        ])
        assert isinstance(resp, list)
        assert len(resp) == 1
        assert resp[0]["id"] == 5

    @pytest.mark.asyncio
    async def test_all_notifications_batch_returns_none(self) -> None:
        server = MCPServer({})
        resp = await server.handle([
            {"jsonrpc": "2.0", "method": "ping"},
            {"jsonrpc": "2.0", "method": "ping"},
        ])
        assert resp is None

    @pytest.mark.asyncio
    async def test_empty_batch_returns_error(self) -> None:
        server = MCPServer({})
        resp = await server.handle([])
        assert resp["error"]["code"] == INVALID_REQUEST


class TestMalformedRequests:
    @pytest.mark.asyncio
    async def test_non_object_payload_returns_error(self) -> None:
        server = MCPServer({})
        resp = await server.handle("not a json object")
        assert resp["error"]["code"] == INVALID_REQUEST

    @pytest.mark.asyncio
    async def test_wrong_jsonrpc_version_returns_error(self) -> None:
        server = MCPServer({})
        resp = await server.handle({"jsonrpc": "1.0", "method": "ping", "id": 1})
        assert resp["error"]["code"] == INVALID_REQUEST


# ---------------------------------------------------------------------------
# Per-tool integration smoke tests
# ---------------------------------------------------------------------------


@dataclass
class _FakeChunk:
    doc_path: str
    chunk_idx: int
    text: str
    score: float


class TestRagToolsIntegration:
    @pytest.fixture
    def state(self):
        rag = MagicMock()
        rag.retrieve = MagicMock(return_value=[_FakeChunk("/n/a.md", 0, "snippet", 0.91)])
        rag.stats = MagicMock(return_value={"docs_count": 5, "chunks_count": 42})
        return {"rag": rag}

    @pytest.mark.asyncio
    async def test_rag_query_serializes_chunks(self, state) -> None:
        server = MCPServer(state)
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_rag_query", "arguments": {"query": "x", "k": 1}},
        })
        parsed = json.loads(resp["result"]["content"][0]["text"])
        assert parsed["count"] == 1
        assert parsed["chunks"][0]["doc_path"] == "/n/a.md"
        assert parsed["chunks"][0]["score"] == 0.91
        state["rag"].retrieve.assert_called_once_with("x", k=1)

    @pytest.mark.asyncio
    async def test_rag_stats_returns_passthrough(self, state) -> None:
        server = MCPServer(state)
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_rag_stats", "arguments": {}},
        })
        parsed = json.loads(resp["result"]["content"][0]["text"])
        assert parsed == {"docs_count": 5, "chunks_count": 42}

    @pytest.mark.asyncio
    async def test_rag_query_wraps_retriever_exception_as_internal_error(self) -> None:
        rag = MagicMock()
        rag.retrieve = MagicMock(side_effect=RuntimeError("embedder offline"))
        server = MCPServer({"rag": rag})
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_rag_query", "arguments": {"query": "x"}},
        })
        assert resp["error"]["code"] == INTERNAL_ERROR
        assert "embedder offline" in resp["error"]["message"]


class TestWikiAndKgTools:
    @pytest.mark.asyncio
    async def test_wiki_search_via_search_method(self) -> None:
        wiki = MagicMock()
        wiki.search = MagicMock(return_value=[{"id": "n1", "title": "note"}])
        server = MCPServer({"wiki": wiki})
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_wiki_search", "arguments": {"query": "note"}},
        })
        parsed = json.loads(resp["result"]["content"][0]["text"])
        assert parsed["count"] == 1
        assert parsed["notes"][0]["id"] == "n1"

    @pytest.mark.asyncio
    async def test_kg_search_via_search_entities(self) -> None:
        kg = MagicMock(spec=["search_entities"])
        kg.search_entities = MagicMock(return_value=[{"id": "e1", "name": "Alice"}])
        server = MCPServer({"kg": kg})
        resp = await server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "webrain_kg_search", "arguments": {"query": "Alice"}},
        })
        parsed = json.loads(resp["result"]["content"][0]["text"])
        assert parsed["results"][0]["name"] == "Alice"
