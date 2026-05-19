"""Tests for "just-stored memory immediately retrievable" invariant.

The 2026-05-20 user-trial smoke test reported that a fresh L3 store
sometimes failed to come back via vector search. I logged it as "ANN
index lag" — but I never actually verified the diagnosis. This file
either:

  (a) confirms the bug exists (test fails → fix it)
  (b) refutes the diagnosis (test passes → the original smoke failure
      had a different root cause, likely importance blending against
      pre-existing rows in the dev DB)

Either outcome is useful. Without this test, the question stays open
forever.

The test uses a FRESH temp DB so there's no pre-existing data to
out-compete the just-stored row.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from memory.memory_manager import MemoryManager


@pytest.fixture
def fresh_mm(temp_dir, mock_llm_config) -> MemoryManager:
    """A MemoryManager with an empty DB — no historical data to bias rankings."""
    return MemoryManager(db_path=str(temp_dir / "freshness.db"), llm_config=mock_llm_config)


class TestJustStoredImmediatelyRetrievable:
    """Lock in: after store(), query() with the row's content finds it.

    If this test fails, "I just told you X but you don't remember" is a
    real bug in the system. If it passes, the user-trial smoke failure
    was about something else (blending against accumulated importance).
    """

    @pytest.mark.asyncio
    async def test_l3_store_then_query_by_content_finds_the_row(self, fresh_mm):
        # Plant ONE L3 row. Empty DB except this.
        result = await fresh_mm.store({
            "content": "The Eiffel Tower is in Paris and is 330 meters tall.",
            "level": "L3",
            "source": "test",
        })
        mem_id = result["id"]

        # Query — must find it
        hits = await fresh_mm.query({
            "query": "Eiffel Tower height",
            "levels": ["L3"],
            "limit": 5,
            "use_rerank": False,
        })

        assert any(h["id"] == mem_id for h in hits), (
            f"Just-stored memory {mem_id} not found. Got: "
            f"{[(h['id'][:8], h.get('vector_score', 0)) for h in hits]}"
        )

    @pytest.mark.asyncio
    async def test_l1_store_then_query_finds_via_fts_even_without_vector(self, fresh_mm, monkeypatch):
        """L1 with embeddings disabled — FTS should still find it. Catches
        regression where the FTS trigger fails or store skips FTS insert."""
        monkeypatch.setenv("WEBRAIN_MEMORY_EMBED_L1", "0")
        # Reinstantiate to pick up env (FTS triggers are schema-level so
        # they're already in place from fresh_mm; just need to re-store)
        result = await fresh_mm.store({
            "content": "unique-l1-token-xyz123 about cats",
            "level": "L1",
            "source": "test",
        })
        mem_id = result["id"]
        hits = await fresh_mm.query({
            "query": "unique-l1-token-xyz123",
            "levels": ["L1"],
            "limit": 5,
            "use_rerank": False,
        })
        assert any(h["id"] == mem_id for h in hits), (
            f"Just-stored L1 {mem_id} not found via FTS. Got: "
            f"{[h['id'][:8] for h in hits]}"
        )

    @pytest.mark.asyncio
    async def test_multiple_l3_stores_each_immediately_retrievable(self, fresh_mm):
        """Add several L3 rows in sequence; each one should be findable
        immediately after its own store call. This is the "I just told
        you A, then I just told you B" user flow."""
        contents = [
            ("The user lives in Tokyo since 2020.", "Tokyo 2020"),
            ("The user works as a software engineer.", "software engineer"),
            ("The user enjoys black coffee and dark chocolate.", "black coffee"),
        ]
        ids: list = []
        for content, _ in contents:
            r = await fresh_mm.store({
                "content": content, "level": "L3", "source": "test",
            })
            ids.append(r["id"])

        # Now query for each — each should land in top results
        misses = []
        for (content, query), mem_id in zip(contents, ids):
            hits = await fresh_mm.query({
                "query": query, "levels": ["L3"], "limit": 5, "use_rerank": False,
            })
            if not any(h["id"] == mem_id for h in hits):
                misses.append((query, mem_id, [(h["id"][:8], h.get("vector_score", 0), h["content"][:40]) for h in hits]))

        assert not misses, f"Some rows not retrievable: {misses}"

    @pytest.mark.asyncio
    async def test_brute_force_path_used_when_ann_dirty(self, fresh_mm):
        """Sanity: with fewer than 10 vectors, _vector_search's ANN fast
        path is skipped (its `len >= 10` guard). The brute-force fallback
        runs against the in-memory matrix, which gets updated on every
        _store_embedding call. This test pins that behaviour.
        """
        for i in range(3):
            await fresh_mm.store({
                "content": f"row {i} content about apples and oranges",
                "level": "L3", "source": "test",
            })
        # ANN may or may not exist; matrix definitely should
        assert fresh_mm._vector_matrix is not None
        assert len(fresh_mm._vector_ids) == 3

        hits = await fresh_mm.query({
            "query": "apples oranges",
            "levels": ["L3"], "limit": 3, "use_rerank": False,
        })
        # All 3 should appear (they all match "apples oranges")
        assert len(hits) == 3, f"Expected 3 hits, got {len(hits)}: {[h['id'][:8] for h in hits]}"

    @pytest.mark.asyncio
    async def test_ann_dirty_flag_set_after_store(self, fresh_mm):
        """Pin the contract: every _store_embedding marks ann_dirty=True
        so subsequent queries don't use a stale index.

        If this ever becomes False after a store, that's an "ANN lag" bug:
        new vectors won't surface until the next periodic rebuild.
        """
        # Get to 10 vectors so ANN index could exist
        for i in range(10):
            await fresh_mm.store({"content": f"warmup-row-{i}", "level": "L3"})

        # Force an ANN build by querying (the rebuild trigger is once
        # per 50 inserts, but _build_ann_index can also be called by
        # _load_vector_index on init — won't run here since fresh)
        fresh_mm._build_ann_index()
        assert fresh_mm._ann_dirty is False

        # Now plant one more — dirty must flip back to True
        await fresh_mm.store({"content": "post-build-fresh-row", "level": "L3"})
        assert fresh_mm._ann_dirty is True, (
            "ann_dirty did not flip after store; queries would use stale ANN "
            "missing the newly-stored vector (ANN lag bug)"
        )


