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

from .auth import verify
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

# Custom error code for unauthorized — keeps -32601 (METHOD_NOT_FOUND)
# distinct from -32001 (auth missing/invalid). JSON-RPC server-defined
# range is -32000..-32099.
UNAUTHORIZED = -32001

logger = logging.getLogger("webrain.mcp.server")

# Server-side identity returned in `initialize`. Match the user's privacy
# preference: no Claude/Anthropic strings, just generic "webrain MCP".
SERVER_INFO = {"name": "webrain-mcp", "version": "0.1.0"}


class MCPServer:
    def __init__(self, state: Dict[str, Any], expected_token: Optional[str] = None):
        # `state` is the live main_brain `_state` dict — handlers read
        # subsystems (memory, rag, wiki, kg) directly from it. We do not
        # copy or snapshot; handlers see whatever the brain has right now.
        self._state = state
        # M4b.1: when set, write-scope tools require Authorization: Bearer
        # <expected_token>. Read-scope tools remain open. Pass None (e.g. in
        # tests) to keep all tools open.
        self._expected_token = expected_token

    # -----------------------------------------------------------------------
    # Top-level dispatch (single or batch)
    # -----------------------------------------------------------------------

    async def handle(self, payload: Any, bearer_token: Optional[str] = None) -> Optional[Any]:
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
                resp = await self._handle_one(item, bearer_token)
                if resp is not None:
                    responses.append(resp)
            return responses if responses else None

        if isinstance(payload, dict):
            return await self._handle_one(payload, bearer_token)

        return error_response(None, INVALID_REQUEST, "Payload must be object or array")

    async def _handle_one(self, request: Any, bearer_token: Optional[str] = None) -> Optional[Dict[str, Any]]:
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
            result = await self._dispatch(method, params, bearer_token)
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

    async def _dispatch(self, method: str, params: Dict[str, Any], bearer_token: Optional[str]) -> Any:
        if method == "initialize":
            return self._initialize(params)
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": [t.to_dict() for t in TOOL_REGISTRY]}
        if method == "tools/call":
            return await self._tools_call(params, bearer_token)
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

    async def _tools_call(self, params: Dict[str, Any], bearer_token: Optional[str]) -> Dict[str, Any]:
        # v2.29 (ROADMAP V2 P0 #3): record every tools/call in the MCP audit
        # ledger. We're inside an asyncio handler; the ledger is best-effort
        # (record() never raises) so this never breaks the actual call path.
        import time as _time

        try:
            from audit.mcp_ledger import get_mcp_ledger, hash_bearer, summarize_args

            _ledger = get_mcp_ledger()
        except Exception:  # noqa: BLE001 — audit module shouldn't break MCP
            _ledger = None

            def hash_bearer(_: Optional[str]) -> Optional[str]:  # type: ignore[misc]
                return None

            def summarize_args(_: Any) -> Dict[str, Any]:  # type: ignore[misc]
                return {}

        _t0 = _time.time()
        _bearer_id = hash_bearer(bearer_token) if bearer_token else None

        name = params.get("name")
        if not isinstance(name, str):
            # Audit the rejection too — useful when tracking down bad
            # clients sending malformed payloads.
            if _ledger is not None:
                _ledger.record(
                    tool=str(name) if name is not None else "?",
                    scope="?",
                    success=False,
                    latency_ms=(_time.time() - _t0) * 1000.0,
                    args_summary={},
                    result_preview=None,
                    error="INVALID_PARAMS: 'name' is required",
                    bearer_id=_bearer_id,
                )
            raise MCPError(INVALID_PARAMS, "'name' is required")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            if _ledger is not None:
                _ledger.record(
                    tool=name,
                    scope="?",
                    success=False,
                    latency_ms=(_time.time() - _t0) * 1000.0,
                    args_summary={},
                    result_preview=None,
                    error="INVALID_PARAMS: 'arguments' must be an object",
                    bearer_id=_bearer_id,
                )
            raise MCPError(INVALID_PARAMS, "'arguments' must be an object")

        spec = find_tool(name)
        _args_summary = summarize_args(arguments)

        # M4b.1: write-scope tools require a valid bearer token. Read-scope
        # tools are open. Missing expected_token (e.g. dev/test) keeps all
        # tools open — by design, since no token was configured.
        if spec.scope == "write" and self._expected_token is not None:
            if not verify(bearer_token, self._expected_token):
                if _ledger is not None:
                    _ledger.record(
                        tool=name,
                        scope=spec.scope,
                        success=False,
                        latency_ms=(_time.time() - _t0) * 1000.0,
                        args_summary=_args_summary,
                        result_preview=None,
                        error="UNAUTHORIZED: missing/invalid bearer",
                        bearer_id=_bearer_id,
                    )
                raise MCPError(
                    UNAUTHORIZED,
                    f"tool {name!r} requires authentication (Authorization: Bearer <token>)",
                )

        try:
            result = await spec.handler(self._state, arguments)
        except Exception as e:  # noqa: BLE001 — surface as MCPError; audit then re-raise
            err_msg = f"{type(e).__name__}: {e}"
            if _ledger is not None:
                _ledger.record(
                    tool=name,
                    scope=spec.scope,
                    success=False,
                    latency_ms=(_time.time() - _t0) * 1000.0,
                    args_summary=_args_summary,
                    result_preview=None,
                    error=err_msg,
                    bearer_id=_bearer_id,
                )
            raise

        # MCP convention: tool results are wrapped as content blocks. We
        # always return a single text block containing the JSON-serialised
        # result. Clients that want structured access parse the JSON.
        result_text = json.dumps(result, ensure_ascii=False, default=str)
        if _ledger is not None:
            _ledger.record(
                tool=name,
                scope=spec.scope,
                success=True,
                latency_ms=(_time.time() - _t0) * 1000.0,
                args_summary=_args_summary,
                result_preview=result_text,
                error=None,
                bearer_id=_bearer_id,
            )
        return {
            "content": [
                {"type": "text", "text": result_text}
            ],
            "isError": False,
        }
