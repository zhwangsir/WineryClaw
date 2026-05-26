"""End-to-end boot smoke test (M-Smoke-1, 2026-05-20).

The bug class this test exists to catch: "all 1000+ unit tests pass but
the actual binary can't boot, or has dead wiring that no unit covered".

The 2026-05-20 user trial found 3 such bugs in 5 minutes:
  - sub-brain's `setNotFoundHandler` double-registration crash
  - MemoryManager's ConflictDetector was never instantiated in lifespan
  - The CJK similarity threshold was tuned for English, not real data

Every assertion in this file is anchored to one of those failure modes.
If a future regression silently breaks production wiring, this test
should fail BEFORE the user ever sees it.

Marker: `@pytest.mark.smoke`. Excluded from regular pytest sweeps —
run with `pytest -m smoke tests/smoke/ -s` (the `-s` shows the boot
banners and any service logs on failure).

Performance budget:
  - Main-brain boot: ~10s (sentence-transformers import)
  - Sub-brain boot: ~5s (tsx + plugin discovery)
  - All test bodies: <5s combined
  - Total: ~20s when green, plus ~15s tmp cleanup
"""

from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.smoke


# ---------------------------------------------------------------------------
# Boot-invariant assertions
# ---------------------------------------------------------------------------


def test_main_brain_health_responds(smoke_rig):
    """Most basic invariant: main-brain answers /health with status=ok.

    This used to silently fail when port was already in use because
    lifespan loaded ALL state before binding; the user just saw the
    healthy startup logs then a crash. The fixture's _wait_for_http
    already guards this, but asserting explicitly makes the failure
    message clearer when it does break.
    """
    r = httpx.get(f"{smoke_rig.main_brain.base_url}/health", timeout=3.0)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("status") == "ok"
    # Core modules must report initialized — catches a regression where
    # some lifespan-stage error left a subsystem at None silently.
    modules = body.get("modules", {})
    for required in ("memory", "reasoning", "chat"):
        assert modules.get(required) is True, f"module {required!r} not initialized: {modules}"


def test_sub_brain_health_responds(smoke_rig):
    """Issue #8 class: sub-brain actually binds its port.

    Specifically catches the dual-`setNotFoundHandler` crash that left
    the tsx process alive but never listening. If sub-brain's startup
    crashes for ANY reason, the conftest fixture's _wait_for_http times
    out and this test never runs — the timeout error message includes
    the last 4KB of stdout so we can see what blew up.
    """
    r = httpx.get(f"{smoke_rig.sub_brain.base_url}/health", timeout=3.0)
    assert r.status_code == 200, r.text


def test_brain_proxy_passes_through_to_main_brain(smoke_rig):
    """The /brain/* proxy must reach the actual main-brain.

    Catches a class of regression where sub-brain runs but isn't actually
    wired to the configured main-brain URL — silently returns the
    sub-brain's own health, or returns 502 with a noisy log.
    """
    r = httpx.get(f"{smoke_rig.sub_brain.base_url}/brain/health", timeout=5.0)
    assert r.status_code == 200, r.text
    body = r.json()
    # /brain/health proxies main-brain's /health, which reports
    # component=main-brain. If we get sub-brain's own /health (which
    # reports something else), the proxy isn't actually proxying.
    assert body.get("component") == "main-brain", body


# ---------------------------------------------------------------------------
# Memory subsystem smoke
# ---------------------------------------------------------------------------


def test_memory_store_query_roundtrip_via_proxy(smoke_rig):
    """Store a memory through /brain/memory/store, query it back. Must work.

    This isn't unit-test territory — it's verifying that
        frontend → sub-brain (3000) → /brain/* proxy → main-brain → MemoryManager.store
    works end-to-end with no missing layer.

    Recall caveat: this test runs against a shared SQLite that may contain
    50+ pre-existing L3 rows from dev or prior smoke runs. With
    use_rerank=False + 0.7 relevance / 0.3 importance blending, the
    just-stored row competes against everything else with no special
    advantage. So we use a UNIQUE-PER-RUN anchor string (uuid4) that no
    other row can possibly contain — FTS will match it exactly.
    """
    import uuid
    base = smoke_rig.sub_brain.base_url
    # Random per-run sentinel — no pre-existing row contains this token
    sentinel = f"smoke-anchor-{uuid.uuid4().hex}"

    # CONTENT NOTE: each smoke test uses TOPIC-DISJOINT content so the
    # conflict detector finds no similar existing rows and never invokes
    # the LLM judge. With WEBRAIN_CONFLICT_LLM_TIMEOUT_S=2 the worst case
    # is 6s (3 candidates × 2s) so the 60s store timeout has plenty of
    # headroom. First store also pays one-time sentence-transformers load.
    store_resp = httpx.post(
        f"{base}/brain/memory/store",
        json={
            "content": f"{sentinel} smoke-roundtrip body content",
            "level": "L3",
            "source": "smoke",
        },
        timeout=60.0,
    )
    assert store_resp.status_code == 200, store_resp.text
    store_body = store_resp.json()
    assert store_body.get("stored") is True
    mem_id = store_body["id"]

    # Query by the sentinel only. FTS5 with the default tokenizer treats
    # this as one token (no spaces) and matches exactly the row we just
    # inserted. use_rerank=False to avoid the lazy cross-encoder download.
    query_resp = httpx.post(
        f"{base}/brain/memory/query",
        json={
            "query": sentinel,
            "levels": ["L3"],
            "limit": 5,
            "use_rerank": False,
        },
        timeout=30.0,
    )
    assert query_resp.status_code == 200, query_resp.text
    results = query_resp.json().get("results", [])
    assert any(r["id"] == mem_id for r in results), (
        f"Just-stored memory {mem_id} (sentinel={sentinel}) not retrievable. Got IDs: "
        f"{[r['id'] for r in results]}"
    )