class TestFts5SafeQuery:
    """Lock in the FTS5 query-escaping behaviour. The 2026-05-20 freshness
    test caught a real bug: "unique-l1-token-xyz123" crashed FTS5 because
    `-l1-` was parsed as a column-qualified negation."""

    def test_simple_two_word_query_becomes_two_phrases(self):
        from memory.memory_manager import _build_fts5_safe_query
        assert _build_fts5_safe_query("apples oranges") == '"apples" "oranges"'

    def test_hyphenated_token_stays_literal_not_negation(self):
        from memory.memory_manager import _build_fts5_safe_query
        # Without quoting, this would parse as `unique AND NOT l1 AND NOT token AND NOT xyz123`
        # and crash with "no such column: l1"
        assert (
            _build_fts5_safe_query("unique-l1-token-xyz123")
            == '"unique-l1-token-xyz123"'
        )

    def test_colon_token_does_not_become_column_qualifier(self):
        from memory.memory_manager import _build_fts5_safe_query
        # FTS5 reads `level:L3` as "match L3 in column `level`"; we want literal
        assert _build_fts5_safe_query("level:L3") == '"level:L3"'

    def test_internal_double_quotes_escaped(self):
        from memory.memory_manager import _build_fts5_safe_query
        # Double-quote → "" per FTS5 phrase-literal grammar
        assert _build_fts5_safe_query('he said "hi"') == '"he" "said" """hi"""'

    def test_empty_or_whitespace_returns_empty(self):
        from memory.memory_manager import _build_fts5_safe_query
        assert _build_fts5_safe_query("") == ""
        assert _build_fts5_safe_query("   ") == ""
        assert _build_fts5_safe_query(None) == ""  # type: ignore[arg-type]

    def test_punctuation_preserved_inside_token(self):
        from memory.memory_manager import _build_fts5_safe_query
        # "Hello, world!" → two tokens, punctuation stays inside the phrase
        result = _build_fts5_safe_query("Hello, world!")
        assert result == '"Hello," "world!"'

    def test_multiple_whitespace_collapses(self):
        from memory.memory_manager import _build_fts5_safe_query
        # split() handles any whitespace incl. multiple spaces / tabs
        assert _build_fts5_safe_query("foo  \tbar\n  baz") == '"foo" "bar" "baz"'


