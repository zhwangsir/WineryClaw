"""Tests for the M4a multi-LLM router upgrade.

Covers:
  - LLMEndpoint stats accounting (success/failure/latency)
  - LLMRouter iter_failover ordering (healthy first, priority desc)
  - ChatEngine._chat_completion failover loop
  - LLMHealthMonitor lifecycle
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from chat.chat_engine import ChatEngine, LLMEndpoint, LLMRouter
from chat.llm_health_monitor import LLMHealthMonitor


# ---------------------------------------------------------------------------
# LLMEndpoint stats
# ---------------------------------------------------------------------------


class TestEndpointStats:
    def test_initial_state_is_healthy_with_zero_counts(self) -> None:
        ep = LLMEndpoint(name="e1", base_url="http://x/v1", model_id="m")
        assert ep.healthy is True
        assert ep.success_count == 0
        assert ep.failure_count == 0
        assert ep.avg_latency_ms == 0.0
        assert ep.last_success_at is None
        assert ep.last_failure_at is None
        assert ep.unhealthy_since is None

    def test_record_success_updates_counters_and_marks_healthy(self) -> None:
        ep = LLMEndpoint(name="e1", base_url="http://x/v1", model_id="m")
        ep.healthy = False
        ep.last_error = "earlier failure"
        ep.unhealthy_since = 12345.0

        ep.record_success(150.0)

        assert ep.healthy is True
        assert ep.success_count == 1
        assert ep.last_error is None
        assert ep.unhealthy_since is None
        assert ep.latency_ms == 150.0
        assert ep.avg_latency_ms == 150.0
        assert ep.last_success_at is not None

    def test_avg_latency_averages_across_successes(self) -> None:
        ep = LLMEndpoint(name="e1", base_url="http://x/v1", model_id="m")
        ep.record_success(100.0)
        ep.record_success(200.0)
        ep.record_success(300.0)
        assert ep.avg_latency_ms == 200.0

    def test_record_failure_increments_count_and_marks_unhealthy(self) -> None:
        ep = LLMEndpoint(name="e1", base_url="http://x/v1", model_id="m")
        assert ep.healthy is True
        ep.record_failure("connection refused")
        assert ep.healthy is False
        assert ep.failure_count == 1
        assert ep.last_error == "connection refused"
        assert ep.last_failure_at is not None
        assert ep.unhealthy_since is not None

    def test_unhealthy_since_persists_across_repeated_failures(self) -> None:
        ep = LLMEndpoint(name="e1", base_url="http://x/v1", model_id="m")
        ep.record_failure("err 1")
        first_marker = ep.unhealthy_since
        ep.record_failure("err 2")
        # Should NOT bump unhealthy_since on each failure — that's the
        # *first* failure timestamp, useful for alerting on long outages.
        assert ep.unhealthy_since == first_marker

    def test_success_after_failure_clears_unhealthy_since(self) -> None:
        ep = LLMEndpoint(name="e1", base_url="http://x/v1", model_id="m")
        ep.record_failure("transient")
        assert ep.unhealthy_since is not None
        ep.record_success(50.0)
        assert ep.unhealthy_since is None
        assert ep.healthy is True

    def test_to_dict_includes_all_observable_fields(self) -> None:
        ep = LLMEndpoint(name="e1", base_url="http://x/v1", model_id="m", priority=5, provider="openai")
        ep.record_success(123.4)
        d = ep.to_dict()
        for key in (
            "name", "base_url", "model_id", "provider", "priority",
            "healthy", "success_count", "failure_count",
            "avg_latency_ms", "last_latency_ms",
            "last_success_at", "last_failure_at", "last_error", "unhealthy_since",
        ):
            assert key in d


# ---------------------------------------------------------------------------
# LLMRouter
# ---------------------------------------------------------------------------


class TestRouterFailover:
    def _make_router(self) -> LLMRouter:
        r = LLMRouter()
        r.add_endpoint(LLMEndpoint(name="primary", base_url="http://p/v1", model_id="m", priority=10))
        r.add_endpoint(LLMEndpoint(name="secondary", base_url="http://s/v1", model_id="m", priority=5))
        r.add_endpoint(LLMEndpoint(name="tertiary", base_url="http://t/v1", model_id="m", priority=1))
        return r

    def test_iter_failover_returns_endpoints_priority_desc_when_all_healthy(self) -> None:
        r = self._make_router()
        names = [ep.name for ep in r.iter_failover()]
        assert names == ["primary", "secondary", "tertiary"]

    def test_iter_failover_yields_healthy_before_unhealthy(self) -> None:
        r = self._make_router()
        # Mark primary unhealthy — should be yielded LAST
        r.mark_failure("primary", "down")
        names = [ep.name for ep in r.iter_failover()]
        assert names == ["secondary", "tertiary", "primary"]

    def test_iter_failover_with_all_unhealthy_still_yields_all(self) -> None:
        # Caller still gets a chance — probes might have lagged real recovery
        r = self._make_router()
        for n in ["primary", "secondary", "tertiary"]:
            r.mark_failure(n, "down")
        names = [ep.name for ep in r.iter_failover()]
        assert set(names) == {"primary", "secondary", "tertiary"}
        assert len(names) == 3

    def test_mark_success_via_router_updates_endpoint(self) -> None:
        r = self._make_router()
        r.mark_failure("primary", "boom")
        assert r.find_by_name("primary").healthy is False
        r.mark_success("primary", 80.0)
        assert r.find_by_name("primary").healthy is True
        assert r.find_by_name("primary").success_count == 1

    def test_mark_unknown_endpoint_is_noop(self) -> None:
        r = self._make_router()
        # Should not raise
        r.mark_success("does-not-exist", 0.0)
        r.mark_failure("does-not-exist", "err")

    def test_stats_returns_aggregate_health_summary(self) -> None:
        r = self._make_router()
        r.mark_success("primary", 100.0)
        r.mark_failure("secondary", "bad gateway")
        snap = r.stats()
        assert snap["total_count"] == 3
        assert snap["healthy_count"] == 2  # primary + tertiary
        assert snap["status"] == "degraded"
        names = {e["name"] for e in snap["endpoints"]}
        assert names == {"primary", "secondary", "tertiary"}

    def test_stats_status_down_when_all_unhealthy(self) -> None:
        r = self._make_router()
        for n in ["primary", "secondary", "tertiary"]:
            r.mark_failure(n, "down")
        assert r.stats()["status"] == "down"

    def test_get_primary_returns_first_healthy(self) -> None:
        r = self._make_router()
        r.mark_failure("primary", "x")
        assert r.get_primary().name == "secondary"

    def test_get_primary_returns_first_endpoint_when_all_unhealthy(self) -> None:
        r = self._make_router()
        for n in ["primary", "secondary", "tertiary"]:
            r.mark_failure(n, "x")
        # Highest-priority unhealthy endpoint, since no healthy ones exist
        assert r.get_primary().name == "primary"


# ---------------------------------------------------------------------------
# ChatEngine._chat_completion failover
# ---------------------------------------------------------------------------


class TestChatCompletionFailover:
    @pytest.fixture
    def chat_engine(self, mock_llm_config):
        mm = MagicMock()
        mm.query = AsyncMock(return_value=[])
        mm.store = AsyncMock()
        sb = MagicMock()
        sb.execute_tool = AsyncMock(return_value="x")
        # Build with multi-endpoint config so we have something to fail over to
        config = {
            "endpoints": [
                {"name": "primary", "base_url": "http://p/v1", "model_id": "m", "priority": 10},
                {"name": "secondary", "base_url": "http://s/v1", "model_id": "m", "priority": 5},
            ]
        }
        return ChatEngine(mm, sb, llm_config=config)

    @pytest.mark.asyncio
    async def test_uses_primary_when_healthy(self, chat_engine) -> None:
        good_resp = {"choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]}
        async def fake_post(url, json=None, headers=None, **kwargs):
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_resp.json = MagicMock(return_value=good_resp)
            return mock_resp

        with patch("httpx.AsyncClient.post", new=AsyncMock(side_effect=fake_post)):
            result = await chat_engine._chat_completion([{"role": "user", "content": "hi"}])

        assert result["choices"][0]["message"]["content"] == "ok"
        assert result["_endpoint"] == "primary"
        ep = chat_engine.router.find_by_name("primary")
        assert ep.success_count == 1
        assert ep.healthy is True

    @pytest.mark.asyncio
    async def test_fails_over_to_secondary_when_primary_raises(self, chat_engine) -> None:
        good_resp = {"choices": [{"message": {"role": "assistant", "content": "from-2"}, "finish_reason": "stop"}]}
        calls: list = []

        async def fake_post(url, json=None, headers=None, **kwargs):
            calls.append(url)
            if "//p/" in url:
                raise httpx.ConnectError("primary unreachable")
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_resp.json = MagicMock(return_value=good_resp)
            return mock_resp

        with patch("httpx.AsyncClient.post", new=AsyncMock(side_effect=fake_post)):
            result = await chat_engine._chat_completion([{"role": "user", "content": "hi"}])

        assert result["_endpoint"] == "secondary"
        assert result["choices"][0]["message"]["content"] == "from-2"
        # Primary tried first, then secondary
        assert "//p/" in calls[0]
        assert "//s/" in calls[1]
        # Stats: primary failed, secondary succeeded
        primary = chat_engine.router.find_by_name("primary")
        secondary = chat_engine.router.find_by_name("secondary")
        assert primary.failure_count == 1
        assert primary.healthy is False
        assert "ConnectError" in (primary.last_error or "")
        assert secondary.success_count == 1
        assert secondary.healthy is True

    @pytest.mark.asyncio
    async def test_raises_descriptive_error_when_all_endpoints_fail(self, chat_engine) -> None:
        async def always_fail(url, **kwargs):
            raise httpx.ConnectError(f"down: {url}")

        with patch("httpx.AsyncClient.post", new=AsyncMock(side_effect=always_fail)):
            with pytest.raises(RuntimeError) as exc_info:
                await chat_engine._chat_completion([{"role": "user", "content": "hi"}])

        msg = str(exc_info.value)
        assert "All 2 LLM endpoint(s) failed" in msg
        # Last attempted endpoint name should appear in the message
        assert "secondary" in msg
        # Both endpoints recorded a failure
        assert chat_engine.router.find_by_name("primary").failure_count == 1
        assert chat_engine.router.find_by_name("secondary").failure_count == 1

    @pytest.mark.asyncio
    async def test_unhealthy_endpoint_is_retried_last(self, chat_engine) -> None:
        # Pre-mark primary unhealthy. The router should still iterate over it,
        # but secondary should be tried first now.
        chat_engine.router.mark_failure("primary", "pre-existing")
        good_resp = {"choices": [{"message": {"role": "assistant", "content": "secondary won"}}]}

        async def fake_post(url, **kwargs):
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_resp.json = MagicMock(return_value=good_resp)
            return mock_resp

        with patch("httpx.AsyncClient.post", new=AsyncMock(side_effect=fake_post)) as m:
            result = await chat_engine._chat_completion([{"role": "user", "content": "hi"}])

        first_url = m.call_args_list[0].args[0]
        assert "//s/" in first_url  # secondary tried first
        assert result["_endpoint"] == "secondary"

    @pytest.mark.asyncio
    async def test_raises_when_no_endpoints_configured(self) -> None:
        mm = MagicMock()
        mm.query = AsyncMock(return_value=[])
        sb = MagicMock()
        engine = ChatEngine(mm, sb, llm_config={"endpoints": []})
        # Manually clear endpoints (set_endpoints_from_config falls back to a
        # single primary when endpoints is missing/empty — we override)
        engine.router.endpoints = []
        with pytest.raises(RuntimeError, match="No LLM endpoint available"):
            await engine._chat_completion([{"role": "user", "content": "hi"}])


# ---------------------------------------------------------------------------
# LLMHealthMonitor
# ---------------------------------------------------------------------------


class TestLLMHealthMonitor:
    @pytest.mark.asyncio
    async def test_start_kicks_off_initial_probe(self) -> None:
        router = MagicMock()
        router.health_check_all = AsyncMock(return_value={"e1": {"healthy": True}})
        monitor = LLMHealthMonitor(router, interval_sec=60.0)

        monitor.start()
        # Give the loop a tick to run its initial probe
        await asyncio.sleep(0.05)
        assert monitor.running is True
        assert router.health_check_all.await_count >= 1
        await monitor.stop()

    @pytest.mark.asyncio
    async def test_stop_is_idempotent_and_cancels_task(self) -> None:
        router = MagicMock()
        router.health_check_all = AsyncMock(return_value={})
        monitor = LLMHealthMonitor(router, interval_sec=60.0)
        monitor.start()
        await asyncio.sleep(0.01)
        await monitor.stop()
        assert monitor.running is False
        # Second stop should be a no-op (no errors)
        await monitor.stop()

    @pytest.mark.asyncio
    async def test_start_is_idempotent(self) -> None:
        router = MagicMock()
        router.health_check_all = AsyncMock(return_value={})
        monitor = LLMHealthMonitor(router, interval_sec=60.0)
        monitor.start()
        first_task = monitor._task
        monitor.start()  # should not replace the task
        assert monitor._task is first_task
        await monitor.stop()

    def test_interval_floor_enforced(self) -> None:
        # Below 5s is silly — gets clamped up
        router = MagicMock()
        monitor = LLMHealthMonitor(router, interval_sec=0.1)
        assert monitor._interval == 5.0
