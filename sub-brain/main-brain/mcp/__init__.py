"""MCP (Model Context Protocol) server exposure — M4b.

Lets external MCP-compatible clients invoke webrain's memory, RAG, wiki,
and knowledge-graph capabilities over JSON-RPC 2.0. See `server.MCPServer`
for the public surface and `tools` for the per-tool handler registry.

Transport: HTTP via `POST /mcp/jsonrpc`. A separate `tools/mcp_stdio_
bridge.py` script wraps stdio for MCP clients that spawn subprocesses.
"""

from .protocol import (
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    INTERNAL_ERROR,
    MCPError,
    error_response,
    success_response,
)
from .server import MCPServer
from .tools import TOOL_REGISTRY, ToolHandler, ToolSpec

__all__ = [
    "MCPServer",
    "ToolHandler",
    "ToolSpec",
    "TOOL_REGISTRY",
    "MCPError",
    "PARSE_ERROR",
    "INVALID_REQUEST",
    "METHOD_NOT_FOUND",
    "INVALID_PARAMS",
    "INTERNAL_ERROR",
    "error_response",
    "success_response",
]
