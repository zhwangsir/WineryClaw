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

# Conflict-judge behaviour for the conflict-resolution smoke test.
# Default: judge ALWAYS returns {"contradicts": true}, so any L3 pair the
# similarity filter surfaces will get marked. Tests can flip it to False
# via PUT /__debug/conflict-mode (e.g. to verify "no-conflict" path).
CONFLICT_MODE: Dict[str, Any] = {"contradicts": True, "reason": "smoke test default"}


@app.get("/v1/models")
async def list_models() -> Dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {"id": "mock-model", "object": "model", "created": int(time.time())},
        ],
    }


def _is_conflict_judge(messages) -> bool:
    """Inspect the prompt to recognize ConflictDetector's judge call.

    The detector's system message is a fixed string ("fact contradiction
    judge") and the user message contains the literal "Fact A (new):"
    line. Matching either is enough — both means it's definitely the
    judge, not the chat path.
    """
    for m in messages:
        content = (m.get("content") or "").lower()
        if "fact contradiction judge" in content:
            return True
        if "fact a (new):" in content and "fact b (existing):" in content:
            return True
    return False


def _is_dreaming_summary(messages) -> bool:
    """Recognize dreaming engine's L1→L2 summarization prompt."""
    for m in messages:
        content = (m.get("content") or "").lower()
        if "memory consolidation expert" in content:
            return True
    return False


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> JSONResponse:
    """Return a deterministic reply with a unique-per-process sentinel.

    The sentinel lets the smoke test assert "this reply came from THIS
    mock LLM" rather than from any background dev endpoint that may also
    be live on the test machine.

    Branches:
      - conflict judge → JSON verdict from CONFLICT_MODE
      - dreaming summary → echo the source content so FTS keeps matching
      - default → MOCK-LLM-REPLY sentinel
    """
    body = await request.json()
    messages = body.get("messages", [])
    is_judge = _is_conflict_judge(messages)
    is_summary = _is_dreaming_summary(messages)
    RECEIVED["calls"].append({
        "messages": messages,
        "model": body.get("model"),
        "tools_present": bool(body.get("tools")),
        "branch": "judge" if is_judge else ("summary" if is_summary else "chat"),
    })

    if is_judge:
        content = json.dumps({
            "contradicts": bool(CONFLICT_MODE.get("contradicts", True)),
            "reason": str(CONFLICT_MODE.get("reason", "smoke")),
        })
    elif is_summary:
        # Stitch enough of the source content into the summary that the
        # post-consolidation L2 row remains FTS-discoverable by the
        # original keywords. Mirrors the test_memory_benchmark approach.
        user_text = ""
        for m in messages:
            if m.get("role") == "user":
                user_text = m.get("content", "")
                break
        marker = "messages):"
        if marker in user_text:
            body_text = user_text.split(marker, 1)[1].split("Summary:", 1)[0].strip()
        else:
            body_text = user_text[:400]
        content = "MOCK-LLM-SUMMARY: " + body_text[:600]
    else:
        content = "MOCK-LLM-REPLY: hello from the smoke fixture"

    return JSONResponse({
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": body.get("model", "mock-model"),
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": content,
            },
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 12, "total_tokens": 22},
    })


@app.put("/__debug/conflict-mode")
async def set_conflict_mode(request: Request) -> Dict[str, Any]:
    """Test-control: set the judge's response for upcoming conflict calls.

    Body: {"contradicts": bool, "reason": str}
    Returns the new state.
    """
    body = await request.json()
    if "contradicts" in body:
        CONFLICT_MODE["contradicts"] = bool(body["contradicts"])
    if "reason" in body:
        CONFLICT_MODE["reason"] = str(body["reason"])
    return CONFLICT_MODE


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
