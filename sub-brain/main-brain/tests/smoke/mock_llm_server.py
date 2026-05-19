"""Standalone mock LLM server for chat-flow smoke tests.

Spawned as a subprocess by the smoke fixture. Exposes the OpenAI-compatible
endpoints (`/v1/chat/completions`, `/v1/models`) that ChatEngine / LLMRouter
expect, returning canned responses that downstream assertions can grep for.

Why standalone process rather than in-test respx/mocking: the chat path
runs in main-brain (a separate Python process). In-test mocking can't
intercept its outbound httpx — we need a real listening socket main-brain
can hit. Subprocess + free port = cleanest.

Why not a proper LLM provider stub via shared lib: a vanilla uvicorn
process boots in <1s and keeps the smoke layer free of dependencies.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any, Dict

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn


app = FastAPI()

# Tracks every request so the test can assert main-brain reached us.
RECEIVED: Dict[str, Any] = {"calls": []}


@app.get("/v1/models")
async def list_models() -> Dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {"id": "mock-model", "object": "model", "created": int(time.time())},
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> JSONResponse:
    """Return a deterministic reply with a unique-per-process sentinel.

    The sentinel lets the smoke test assert "this reply came from THIS
    mock LLM" rather than from any background dev endpoint that may also
    be live on the test machine.
    """
    body = await request.json()
    RECEIVED["calls"].append({
        "messages": body.get("messages", []),
        "model": body.get("model"),
        "tools_present": bool(body.get("tools")),
    })
    return JSONResponse({
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": body.get("model", "mock-model"),
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "MOCK-LLM-REPLY: hello from the smoke fixture",
            },
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 12, "total_tokens": 22},
    })


@app.get("/__debug/calls")
async def debug_calls() -> Dict[str, Any]:
    """Inspection endpoint so the test can verify main-brain reached us."""
    return RECEIVED


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    # log_level="warning" keeps the smoke log tidy — uvicorn's INFO is noisy.
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
