"""JSON-RPC 2.0 protocol primitives for the webrain MCP server.

We support the subset of MCP that's actually useful at v1:
  - initialize      (handshake, returns server capabilities)
  - tools/list      (enumerate exposed tools + their input schemas)
  - tools/call      (invoke one tool by name with arguments)

Resources, prompts, notifications, and sampling are out of scope for v1.
The dispatcher returns `Method not found` for them so clients fall back
to tools-only mode cleanly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

# JSON-RPC 2.0 standard error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# MCP protocol version we implement against
MCP_PROTOCOL_VERSION = "2024-11-05"


@dataclass
class MCPError(Exception):
    """Raised inside a tool handler to surface a JSON-RPC error response.

    Distinct from generic Python exceptions so the dispatcher can
    differentiate between "tool said no" (returned as a JSON-RPC error
    response with the supplied code) and "tool crashed" (caught and
    wrapped as INTERNAL_ERROR).
    """

    code: int
    message: str
    data: Optional[Any] = None

    def __post_init__(self) -> None:
        # Make the exception's str() useful in logs
        super().__init__(f"MCPError[{self.code}]: {self.message}")


def success_response(req_id: Any, result: Any) -> Dict[str, Any]:
    """Build a JSON-RPC 2.0 success envelope."""
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def error_response(req_id: Any, code: int, message: str, data: Optional[Any] = None) -> Dict[str, Any]:
    """Build a JSON-RPC 2.0 error envelope."""
    err: Dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": err}


def is_notification(request: Dict[str, Any]) -> bool:
    """JSON-RPC notifications omit the `id` field — no response is sent."""
    return "id" not in request


def validate_request(request: Any) -> Optional[Dict[str, Any]]:
    """Return an error envelope if `request` is malformed, else None.

    We only validate the shape required by JSON-RPC 2.0:
      - object (not array/scalar/string at this layer; batches handled
        one level up)
      - jsonrpc == "2.0"
      - method is a non-empty string

    The `id` field, if present, must be string/number/null per spec —
    but in practice clients use whatever they want, so we don't reject
    weird id types.
    """
    if not isinstance(request, dict):
        return error_response(None, INVALID_REQUEST, "Request must be a JSON object")
    if request.get("jsonrpc") != "2.0":
        return error_response(
            request.get("id"), INVALID_REQUEST, 'Missing or invalid "jsonrpc": "2.0"'
        )
    method = request.get("method")
    if not isinstance(method, str) or not method:
        return error_response(
            request.get("id"), INVALID_REQUEST, "Missing or invalid 'method' field"
        )
    return None
