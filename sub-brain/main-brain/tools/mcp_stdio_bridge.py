#!/usr/bin/env python3
"""Stdio ↔ HTTP bridge for webrain's MCP server (M4b).

Most MCP clients (assistants, IDEs, agents) connect to MCP servers via
stdio: they spawn a child process, write JSON-RPC requests to its stdin
line-by-line, and read responses from its stdout. webrain's MCP server
is HTTP-only, so this script bridges the two.

Usage
-----
Configure your MCP client to spawn:

    python /path/to/sub-brain/main-brain/tools/mcp_stdio_bridge.py \\
        --url http://127.0.0.1:3456/brain/mcp/jsonrpc

Or set `WEBRAIN_MCP_URL` env var:

    export WEBRAIN_MCP_URL=http://127.0.0.1:3456/brain/mcp/jsonrpc
    python tools/mcp_stdio_bridge.py

Behavior
--------
- Reads one JSON object per line from stdin (newline-delimited JSON).
- POSTs each as the request body to the configured URL.
- Writes the response (or empty for notifications/204) to stdout,
  newline-terminated, flushed.
- Sends parse errors back as JSON-RPC error envelopes on stdout — never
  raises so the client doesn't see an unexpected exit.
- Exits gracefully on EOF (client closed stdin).

This intentionally has zero dependencies beyond the Python standard
library so it can run in any minimal environment.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Optional


def _post_json(url: str, body: Dict[str, Any], timeout: float, token: Optional[str] = None) -> Optional[Dict[str, Any]]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        # M4b.1: webrain MCP write-class tools require this header. Read
        # tools tolerate it being present, so adding it unconditionally
        # is safe and means the bridge "just works" for both scopes.
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            raw = resp.read()
            if status == 204 or not raw:
                # Notification — no response body
                return None
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            body_text = e.read().decode("utf-8", errors="replace")
        except Exception:
            body_text = ""
        return _jsonrpc_error(
            body.get("id"),
            -32000,
            f"HTTP {e.code} from MCP server",
            data=body_text[:500] if body_text else None,
        )
    except Exception as e:
        return _jsonrpc_error(
            body.get("id"),
            -32603,
            f"transport error: {type(e).__name__}: {e}",
        )


def _jsonrpc_error(req_id: Any, code: int, message: str, data: Any = None) -> Dict[str, Any]:
    err: Dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": err}


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description="Stdio bridge to webrain MCP server")
    parser.add_argument(
        "--url",
        default=os.environ.get("WEBRAIN_MCP_URL", "http://127.0.0.1:3456/brain/mcp/jsonrpc"),
        help="MCP HTTP endpoint URL",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.environ.get("WEBRAIN_MCP_TIMEOUT", "30")),
        help="Per-request HTTP timeout in seconds (default: 30)",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("WEBRAIN_MCP_TOKEN", ""),
        help=(
            "Bearer token for write-class MCP tools. Defaults to "
            "$WEBRAIN_MCP_TOKEN. Get it from ~/.webrain/mcp_token after "
            "the first webrain launch."
        ),
    )
    args = parser.parse_args(argv)
    token = (args.token or "").strip() or None

    # Use unbuffered stdin reads and explicit stdout flush — MCP clients
    # expect line-by-line interactive behavior, not block-buffered IO.
    for line in iter(sys.stdin.readline, ""):
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            err = _jsonrpc_error(None, -32700, f"parse error: {e}")
            sys.stdout.write(json.dumps(err, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue

        response = _post_json(args.url, req, args.timeout, token=token)
        if response is None:
            # Notification — no response. Some MCP clients still want a
            # newline to know we've moved on; we send nothing per spec.
            continue
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    return 0


if __name__ == "__main__":  # pragma: no cover — entry point
    raise SystemExit(main())
