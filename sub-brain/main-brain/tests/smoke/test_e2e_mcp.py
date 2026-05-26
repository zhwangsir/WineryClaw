"""End-to-end MCP smoke tests (Round C4, 2026-05-20).

MCP is the externally-callable surface third-party tools use to talk to
webrain. The bearer-auth + write-tool path was unit-tested in
test_mcp_server.py with mocked state — these smoke tests prove the
full path works against a real running stack:

  3rd-party client → POST /brain/mcp/jsonrpc → sub-brain proxy
    → main-brain /mcp/jsonrpc → MCPServer.handle
    → tool spec lookup → bearer verify (write tools)
    → handler invokes real MemoryManager / Wiki / RAG
    → JSON-RPC envelope back to client

Catches the bug class: "MCP tool registry says write tools are
auth-gated, but actually the gate is bypassable / missing entirely".

Round C2/C3 caught wiring bugs in chat / dreaming / conflict by going
exactly through this layer. MCP write tools are the next biggest
externally-visible blind spot.

Marker: `@pytest.mark.smoke`. Run with:
    pytest -m smoke tests/smoke/test_e2e_mcp.py -s
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, Optional

import httpx
import pytest

pytestmark = pytest.mark.smoke


SMOKE_MCP_TOKEN = "smoke-test-token-not-for-production-use"  # mirror conftest


def _rpc(
    sub_url: str,
    method: str,
    params: Optional[Dict[str, Any]] = None,
    bearer: Optional[str] = None,
    rpc_id: int = 1,
) -> httpx.Response:
    """POST a JSON-RPC 2.0 request to /brain/mcp/jsonrpc.

    Returns the raw response so tests can inspect status + body.
    Bearer-less and bearer-wrong cases need the raw response to
    distinguish HTTP-level errors from JSON-RPC-level errors.
    """
    headers = {"Content-Type": "application/json"}
    if bearer is not None:
        headers["Authorization"] = f"Bearer {bearer}"
    body = {"jsonrpc": "2.0", "id": rpc_id, "method": method}
    if params is not None:
        body["params"] = params
    return httpx.post(
        f"{sub_url}/brain/mcp/jsonrpc",
        json=body,
        headers=headers,
        timeout=30.0,
    )


def test_mcp_initialize_succeeds_without_auth(smoke_rig):
    """initialize is a read-class call — should work without bearer."""
    r = _rpc(smoke_rig.sub_brain.base_url, "initialize",
             params={"protocolVersion": "2024-11-05"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "result" in body, f"initialize should return result, got: {body}"
    assert body["result"].get("serverInfo", {}).get("name") == "webrain-mcp"


def test_mcp_tools_list_without_auth_returns_full_registry(smoke_rig):
    """tools/list is read-class. Must return every tool including the
    write-scoped ones (auth is enforced at tools/call time, not list time)."""
    r = _rpc(smoke_rig.sub_brain.base_url, "tools/list")
    assert r.status_code == 200, r.text
    body = r.json()
    tools = body["result"]["tools"]
    names = {t["name"] for t in tools}
    # Spot-check: at least one read tool + at least one write tool
    assert "webrain_memory_query" in names, names
    assert "webrain_memory_store" in names, names
    # Scope must be present so external clients can decide whether they
    # need a token before calling. The MCP server emits it as a top-level
    # field (custom; spec doesn't standardize "scope" yet).
    write_tool = next(t for t in tools if t["name"] == "webrain_memory_store")
    assert write_tool.get("scope") == "write", write_tool


def test_mcp_read_tool_call_works_without_auth(smoke_rig):
    """Read tools must work without bearer token."""
    r = _rpc(
        smoke_rig.sub_brain.base_url,
        "tools/call",
        params={
            "name": "webrain_memory_query",
            "arguments": {"query": "anything", "limit": 1},
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "result" in body, body
    # result.content[0].text is the JSON-encoded payload
    text = body["result"]["content"][0]["text"]
    payload = json.loads(text)
    # Schema check — must have a results key, may be empty list
    assert "results" in payload or "items" in payload or isinstance(payload, list), payload


def test_mcp_write_tool_call_without_bearer_is_rejected(smoke_rig):
    """The keystone auth test. memory_store is write-class — calling it
    with NO Authorization header must return JSON-RPC error.

    If this passes when it shouldn't, the auth gate is broken and any
    anonymous caller can write to memory.
    """
    r = _rpc(
        smoke_rig.sub_brain.base_url,
        "tools/call",
        params={
            "name": "webrain_memory_store",
            "arguments": {"content": "should be blocked", "level": "L2"},
        },
        bearer=None,  # explicit — no Authorization header
    )
    # HTTP itself returns 200 because JSON-RPC errors live in the body
    assert r.status_code == 200, r.text
    body = r.json()
    assert "error" in body, (
        f"Write tool without bearer must return JSON-RPC error, got: {body}"
    )
    # Tighter check: the error message should mention authentication
    err = body["error"]
    msg = (err.get("message") or "").lower()
    assert "auth" in msg or "bearer" in msg or "token" in msg, (
        f"Error message should reference auth: {err}"
    )


def test_mcp_write_tool_call_with_wrong_bearer_is_rejected(smoke_rig):
    """Constant-time verify must reject obviously-wrong tokens."""
    r = _rpc(
        smoke_rig.sub_brain.base_url,
        "tools/call",
        params={
            "name": "webrain_memory_store",
            "arguments": {"content": "should be blocked", "level": "L2"},
        },
        bearer="definitely-not-the-real-token",
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "error" in body, (
        f"Wrong bearer must return JSON-RPC error, got: {body}"
    )


def test_mcp_write_tool_call_with_correct_bearer_persists_memory(smoke_rig):
    """The other keystone: with the right token, write tool actually
    creates a memory we can read back.

    Defends against the inverse failure: gate works (rejects bad
    tokens) but the success path is broken — handler crashes silently,
    HTTP-level OK but memory never persists.
    """
    sub_url = smoke_rig.sub_brain.base_url
    sentinel = f"mcp-write-anchor-{uuid.uuid4().hex}"
    r = _rpc(
        sub_url,
        "tools/call",
        params={
            "name": "webrain_memory_store",
            "arguments": {
                "content": f"{sentinel} created via MCP smoke test",
                "level": "L2",
                "source": "mcp-smoke",
            },
        },
        bearer=SMOKE_MCP_TOKEN,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "result" in body, f"valid bearer write must succeed: {body}"

    # Unwrap content[0].text → JSON payload → assert stored
    text = body["result"]["content"][0]["text"]
    payload = json.loads(text)
    assert payload.get("stored") is True, payload
    new_id = payload["entry"]["id"]

    # Round-trip: read it back via the regular memory query endpoint
    q = httpx.post(
        f"{sub_url}/brain/memory/query",
        json={"query": sentinel, "levels": ["L2"], "limit": 5, "use_rerank": False},
        timeout=15.0,
    )
    assert q.status_code == 200, q.text
    results = q.json().get("results", [])
    assert any(m["id"] == new_id for m in results), (
        f"MCP-written memory {new_id} not retrievable via /memory/query. "
        f"Either the write didn't persist (handler bug) or the row exists "
        f"but the query layer can't find it. Got results: "
        f"{[m.get('id') for m in results]}"
    )


def test_mcp_info_endpoint_reports_token_is_configured(smoke_rig):
    """/mcp/info must reflect that an env-set token is in effect.

    Used by the frontend MCPInfoPanel to render "auth: enabled" status.
    Asserts the boolean-only contract (the token itself must NEVER
    appear in the response — security-critical).
    """
    r = httpx.get(f"{smoke_rig.sub_brain.base_url}/brain/mcp/info", timeout=5.0)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("token_configured") is True
    assert body.get("auth_required_for_write") is True
    # SECURITY: the token string must NOT leak via this endpoint
    raw = json.dumps(body)
    assert SMOKE_MCP_TOKEN not in raw, (
        f"/mcp/info leaked the token string! body: {body}"
    )