class TestQueryReturnsPostIncrementAccessCount:
    """User-trial #2: callers querying memory used to see access_count for
    each returned row as the value BEFORE the bump triggered by the query
    itself. The MemoryPage UI then displayed `access_count: 0` for a row
    the user had just retrieved, which was confusing. Locked in here: the
    rows we return reflect the bump that just happened."""

    @pytest.mark.asyncio
    async def test_returned_row_shows_bumped_access_count(self, fresh_mm):
        result = await fresh_mm.store({
            "content": "user trial issue #2 sentinel", "level": "L3", "source": "test",
        })
        mem_id = result["id"]

        # First query — row should report access_count=1, not 0
        hits = await fresh_mm.query({
            "query": "user trial issue #2",
            "levels": ["L3"], "limit": 5, "use_rerank": False,
        })
        row = next(h for h in hits if h["id"] == mem_id)
        assert row["access_count"] == 1, (
            f"Expected access_count=1 (post-bump), got {row['access_count']}. "
            "User-trial #2 regression."
        )

    @pytest.mark.asyncio
    async def test_second_query_increments_again(self, fresh_mm):
        result = await fresh_mm.store({
            "content": "double-query sentinel", "level": "L3", "source": "test",
        })
        mem_id = result["id"]

        for expected_count in (1, 2, 3):
            hits = await fresh_mm.query({
                "query": "double-query sentinel",
                "levels": ["L3"], "limit": 5, "use_rerank": False,
            })
            row = next(h for h in hits if h["id"] == mem_id)
            assert row["access_count"] == expected_count

    @pytest.mark.asyncio
    async def test_last_accessed_at_reflects_current_time(self, fresh_mm):
        from datetime import datetime, timezone
        result = await fresh_mm.store({
            "content": "timestamp test", "level": "L3", "source": "test",
        })
        mem_id = result["id"]
        before = datetime.now(timezone.utc)
        hits = await fresh_mm.query({
            "query": "timestamp test",
            "levels": ["L3"], "limit": 5, "use_rerank": False,
        })
        after = datetime.now(timezone.utc)
        row = next(h for h in hits if h["id"] == mem_id)
        last_iso = row.get("last_accessed_at")
        assert last_iso, "last_accessed_at should be populated on returned row"
        last_ts = datetime.fromisoformat(last_iso)
        # The bump's timestamp should fall within the query's wall clock window
        assert before <= last_ts <= after, (
            f"last_accessed_at={last_ts} not within [{before}, {after}]"
        )


class TestEmbedderCacheSingleton:
    """The 2026-05-20 user trial measured first L3 store = 19.9s, second =
    4.8s. Root cause: _local_embedding instantiated SentenceTransformer
    on every call. Fixed by module-level _get_embedder cache. These tests
    lock in the cache behaviour so a regression here is impossible to
    miss."""

    def test_get_embedder_returns_same_instance_across_calls(self):
        from memory.memory_manager import _get_embedder
        m1 = _get_embedder()
        m2 = _get_embedder()
        if m1 is None:
            pytest.skip("sentence-transformers not installed; cache check skipped")
        assert m1 is m2, "Embedder cache returned different instances; load cost will repeat"

    @pytest.mark.asyncio
    async def test_warm_local_embedder_returns_true_when_model_available(self):
        from memory.memory_manager import warm_local_embedder, _get_embedder
        if _get_embedder() is None:
            pytest.skip("sentence-transformers not installed; warm-up signal not testable")
        ok = await warm_local_embedder()
        assert ok is True


