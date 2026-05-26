"""v2.26 — chat stream failover tests.

Verifies that `ChatEngine._chat_completion_stream` retries across endpoints
when the FIRST endpoint fails before emitting any chunk, but does NOT retry
once chunks have already been streamed (mid-stream failure surfaces as an
error event instead of silently swapping endpoints).

The bug we're guarding against (PROJECT_STATE.md §9 P0 #4): pre-v2.26 the
stream path called `router.get_primary()` once and never retried, so a 5xx /
ECONNREFUSED on the first endpoint cascaded straight to the frontend even
when a healthy fallback was configured.
"""

from __future__ import annotations

from typing import Any, AsyncGenerator, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat.chat_engine import ChatEngine


def _make_engine_with_endpoints(names: List[str]) -> ChatEngine:
    """Build an engine with `names` as endpoint identifiers, all healthy."""
    mm = MagicMock()
    mm.query = AsyncMock(return_value=[])
    mm.store = AsyncMock(return_value={"ok": True})
    mm.get_top_l4 = AsyncMock(return_value=[])
    sb = MagicMock()
    sb.execute_tool = AsyncMock(return_value="tool-result")
    cfg = {
        "endpoints": [
            {
                "name": n,
                "base_url": f"http://127.0.0.1:{9000 + i}/v1",
                "model_id": "mock",
                "api_key": "x",
                "timeout": 1,
                "priority": 10 - i,
            }
            for i, n in enumerate(names)
        ],
        "temperature": 0.7,
        "max_tokens": 1024,
    }
    return ChatEngine(memory_manager=mm, sub_brain_client=sb, llm_config=cfg)


