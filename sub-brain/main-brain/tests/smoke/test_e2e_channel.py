"""End-to-end channel inbound→reply smoke tests (Round C5, 2026-05-20).

The auto-reply pipeline (M5) is fundamental user-facing infrastructure:

  external user → Telegram/Slack/iMessage → ChannelManager polling
    → storeMessage(direction='inbound') → ChannelAutoReply.handleInbound
    → main-brain /chat → reply text
    → ChannelManager.send(reply) → external transport
    → storeMessage(direction='outbound')

Unit tests in channel-auto-reply.test.ts mock channelManager + chatFn.
These smoke tests prove the full path works against a real running
stack — and importantly, that all the wiring is plugged into main.ts
(if it isn't, no unit test will catch it).

Uses a "memory" channel type (no external transport, outbound stays in
the local DB) so the test doesn't need real Telegram/Slack/etc
credentials.

Marker: `@pytest.mark.smoke`. Run with:
    pytest -m smoke tests/smoke/test_e2e_channel.py -s
"""

from __future__ import annotations

import time
import uuid
from typing import Optional

import httpx
import pytest

pytestmark = pytest.mark.smoke


def _connect_memory_channel(sub_url: str, name: Optional[str] = None) -> str:
    """Connect a fresh 'memory' channel and return its id.

    The memory protocol is no-credentials, always-ok — added for this
    smoke round but useful for production demos too.
    """
    name = name or f"smoke-mem-{uuid.uuid4().hex[:8]}"
    r = httpx.post(
        f"{sub_url}/channels/connect",
        json={"channel": "memory", "config": {"channelId": name}},
        timeout=10.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True, body
    return body["channel_id"]


def _delete_channel(sub_url: str, channel_id: str) -> None:
    """Cleanup helper — non-fatal if it fails."""
    try:
        httpx.delete(f"{sub_url}/channels/{channel_id}", timeout=5.0)
    except httpx.HTTPError:
        pass


def _set_auto_reply(sub_url: str, channel_id: str, enabled: bool) -> None:
    r = httpx.post(
        f"{sub_url}/channels/{channel_id}/auto-reply",
        json={"enabled": enabled},
        timeout=5.0,
    )
    assert r.status_code == 200, r.text


def _inject_inbound(sub_url: str, channel_id: str, sender: str, content: str) -> dict:
    r = httpx.post(
        f"{sub_url}/channels/{channel_id}/inject-inbound",
        json={"sender": sender, "content": content},
        timeout=10.0,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _list_messages(sub_url: str, channel_id: str) -> list:
    r = httpx.get(f"{sub_url}/channels/{channel_id}/messages", timeout=5.0)
    assert r.status_code == 200, r.text
    return r.json().get("messages", [])


def _wait_for_outbound(sub_url: str, channel_id: str, timeout_s: float = 30.0) -> Optional[dict]:
    """Poll the messages cache for an outbound reply.

    Auto-reply is fire-and-forget; the inject-inbound call returns
    immediately but the reply lands asynchronously after chat() finishes.
    Poll at 0.5s intervals up to `timeout_s`.
    """
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        messages = _list_messages(sub_url, channel_id)
        outbound = [m for m in messages if m.get("direction") == "outbound"]
        if outbound:
            return outbound[-1]
        time.sleep(0.5)
    return None


def test_memory_channel_can_be_created_and_listed(chat_smoke_rig):
    """The memory protocol must register as a valid channel type.

    Defends against a regression where the memory protocol is removed
    from PROTOCOL_REGISTRY — without this we'd lose our credential-free
    smoke + dev path silently."""
    sub_url = chat_smoke_rig.sub_brain.base_url
    channel_id = _connect_memory_channel(sub_url)
    try:
        r = httpx.get(f"{sub_url}/channels", timeout=5.0)
        assert r.status_code == 200, r.text
        channels = r.json().get("channels", [])
        ids = {c.get("id") for c in channels}
        assert channel_id in ids, f"new memory channel {channel_id} not listed: {ids}"
        ours = next(c for c in channels if c.get("id") == channel_id)
        assert ours.get("type") == "memory"
        assert ours.get("connected") is True
    finally:
        _delete_channel(sub_url, channel_id)


def test_inject_inbound_persists_message_without_auto_reply(chat_smoke_rig):
    """With auto-reply OFF, injected inbound must persist but NOT trigger
    a chat call or an outbound reply.

    Catches the bug class: 'auto-reply flag ignored, every inbound fires
    a chat regardless'. That would be a silent cost regression."""
    sub_url = chat_smoke_rig.sub_brain.base_url
    channel_id = _connect_memory_channel(sub_url)
    try:
        # Don't enable auto-reply
        _inject_inbound(sub_url, channel_id, "alice", "hello there")
        # Brief wait — if auto-reply incorrectly fires, an outbound would
        # appear within a couple of seconds.
        time.sleep(2.0)
        messages = _list_messages(sub_url, channel_id)
        inbound = [m for m in messages if m.get("direction") == "inbound"]
        outbound = [m for m in messages if m.get("direction") == "outbound"]
        assert len(inbound) >= 1, f"inbound message not persisted: {messages}"
        assert len(outbound) == 0, (
            f"auto-reply fired even with flag OFF — outbound: {outbound}"
        )
    finally:
        _delete_channel(sub_url, channel_id)


def test_inbound_with_auto_reply_triggers_chat_and_outbound(chat_smoke_rig):
    """The keystone test: enable auto-reply, inject inbound, verify the
    mock LLM was reached and an outbound reply landed.

    Exercises every layer:
      ChannelManager.simulateInbound
      → storeMessage(inbound) → inboundHandler
      → ChannelAutoReply.handleInbound
      → main-brain /chat (via http)
      → LLMRouter → mock LLM
      → ChannelManager.send → memory protocol noop
      → storeMessage(outbound)
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    mock_url = chat_smoke_rig.mock_llm.base_url
    channel_id = _connect_memory_channel(sub_url)
    try:
        _set_auto_reply(sub_url, channel_id, True)

        # Snapshot mock LLM call count
        before = httpx.get(f"{mock_url}/__debug/calls", timeout=5.0).json()
        before_chat_calls = sum(
            1 for c in before["calls"] if c.get("branch") == "chat"
        )

        sender = f"alice-{uuid.uuid4().hex[:6]}"
        _inject_inbound(sub_url, channel_id, sender, "what is two plus two")

        # Wait for the outbound reply to materialise
        outbound = _wait_for_outbound(sub_url, channel_id, timeout_s=60.0)
        assert outbound is not None, (
            f"No outbound reply after 60s with auto-reply on. "
            f"Messages so far: {_list_messages(sub_url, channel_id)}"
        )
        # The reply text should contain the mock LLM sentinel
        assert "MOCK-LLM-REPLY" in outbound.get("content", ""), (
            f"Outbound content didn't come from mock LLM: {outbound}"
        )
        # Sender on outbound should be 'webrain' per channel-manager convention
        assert outbound.get("sender") == "webrain", outbound

        # And the mock LLM saw at least one new chat-class call
        after = httpx.get(f"{mock_url}/__debug/calls", timeout=5.0).json()
        after_chat_calls = sum(
            1 for c in after["calls"] if c.get("branch") == "chat"
        )
        assert after_chat_calls > before_chat_calls, (
            f"Mock LLM saw no new chat call after inbound — auto-reply "
            f"didn't reach the chat path. before={before_chat_calls} "
            f"after={after_chat_calls}"
        )
    finally:
        _delete_channel(sub_url, channel_id)


def test_inject_inbound_404_for_unknown_channel(chat_smoke_rig):
    """Inject against a non-existent channel returns a clear error
    rather than a 500. Defends the API contract."""
    sub_url = chat_smoke_rig.sub_brain.base_url
    bogus_id = f"does-not-exist-{uuid.uuid4().hex}"
    r = httpx.post(
        f"{sub_url}/channels/{bogus_id}/inject-inbound",
        json={"sender": "x", "content": "y"},
        timeout=5.0,
    )
    # Either 200 with {ok: false, error: ...} OR 4xx — both are
    # acceptable shapes. What's NOT acceptable is a 5xx crash.
    assert r.status_code < 500, f"unknown channel injection 5xx'd: {r.text}"
    body = r.json()
    # If 200, must signal failure in body
    if r.status_code == 200:
        assert body.get("ok") is False, body


def test_inject_inbound_rejects_empty_content(chat_smoke_rig):
    """Empty content shouldn't trigger a chat call (would waste an LLM
    round-trip on nothing). The endpoint returns 400 to be explicit."""
    sub_url = chat_smoke_rig.sub_brain.base_url
    channel_id = _connect_memory_channel(sub_url)
    try:
        r = httpx.post(
            f"{sub_url}/channels/{channel_id}/inject-inbound",
            json={"sender": "x", "content": ""},
            timeout=5.0,
        )
        assert r.status_code == 400, (
            f"empty-content inject should 400; got {r.status_code} {r.text}"
        )
    finally:
        _delete_channel(sub_url, channel_id)
