"""Background liveness probing for LLM endpoints (M4a).

Periodically pings each endpoint registered with an `LLMRouter` so a
previously-failed endpoint can recover its `healthy` flag without
waiting for the next user-triggered call.

Designed to be cheap:
  - Sequential probes (no thundering herd of opens)
  - Uses LLMEndpoint.health_check() which already short-timeouts at 5s
  - Configurable interval; defaults to 60s
  - Stops cleanly on cancellation

Lifecycle: created in main_brain.py lifespan, started after ChatEngine
is constructed, cancelled on shutdown. Not used in tests by default —
inject a fake task or shorten the interval and step `asyncio.sleep`.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

logger = logging.getLogger("webrain.llm.health")


class LLMHealthMonitor:
    """Owns a single asyncio task that loops `router.health_check_all()`."""

    def __init__(self, router: Any, interval_sec: float = 60.0):
        self._router = router
        self._interval = max(5.0, float(interval_sec))  # floor at 5s — pinging faster is silly
        self._task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        """Start the background loop. Idempotent — no-op if already running."""
        if self.running:
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._loop(), name="llm-health-monitor")
        logger.info("LLM health monitor started (interval=%.1fs)", self._interval)

    async def stop(self) -> None:
        """Request shutdown and wait for the loop to drain."""
        if not self._task:
            return
        self._stop_event.set()
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):
            pass
        self._task = None
        logger.info("LLM health monitor stopped")

    async def _loop(self) -> None:
        # Initial probe: don't wait the full interval before the first
        # check — the router cache might be stale on startup.
        try:
            await self._probe_once()
        except Exception as e:  # pragma: no cover — defensive
            logger.warning("LLM health initial probe failed: %s", e)

        while not self._stop_event.is_set():
            try:
                # asyncio.wait_for(stop_event.wait, timeout=interval) lets us
                # exit fast on shutdown instead of sleeping out the full tick.
                await asyncio.wait_for(self._stop_event.wait(), timeout=self._interval)
                # If we get here, stop_event was set — exit.
                return
            except asyncio.TimeoutError:
                # Interval elapsed normally — run another probe.
                pass
            try:
                await self._probe_once()
            except Exception as e:  # pragma: no cover — defensive
                logger.warning("LLM health probe iteration failed: %s", e)

    async def _probe_once(self) -> None:
        results = await self._router.health_check_all()
        healthy = sum(1 for v in results.values() if v.get("healthy"))
        total = len(results)
        if healthy < total:
            logger.info("LLM health: %d/%d endpoints healthy", healthy, total)