# ---------------------------------------------------------------------------
# Issue #11 regression — conflict detector MUST be wired into store()
# ---------------------------------------------------------------------------


def test_l3_store_response_contains_conflict_field(smoke_rig):
    """The killer test for Issue #11: ConflictDetector was instantiated in
    lifespan and attached to MemoryManager.

    We don't require an LLM to actually be running — the detector might
    return `{"checked": 0, "conflicts": []}` if there are no similar
    existing memories or if the LLM is unreachable. What we DO require
    is that the `conflict` key exists in the response. Its presence
    proves that:

      1. MemoryManager.set_conflict_detector(...) was called (otherwise
         self._conflict_detector is None and the if-branch in store()
         that adds the conflict key is skipped entirely)
      2. The detector ran without throwing (otherwise the except branch
         logged a warning and set conflict_result to None)

    If this assertion ever fails, somebody removed the wiring from
    main_brain.py lifespan AGAIN — same bug class as Issue #11.
    """
    base = smoke_rig.sub_brain.base_url
    # 60s rather than 30s because this is module-scope-second L3 store —
    # if the previous test happened to trigger embedding model load, fine,
    # but on shared CI this test may STILL be the first to load the model
    # if pytest runs it earlier in random ordering. 60s = embedding cold
    # load (~10s) + worst-case 3 conflict LLM timeouts (3×2=6s) + slack.
    import uuid
    sentinel = f"smoke-wiring-{uuid.uuid4().hex}"
    r = httpx.post(
        f"{base}/brain/memory/store",
        json={
            "content": f"{sentinel} L3 wiring sentinel",
            "level": "L3",
            "source": "smoke",
        },
        timeout=60.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "conflict" in body, (
        f"L3 store response missing 'conflict' key — ConflictDetector "
        f"not wired in lifespan (Issue #11 regression). Body: {body}"
    )
    # Shape check: detector responses are always {"checked": int, "conflicts": list}
    conflict = body["conflict"]
    assert isinstance(conflict.get("checked"), int)
    assert isinstance(conflict.get("conflicts"), list)


def test_l1_store_does_not_invoke_conflict_detector(smoke_rig):
    """Inverse invariant: L1 stores should NOT carry a conflict field.

    Conflict detection is L3-only by design (L1 are event records, not
    claims that can contradict). If somebody loosened the level guard
    in store() — say, started running the detector on L2 summaries —
    that'd be a real performance regression (every chat message stored
    would trigger a vector search + LLM call).
    """
    base = smoke_rig.sub_brain.base_url
    r = httpx.post(
        f"{base}/brain/memory/store",
        json={
            "content": "smoke-l1-event-zephyr-pottery-trampoline",
            "level": "L1",
            "source": "smoke",
        },
        timeout=15.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "conflict" not in body, (
        f"L1 store unexpectedly carries 'conflict' key — detector should "
        f"be L3-only. Body: {body}"
    )


# ---------------------------------------------------------------------------
# MCP / LLM-stats surfaces — light pings to detect "endpoint not registered"
# regressions
# ---------------------------------------------------------------------------


def test_mcp_info_endpoint_reports_tool_inventory(smoke_rig):
    """Detects regressions where the MCP server is configured but the
    /mcp/info endpoint is missing or shape changed.

    The frontend MCPInfoPanel reads this — if we silently broke the
    shape, the panel would crash for users. Asserting the shape here
    locks the contract.
    """
    base = smoke_rig.sub_brain.base_url
    r = httpx.get(f"{base}/brain/mcp/info", timeout=5.0)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True
    assert "tools" in body
    assert isinstance(body["tools"], list)
    assert body.get("tool_count") == len(body["tools"])
    # M4b.1 auth status fields — frontend panel depends on these
    assert "auth_required_for_write" in body
    assert "token_configured" in body
    # Each tool entry must have name + description + scope (read|write)
    for t in body["tools"]:
        assert "name" in t and "description" in t
        assert t.get("scope") in ("read", "write")


def test_llm_stats_endpoint_returns_router_state(smoke_rig):
    """Detects regressions in the multi-LLM router exposure.

    LLMHealthPanel needs total_count / endpoints array shape. If endpoint
    enum or status enum changes, the panel breaks silently.
    """
    base = smoke_rig.sub_brain.base_url
    # 15s rather than 5s: this endpoint is in-memory snapshot but the
    # proxy hop through sub-brain → main-brain has been observed to take
    # several seconds on cold processes. Generous timeout makes the
    # test less flaky without compromising the signal we want (the
    # endpoint exists and returns the expected shape).
    r = httpx.get(f"{base}/brain/llm/stats", timeout=15.0)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "endpoints" in body and isinstance(body["endpoints"], list)
    assert "status" in body
    assert body["status"] in ("healthy", "degraded", "down")
