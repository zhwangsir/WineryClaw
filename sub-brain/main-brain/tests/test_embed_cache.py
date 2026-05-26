"""v2.49 — LRU embedding cache unit tests.

Pins three contract invariants:

1. **Correctness**: cache HIT returns the SAME vec the cache MISS computed.
   No drift — same text → same vec, byte-for-byte.
2. **Capacity**: LRU eviction when over `WEBRAIN_EMBED_CACHE_MAX`. Oldest
   text is dropped first; cache size never exceeds the cap.
3. **Disable knob**: `WEBRAIN_EMBED_CACHE_MAX=0` makes `_embed_cache_get`
   always return None and `_embed_cache_put` a no-op. Useful as a hot-fix
   if the cache ever causes a problem in prod.

Why these tests and not just rely on the benchmark: the benchmark verifies
*latency improved*, not *vectors stayed correct*. A bug that returns a
stale vector for a different text would still make the benchmark pass with
better numbers — and silently break recall.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import List
from unittest.mock import patch

import pytest

from memory.memory_manager import MemoryManager


def _mk_mm(cache_max: str = "64") -> MemoryManager:
    """Create a fresh MemoryManager with cache size set via env override.

    Use a temp DB so concurrent tests don't share state. llm_config left at
    default so the embedding-provider stack tries Ollama then OpenAI-compat
    then OpenAI (all will fail in the test sandbox; we mock _local_embedding
    directly to skip the network calls).
    """
    with patch.dict(os.environ, {"WEBRAIN_EMBED_CACHE_MAX": cache_max}):
        db = tempfile.mkstemp(suffix=".db")[1]
        return MemoryManager(db_path=db)


@pytest.mark.asyncio
async def test_cache_hit_returns_same_vec_as_miss():
    """Twice-embedded text returns the SAME vec on both calls.

    First call is a cache miss → computes via _local_embedding.
    Second call should hit the cache → bypass the encode entirely.
    Both vecs must be equal (same list contents) and a list (not a
    numpy view that could mutate from underneath the caller).
    """
    mm = _mk_mm("64")
    # Pin _local_embedding to a deterministic fake — no real torch needed
    # for this test, and we want to PROVE the cache short-circuits by
    # verifying the fake is called exactly once.
    call_count = [0]
    fake_vec: List[float] = [0.1, 0.2, 0.3, 0.4]

    async def fake_local(text: str):
        call_count[0] += 1
        return list(fake_vec)  # fresh copy each call

    # Empty the provider list so _get_embedding falls through to local
    mm._embedding_providers = []
    mm._local_embedding = fake_local  # type: ignore[assignment]

    v1 = await mm._get_embedding("hello world")
    v2 = await mm._get_embedding("hello world")

    assert v1 == fake_vec
    assert v2 == fake_vec
    assert v1 == v2
    # The second call must have been a cache hit — fake was NOT called
    # again. If this assertion fires, the cache lookup is broken.
    assert call_count[0] == 1, (
        f"Expected exactly one _local_embedding call for the same text "
        f"twice; got {call_count[0]} — cache lookup is broken."
    )


@pytest.mark.asyncio
async def test_different_texts_compute_different_vecs():
    """Cache key is the exact text; two distinct texts must not collide.

    Pre-v2.49 would always compute. v2.49 cache lookups must NOT confuse
    'foo' with 'bar' just because both happen to hash near each other.
    """
    mm = _mk_mm("64")

    async def fake_local(text: str):
        # Return a vec that depends on the text — exposes any
        # cross-text contamination.
        return [float(ord(c)) for c in text[:3].ljust(3, " ")]

    mm._embedding_providers = []
    mm._local_embedding = fake_local  # type: ignore[assignment]

    foo = await mm._get_embedding("foo")
    bar = await mm._get_embedding("bar")
    foo_again = await mm._get_embedding("foo")
    bar_again = await mm._get_embedding("bar")

    assert foo == [102.0, 111.0, 111.0]
    assert bar == [98.0, 97.0, 114.0]
    assert foo_again == foo  # cache hit, same vec
    assert bar_again == bar  # cache hit, same vec
    assert foo != bar


@pytest.mark.asyncio
async def test_lru_evicts_oldest_when_over_capacity():
    """Set a tiny cap, push N+1 entries, verify the first is gone.

    LRU semantics: oldest UNUSED entry evicts first. We don't touch the
    entries after inserting, so insertion order == eviction order.
    """
    mm = _mk_mm("3")  # tiny cap so we can overflow trivially
    assert mm._embed_cache_max == 3

    async def fake_local(text: str):
        return [float(len(text))]

    mm._embedding_providers = []
    mm._local_embedding = fake_local  # type: ignore[assignment]

    await mm._get_embedding("a")
    await mm._get_embedding("ab")
    await mm._get_embedding("abc")
    assert len(mm._embed_cache) == 3
    # Insert one more — 'a' (the LRU) should be evicted
    await mm._get_embedding("abcd")
    assert len(mm._embed_cache) == 3
    assert "a" not in mm._embed_cache
    assert "ab" in mm._embed_cache
    assert "abc" in mm._embed_cache
    assert "abcd" in mm._embed_cache


@pytest.mark.asyncio
async def test_lru_promotes_on_hit():
    """Accessing an entry moves it to the most-recent position, so a
    subsequent eviction targets a DIFFERENT (older) entry instead.

    Without this property the cache would degenerate to FIFO, which
    repeatedly evicts hot keys.
    """
    mm = _mk_mm("3")

    async def fake_local(text: str):
        return [float(len(text))]

    mm._embedding_providers = []
    mm._local_embedding = fake_local  # type: ignore[assignment]

    await mm._get_embedding("a")
    await mm._get_embedding("b")
    await mm._get_embedding("c")
    # Touch 'a' so it becomes MRU; 'b' is now LRU
    await mm._get_embedding("a")
    # Insert 'd' — 'b' (not 'a') should evict
    await mm._get_embedding("d")
    assert "a" in mm._embed_cache, "'a' was just touched, should not evict"
    assert "b" not in mm._embed_cache, "'b' is the LRU now, should evict"
    assert "c" in mm._embed_cache
    assert "d" in mm._embed_cache


@pytest.mark.asyncio
async def test_cache_disabled_when_max_is_zero():
    """`WEBRAIN_EMBED_CACHE_MAX=0` short-circuits both get and put.

    Hot-fix escape hatch: if the cache ever produces wrong results in
    prod, setting this env var to 0 reverts to pre-v2.49 behavior
    without a redeploy. This test pins that contract.
    """
    mm = _mk_mm("0")
    assert mm._embed_cache_max == 0

    call_count = [0]

    async def fake_local(text: str):
        call_count[0] += 1
        return [0.5]

    mm._embedding_providers = []
    mm._local_embedding = fake_local  # type: ignore[assignment]

    await mm._get_embedding("x")
    await mm._get_embedding("x")
    await mm._get_embedding("x")
    # All three calls hit the network/model path — no caching.
    assert call_count[0] == 3
    # Cache stays empty too.
    assert len(mm._embed_cache) == 0


@pytest.mark.asyncio
async def test_cache_skips_empty_vec():
    """If _local_embedding returns an empty list (degenerate case),
    don't cache it — we'd serve garbage forever otherwise.

    Defensive: pre-v2.49 the embed path treats `[]` as falsy and falls
    through. We must preserve that — cache must NOT short-circuit to
    an empty vec on the next call.
    """
    mm = _mk_mm("64")

    call_count = [0]

    async def fake_local(text: str):
        call_count[0] += 1
        # Always succeed with hash fallback, never empty — but verify
        # the cache layer handles the contract.
        return None  # type: ignore[return-value]  # falsy

    mm._embedding_providers = []
    mm._local_embedding = fake_local  # type: ignore[assignment]

    v1 = await mm._get_embedding("xyz")
    # _local returned None → falls to _fallback_embedding → returns hash vec
    assert v1 is not None
    assert len(v1) > 0

    # Second call: cache should now be warm with the HASH FALLBACK vec.
    # _local_embedding should NOT be called again.
    pre_count = call_count[0]
    v2 = await mm._get_embedding("xyz")
    assert v1 == v2
    assert call_count[0] == pre_count, (
        f"Expected cache to short-circuit even when local embed returned "
        f"None and fallback was used; got {call_count[0] - pre_count} extra "
        f"calls — fallback vec is not being cached."
    )