async def _collect(gen: AsyncGenerator[Dict[str, Any], None]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    async for ch in gen:
        out.append(ch)
    return out


@pytest.mark.asyncio
async def test_stream_first_endpoint_fails_before_chunk_falls_over():
    """Endpoint A raises before yielding → endpoint B serves all chunks."""
    engine = _make_engine_with_endpoints(["A", "B"])

    async def fake_stream_one(self, ep, *a, **kw):  # noqa: ARG001
        if ep.name == "A":
            # Simulate connection-time failure (no chunks emitted)
            raise RuntimeError("ECONNREFUSED")
        for piece in ("hello ", "world"):
            yield {"type": "content", "data": piece}
        yield {"type": "done"}

    with patch.object(ChatEngine, "_stream_one_endpoint", fake_stream_one):
        chunks = await _collect(engine._chat_completion_stream([{"role": "user", "content": "hi"}]))

    # First event is the endpoint_committed signal for B (we skipped A).
    committed = [c for c in chunks if c["type"] == "endpoint_committed"]
    assert len(committed) == 1
    assert committed[0]["data"]["endpoint"] == "B"

    content_pieces = [c["data"] for c in chunks if c["type"] == "content"]
    assert content_pieces == ["hello ", "world"]
    assert any(c["type"] == "done" for c in chunks)
    # Crucially: NO error event leaked to the consumer.
    assert not any(c["type"] == "error" for c in chunks)


@pytest.mark.asyncio
async def test_stream_mid_stream_failure_surfaces_error_does_not_failover():
    """A yields some chunks, then raises → consumer sees error, no retry on B."""
    engine = _make_engine_with_endpoints(["A", "B"])

    async def fake_stream_one(self, ep, *a, **kw):  # noqa: ARG001
        if ep.name == "A":
            yield {"type": "content", "data": "partial..."}
            raise RuntimeError("connection reset mid-stream")
        # B should NEVER be called once A committed.
        pytest.fail("must not failover after a chunk was already emitted")

    with patch.object(ChatEngine, "_stream_one_endpoint", fake_stream_one):
        chunks = await _collect(engine._chat_completion_stream([{"role": "user", "content": "hi"}]))

    committed = [c for c in chunks if c["type"] == "endpoint_committed"]
    assert len(committed) == 1
    assert committed[0]["data"]["endpoint"] == "A"
    content_pieces = [c["data"] for c in chunks if c["type"] == "content"]
    assert content_pieces == ["partial..."]
    errors = [c for c in chunks if c["type"] == "error"]
    assert len(errors) == 1
    assert "stream interrupted on A" in errors[0]["data"]
    assert "connection reset mid-stream" in errors[0]["data"]


@pytest.mark.asyncio
async def test_stream_all_endpoints_fail_yields_aggregated_error():
    """Every endpoint fails pre-chunk → single error event names the last."""
    engine = _make_engine_with_endpoints(["A", "B", "C"])

    async def fake_stream_one(self, ep, *a, **kw):  # noqa: ARG001
        raise RuntimeError(f"{ep.name}-down")
        yield  # pragma: no cover  # makes this an async generator

    with patch.object(ChatEngine, "_stream_one_endpoint", fake_stream_one):
        chunks = await _collect(engine._chat_completion_stream([{"role": "user", "content": "hi"}]))

    # No content, no done, no endpoint_committed — just one error.
    assert all(c["type"] == "error" for c in chunks)
    assert len(chunks) == 1
    body = chunks[0]["data"]
    assert "All 3 LLM endpoint(s) failed" in body
    # The error must name the LAST endpoint tried, for diagnosis.
    assert "'C'" in body


@pytest.mark.asyncio
async def test_stream_no_endpoints_configured_yields_error():
    """Empty endpoint list → single error event, not exception."""
    engine = _make_engine_with_endpoints([])

    chunks = await _collect(engine._chat_completion_stream([{"role": "user", "content": "hi"}]))
    assert chunks == [{"type": "error", "data": "No LLM endpoint available"}]


@pytest.mark.asyncio
async def test_stream_marks_success_on_first_chunk():
    """Router stats: failover-winning endpoint registers a success on TTFB."""
    engine = _make_engine_with_endpoints(["A", "B"])
    # Wrap router.mark_success to record calls
    seen: List[str] = []
    orig_mark_success = engine.router.mark_success

    def spy_success(name: str, latency_ms: float) -> None:
        seen.append(name)
        orig_mark_success(name, latency_ms)

    engine.router.mark_success = spy_success  # type: ignore[assignment]

    async def fake_stream_one(self, ep, *a, **kw):  # noqa: ARG001
        if ep.name == "A":
            raise RuntimeError("down")
        yield {"type": "content", "data": "ok"}
        yield {"type": "done"}

    with patch.object(ChatEngine, "_stream_one_endpoint", fake_stream_one):
        await _collect(engine._chat_completion_stream([{"role": "user", "content": "hi"}]))

    assert seen == ["B"]


@pytest.mark.asyncio
async def test_stream_endpoint_committed_event_carries_ttfb():
    """The `endpoint_committed` event must include TTFB in ms (rounded)."""
    engine = _make_engine_with_endpoints(["only"])

    async def fake_stream_one(self, ep, *a, **kw):  # noqa: ARG001
        yield {"type": "content", "data": "x"}
        yield {"type": "done"}

    with patch.object(ChatEngine, "_stream_one_endpoint", fake_stream_one):
        chunks = await _collect(engine._chat_completion_stream([{"role": "user", "content": "hi"}]))
    committed = next(c for c in chunks if c["type"] == "endpoint_committed")
    assert committed["data"]["endpoint"] == "only"
    assert isinstance(committed["data"]["ttfb_ms"], (int, float))
    assert committed["data"]["ttfb_ms"] >= 0


@pytest.mark.asyncio
async def test_stream_privacy_mode_skips_remote_endpoints():
    """Privacy ON: remote endpoints are skipped; local served instead."""
    engine = _make_engine_with_endpoints(["remote-A", "local-B"])
    # Force first endpoint to look "remote" via is_local_url monkeypatch.
    # We just patch the imported helper inside the stream method.
    served_by: List[str] = []

    async def fake_stream_one(self, ep, *a, **kw):  # noqa: ARG001
        served_by.append(ep.name)
        yield {"type": "content", "data": "ok"}
        yield {"type": "done"}

    fake_state = MagicMock()
    fake_state.is_on.return_value = True

    def fake_is_local(url: str) -> bool:
        # Endpoint base_urls are http://127.0.0.1:9000/v1 + 9001 by construction.
        # Treat 9000 as remote-ish for this test by matching exact name.
        return "9001" in url  # only second endpoint is "local"

    import audit.privacy_mode as pm

    with patch.object(pm, "get_privacy_state", return_value=fake_state), patch.object(
        pm, "is_local_url", side_effect=fake_is_local
    ), patch.object(ChatEngine, "_stream_one_endpoint", fake_stream_one):
        await _collect(engine._chat_completion_stream([{"role": "user", "content": "hi"}]))

    assert served_by == ["local-B"]
