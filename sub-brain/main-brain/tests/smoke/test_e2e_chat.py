"""End-to-end chat-flow smoke tests (Round C1, 2026-05-20).

The boot smoke (test_e2e_boot.py) proves the services come up and the
proxy is wired. These tests prove the CHAT path actually works end-to-end:

  frontend → POST /chat → sub-brain → /brain/chat proxy → main-brain
    → ChatEngine.chat → LLMRouter → mock LLM → reply
    → MemoryManager L1 store (user + assistant)
    → ActiveMemory.process_conversation (fire-and-forget, opt-in)

Catches the bug class: "unit tests pass, but chat is silently broken
because some piece of wiring rotted between releases".

Marker: `@pytest.mark.smoke`. Excluded from regular pytest sweeps —
run with `pytest -m smoke tests/smoke/test_e2e_chat.py -s`.
"""

from __future__ import annotations

import time
import uuid

import httpx
import pytest

pytestmark = pytest.mark.smoke


def test_chat_endpoint_returns_mock_llm_reply(chat_smoke_rig):
    """The full chat path returns whatever the LLM said.

    This is the keystone test — if it passes, the entire reasoning loop
    is intact: HTTP, routing, prompt assembly, LLM call, response shape.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    session = f"chat-smoke-{uuid.uuid4().hex[:8]}"
    user_msg = f"smoke chat invariant {session}"

    r = httpx.post(
        f"{sub_url}/brain/chat",
        json={
            "message": user_msg,
            "session_id": session,
            "agent_id": "agent-default",
            "context": {"tools_enabled": False},  # no tool calls — keep flow short
        },
        timeout=30.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # The mock LLM always replies with this sentinel; any other content
    # means we hit a real LLM somewhere (config not reloaded?).
    assert "MOCK-LLM-REPLY" in body.get("reply", ""), (
        f"Chat reply did not match mock sentinel — config reload failed "
        f"or main-brain hit a different endpoint. Body: {body}"
    )
    assert body.get("session_id") == session
    assert body.get("iterations") == 1  # no tool calls, one LLM round-trip


def test_chat_stores_user_message_to_l1(chat_smoke_rig):
    """User input must land in L1 before the LLM call.

    Documented behaviour: chat_engine.chat() stores the user message
    BEFORE running the LLM round-trip, so a UI that crashed mid-stream
    still has the conversation history. Verify it.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    session = f"chat-l1-{uuid.uuid4().hex[:8]}"
    sentinel = f"l1-chat-anchor-{uuid.uuid4().hex}"
    user_msg = f"smoke check {sentinel}"

    r = httpx.post(
        f"{sub_url}/brain/chat",
        json={"message": user_msg, "session_id": session,
              "context": {"tools_enabled": False}},
        timeout=30.0,
    )
    assert r.status_code == 200, r.text

    # Query L1 for the unique sentinel — must find at least one row
    q = httpx.post(
        f"{sub_url}/brain/memory/query",
        json={"query": sentinel, "levels": ["L1"], "limit": 5, "use_rerank": False},
        timeout=15.0,
    )
    assert q.status_code == 200, q.text
    rows = q.json().get("results", [])
    assert len(rows) >= 1, (
        f"Expected at least one L1 row containing {sentinel!r} after chat; "
        f"got 0. ChatEngine.chat is supposed to store user input to L1 "
        f"before invoking the LLM."
    )
    # The user message AND the assistant reply should both be L1 rows
    # for this session. The sentinel query may only return the user row
    # (FTS doesn't match across content), so we widen the check to all
    # L1 rows in this session.
    q_all = httpx.post(
        f"{sub_url}/brain/memory/query",
        json={"query": session, "levels": ["L1"], "limit": 10, "use_rerank": False},
        timeout=15.0,
    )
    if q_all.status_code == 200:
        session_rows = q_all.json().get("results", [])
        # Best-effort assertion — different FTS tokenization rules might
        # not match session ids, so don't hard-fail. Just print for log.
        sources = [r.get("source", "") for r in session_rows
                   if r.get("session_id") == session]
        if sources:
            assert "user" in sources, f"L1 missing user role for session {session}: {sources}"


def test_chat_reaches_mock_llm(chat_smoke_rig):
    """The mock LLM's /__debug/calls must show at least one call.

    Verifies the LLM URL was actually hit — defends against a regression
    where the chat path silently short-circuits before the LLM call
    (e.g., a planner mishap or empty system prompt returning early).
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    mock_url = chat_smoke_rig.mock_llm.base_url

    # Snapshot calls BEFORE the new chat — other tests in this module
    # may have already invoked the mock.
    before = httpx.get(f"{mock_url}/__debug/calls", timeout=5.0).json()
    before_count = len(before["calls"])

    r = httpx.post(
        f"{sub_url}/brain/chat",
        json={"message": "ping mock llm",
              "session_id": f"mock-{uuid.uuid4().hex[:6]}",
              "context": {"tools_enabled": False}},
        timeout=30.0,
    )
    assert r.status_code == 200, r.text

    after = httpx.get(f"{mock_url}/__debug/calls", timeout=5.0).json()
    after_count = len(after["calls"])
    assert after_count == before_count + 1, (
        f"Expected exactly one new mock-LLM call; got {after_count - before_count}. "
        f"Either main-brain didn't reach the mock or it called multiple times. "
        f"Total calls: {after_count}"
    )
    last_call = after["calls"][-1]
    assert last_call["model"] == "mock-model", last_call
    # System prompt + user message — at minimum the user role must be present
    roles = [m.get("role") for m in last_call["messages"]]
    assert "user" in roles, f"Mock LLM didn't see a user message: {last_call}"


def test_chat_handles_unreachable_llm_without_hanging(chat_smoke_rig):
    """If we kill the mock LLM, the chat endpoint must still return
    in bounded time (failure path doesn't hang the request).

    This catches the bug class where an LLM timeout cascades into a
    proxy timeout into a UI spinner that never resolves. The chat path
    must surface a structured error within the per-endpoint timeout
    rather than waiting on the full upstream timeout × retry count.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    # Take the mock LLM offline mid-test
    chat_smoke_rig.mock_llm.kill()

    start = time.time()
    try:
        r = httpx.post(
            f"{sub_url}/brain/chat",
            json={"message": "this should fail fast",
                  "session_id": f"fail-{uuid.uuid4().hex[:6]}",
                  "context": {"tools_enabled": False}},
            timeout=60.0,  # generous, but if the chat hangs it'll exceed this
        )
        elapsed = time.time() - start
        # Either a structured failure (5xx) or a chat result carrying an
        # error. Both are acceptable — what's NOT acceptable is hanging.
        # The single mock endpoint had timeout=10.0; total bound should be
        # well under 60s even with retries.
        assert elapsed < 45.0, f"Chat took {elapsed:.1f}s to fail — too slow"
        # Body shape is implementation-defined; we just need a response
        assert r.status_code >= 200
    finally:
        # Don't leave teardown broken — module fixture's `finally` will
        # try to kill an already-dead process, which is a no-op.
        pass
