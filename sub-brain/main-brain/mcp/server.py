"""MCP server dispatcher — handles JSON-RPC 2.0 requests over the
`POST /mcp/jsonrpc` endpoint.

Public surface:
    server = MCPServer(state)
    response = await server.handle(request_payload)

Where `request_payload` is a parsed JSON value (object or array — JSON-RPC
batch is supported). `handle()` always returns the response dict that
should be sent back; for notifications (no `id`) it returns None and the
caller should respond 204 No Content.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional, Union

from .protocol import (
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    MCP_PROTOCOL_VERSION,
    METHOD_NOT_FOUND,
    MCPError,
    PARSE_ERROR,
    error_response,
    is_notification,
    success_response,
    validate_request,
)
from .tools import TOOL_REGISTRY, find_tool

logger = logging.getLogger("webrain.mcp.server")

# Server-side identity returned in `initialize`. Match the user's privacy
# preference: no Claude/Anthropic strings, just generic "webrain MCP".
SERVER_INFO = {"name": "webrain-mcp", "version": "0.1.0"}


class MCPServer:
    def __init__(self, state: Dict[str, Any]):
        # `state` is the live main_brain `_state` dict — handlers read
        # subsystems (memory, rag, wiki, kg) directly from it. We do not
        # copy or snapshot; handlers see whatever the brain has right now.
        self._state = state

    # -----------------------------------------------------------------------
    # Top-level dispatch (single or batch)
    # -----------------------------------------------------------------------

    async def handle(self, payload: Any) -> Optional[Any]:
        """Handle a parsed JSON-RPC payload.

        For a single request: returns the response dict (or None if it
        was a notification).
        For a batch (JSON array): returns a list of response dicts (or
        None if every request was a notification).
        """
        if isinstance(payload, list):
            if not payload:
                # Empty batch is an INVALID_REQUEST per JSON-RPC spec
                return error_response(None, INVALID_REQUEST, "Empty batch")
            responses: List[Dict[str, Any]] = []
            for item in payload:
                resp = await self._handle_one(item)
                if resp is not None:
                    responses.append(resp)
            return responses if responses else None

        if isinstance(payload, dict):
            return await self._handle_one(payload)

        return error_response(None, INVALID_REQUEST, "Payload must be object or array")

    async def _handle_one(self, request: Any) -> Optional[Dict[str, Any]]:
        """Dispatch one JSON-RPC request. Returns None for notifications."""
        err = validate_request(request)
        if err is not None:
            return err

        req_id = request.get("id")
        method = request["method"]
        params = request.get("params") or {}
        if not isinstance(params, dict):
            # JSON-RPC allows positional params (arrays) but MCP only uses
            # named params — reject arrays cleanly rather than silently
            # accepting them and crashing downstream.
            if is_notification(request):
                return None
            return error_response(req_id, INVALID_PARAMS, "'params' must be an object")

        try:
            result = await self._dispatch(method, params)
        except MCPError as e:
            if is_notification(request):
                return None
            return error_response(req_id, e.code, e.message, e.data)
        except Exception as e:  # pragma: no cover — last-line defense
            logger.exception("MCP handler crashed for method=%s", method)
            if is_notification(request):
                return None
            return error_response(
                req_id,
                INTERNAL_ERROR,
                f"unhandled exception: {type(e).__name__}: {e}",
            )

        if is_notification(request):
            return None
        return success_response(req_id, result)

    # -----------------------------------------------------------------------
    # Method dispatch
    # -----------------------------------------------------------------------

    async def _dispatch(self, method: str, params: Dict[str, Any]) -> Any:
        if method == "initialize":
            return self._initialize(params)
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": [t.to_dict() for t in TOOL_REGISTRY]}
        if method == "tools/call":
            return await self._tools_call(params)
        raise MCPError(METHOD_NOT_FOUND, f"unknown method: {method!r}")

    def _initialize(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Return server capabilities + version.

        We declare only the `tools` capability — clients should not try
        to use resources/prompts/sampling against this server (they'd
        get METHOD_NOT_FOUND, which is graceful but ugly).
        """
        # MCP convention: echo back the client's protocol version if
        # it's compatible, otherwise return ours and let the client decide.
        client_proto = params.get("protocolVersion") if isinstance(params, dict) else None
        proto = client_proto if isinstance(client_proto, str) else MCP_PROTOCOL_VERSION
        return {
            "protocolVersion": proto,
            "capabilities": {
                "tools": {"listChanged": False},
            },
            "serverInfo": SERVER_INFO,
        }

    async def _tools_call(self, params: Dict[str, Any]) -> Dict[str, Any]:
        name = params.get("name")
        if not isinstance(name, str):
            raise MCPError(INVALID_PARAMS, "'name' is required")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise MCPError(INVALID_PARAMS, "'arguments' must be an object")

        spec = find_tool(name)
        result = await spec.handler(self._state, arguments)
        # MCP convention: tool results are wrapped as content blocks. We
        # always return a single text block containing the JSON-serialised
        # result. Clients that want structured access parse the JSON.
        return {
            "content": [
                {"type": "text", "text": json.dumps(result, ensure_ascii=False, default=str)}
            ],
            "isError": False,
        }