class TestQueryLevelFilterAppliesToVectorSearch:
    """Regression — discovered by the dreaming smoke test (2026-05-20).

    _vector_search ignored the `levels` filter entirely; only _fts_search
    honored it. So a query with levels=["L2"] could return L1 rows via
    the vector path, leaking lower-level noise. Surfaced as: an L2 query
    returning an L1 row whose provenance_refs was empty (since L1 rows
    don't have provenance), breaking lineage assertions downstream.

    These tests pin the contract: query(levels=[X]) returns rows where
    every row.level is in [X]. Period.
    """

    @pytest.mark.asyncio
    async def test_query_l2_does_not_return_l1_via_vector_match(self, fresh_mm):
        # Plant an L1 row with content that vector-matches the query
        # closely. If the level filter is bypassed in vector search, this
        # L1 will leak into an L2-only query.
        l1 = await fresh_mm.store({
            "level": "L1", "content": "Apple is a popular fruit grown worldwide",
            "source": "test",
        })
        # No L2 rows in the DB at all
        results = await fresh_mm.query({
            "query": "apple fruit popular",
            "levels": ["L2"],
            "limit": 10,
            "use_rerank": False,  # rerank model is heavy
        })
        # The level filter must hold: zero L2 in DB → zero results
        levels_returned = [r.get("level") for r in results]
        assert all(lv == "L2" for lv in levels_returned), (
            f"L2-only query returned non-L2 rows: {levels_returned}. "
            f"Vector search is bypassing the level filter."
        )

    @pytest.mark.asyncio
    async def test_query_l2_returns_l2_even_when_l1_has_higher_score(self, fresh_mm):
        # Plant an L1 that's a near-perfect vector match for the query
        # AND an L2 that's a weaker match. The L1 should be excluded.
        await fresh_mm.store({
            "level": "L1", "content": "Apple banana cherry date elderberry",
            "source": "test",
        })
        l2 = await fresh_mm.store({
            "level": "L2", "content": "Some fruits in alphabetical order",
            "source": "test",
        })
        results = await fresh_mm.query({
            "query": "apple banana cherry",
            "levels": ["L2"],
            "limit": 5,
            "use_rerank": False,
        })
        # Every returned row must be L2 — the strong-matching L1 must not appear
        for r in results:
            assert r.get("level") == "L2", (
                f"Got non-L2 row in L2-only query: {r.get('level')} (id={r.get('id')})"
            )
        # And our planted L2 should be among the results
        assert any(r.get("id") == l2["id"] for r in results), (
            f"Planted L2 {l2['id']} missing from L2-only query results: "
            f"{[r.get('id') for r in results]}"
        )

    @pytest.mark.asyncio
    async def test_query_multi_level_includes_each_planted_row(self, fresh_mm):
        # Sanity: when filter includes multiple levels, all should be returned.
        # Without this we couldn't tell if the fix over-corrected (e.g.,
        # accidentally requiring exact level==target instead of level IN set).
        l1 = await fresh_mm.store({
            "level": "L1", "content": "zephyr quark plankton unique-tokens",
            "source": "test",
        })
        l2 = await fresh_mm.store({
            "level": "L2", "content": "zephyr quark plankton unique-tokens",
            "source": "test",
        })
        results = await fresh_mm.query({
            "query": "zephyr quark plankton",
            "levels": ["L1", "L2"],
            "limit": 10,
            "use_rerank": False,
        })
        ids = {r.get("id") for r in results}
        assert l1["id"] in ids, f"L1 {l1['id']} missing from multi-level query: {ids}"
        assert l2["id"] in ids, f"L2 {l2['id']} missing from multi-level query: {ids}"
