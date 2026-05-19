"""L3 conflict detection for the Memory subsystem (M-Memory-1).

When a new L3 fact is stored, we want to know if it directly contradicts
an existing L3 fact. Two conflicting facts share a `conflict_group` UUID
so the UI can present both and the user can decide which one is current.
By default the newer fact wins (`is_current = 1`); the older becomes
`is_current = 0` but stays in the database — we never delete contradicting
evidence, only mark it stale.

Why a separate module:
  - Conflict detection costs one embedding lookup + N LLM calls per L3
    store. That's significant latency. Keeping it pluggable means tests
    can run with a stub detector that does nothing, and ChatEngine /
    DreamingEngine can opt in selectively.
  - The judgment ("do these contradict?") is purely a domain question
    about how facts are written. Pulling it out of MemoryManager keeps
    MemoryManager focused on storage mechanics.

Public surface:
    detector = ConflictDetector(llm_caller=..., threshold=0.7)
    await detector.detect_and_mark(memory_manager, new_l3_id, content)

The detector reads `memory_manager` directly because conflict resolution
needs vector search, SQL writes, and the new memory's ID — passing the
whole manager is simpler than reproducing all of that here.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any, Awaitable, Callable, Dict, List, Optional

logger = logging.getLogger("webrain.memory.conflict")


# A pluggable LLM caller: takes a list of messages, returns the assistant text.
# Matches the shape of ChatEngine._chat_completion's input. Tests inject a stub
# that returns a canned JSON verdict; production code wires this to the
# main-brain LLM router.
LLMCaller = Callable[[List[Dict[str, str]]], Awaitable[str]]


# Cosine-similarity floor for considering two L3 facts as candidates for
# contradiction. Below this they're unrelated enough that the LLM check
# isn't worth the cost.
DEFAULT_SIMILARITY_THRESHOLD = 0.7
# Maximum number of similar candidates we'll ask the LLM about per store.
# Caps cost at one fixed multiple of L3 writes.
DEFAULT_MAX_CANDIDATES = 3


class ConflictDetector:
    def __init__(
        self,
        llm_caller: LLMCaller,
        threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
        max_candidates: int = DEFAULT_MAX_CANDIDATES,
    ) -> None:
        self._call_llm = llm_caller
        self.threshold = threshold
        self.max_candidates = max_candidates

    async def detect_and_mark(
        self,
        memory_manager: Any,
        new_memory_id: str,
        content: str,
    ) -> Dict[str, Any]:
        """Find any existing L3 memories that contradict `content` and mark them.

        Returns a dict describing what happened so callers (and the future
        /memory/conflicts endpoint) can surface it:

            {
                "checked": <int>,        # candidates above similarity threshold
                "conflicts": [
                    {"existing_id": ..., "conflict_group": ..., "reason": ...},
                    ...
                ]
            }

        Never raises — a misbehaving LLM, a missing vector index, or DB
        weirdness logs a warning and returns the empty "no conflicts found"
        shape. Storage of the new memory has already happened before this
        runs; we just decorate it after the fact.
        """
        try:
            candidates = await self._find_similar_l3(memory_manager, content, new_memory_id)
        except Exception as e:
            logger.warning("conflict detector: similarity search failed: %s", e)
            return {"checked": 0, "conflicts": []}

        if not candidates:
            return {"checked": 0, "conflicts": []}

        conflicts: List[Dict[str, Any]] = []
        for cand in candidates:
            try:
                verdict = await self._judge_contradiction(content, cand["content"])
            except Exception as e:
                logger.warning("conflict detector: LLM judge failed: %s", e)
                continue
            if not verdict.get("contradicts"):
                continue

            group_id = cand.get("conflict_group") or f"conflict-{uuid.uuid4().hex[:12]}"
            self._mark_pair(memory_manager, new_memory_id, cand["id"], group_id)
            conflicts.append({
                "existing_id": cand["id"],
                "conflict_group": group_id,
                "reason": verdict.get("reason", ""),
            })

        return {"checked": len(candidates), "conflicts": conflicts}

    # -- Internals ---------------------------------------------------------

    async def _find_similar_l3(
        self,
        memory_manager: Any,
        content: str,
        new_memory_id: str,
    ) -> List[Dict[str, Any]]:
        """Return up to `max_candidates` similar EXISTING current L3 memories.

        Filters out:
          - the newly-stored memory itself
          - rows below the similarity threshold
          - rows already marked is_current = 0 (already-superseded)
        """
        # We over-fetch from vector search and then filter — the search
        # doesn't know about level or is_current.
        raw = await memory_manager._vector_search(
            content,
            limit=self.max_candidates * 4,
            exclude_ids=[new_memory_id],
        )
        out: List[Dict[str, Any]] = []
        for r in raw:
            if r.get("level") != "L3":
                continue
            if r.get("is_current", 1) != 1:
                continue
            score = float(r.get("vector_score", 0.0))
            if score < self.threshold:
                continue
            out.append(r)
            if len(out) >= self.max_candidates:
                break
        return out

    async def _judge_contradiction(self, new_content: str, existing_content: str) -> Dict[str, Any]:
        """Ask the LLM whether two L3 facts directly contradict each other.

        Returns {"contradicts": bool, "reason": str}. We're strict about
        what counts as contradiction:
          - Yes: "User lives in Beijing" vs "User lives in Shanghai"
          - Yes: "User likes coffee" vs "User dislikes coffee"
          - No:  "User likes coffee" vs "User likes tea" (orthogonal)
          - No:  "User lives in Beijing" vs "User visited Shanghai" (compatible)

        On any parse failure → {"contradicts": False, "reason": "..."}
        which means we err on the side of NOT marking conflicts. False
        positives confuse the user; false negatives just mean both facts
        coexist as currently-known truths, which is the v1 default anyway.
        """
        prompt = (
            "Two semantic facts about a user have been recorded. Determine "
            "whether they DIRECTLY CONTRADICT each other — i.e. they cannot "
            "both be true at the same point in time about the same subject. "
            "Orthogonal facts that happen to share keywords do NOT contradict. "
            "Update-style changes (\"used to live in X, now lives in Y\") DO "
            "contradict because they describe the same slot with different "
            "values.\n\n"
            f"Fact A (new): {new_content}\n"
            f"Fact B (existing): {existing_content}\n\n"
            "Output STRICT JSON only, no markdown:\n"
            '{"contradicts": true|false, "reason": "one short sentence"}'
        )
        text = await self._call_llm([
            {"role": "system", "content": "You are a fact contradiction judge. Output JSON only."},
            {"role": "user", "content": prompt},
        ])
        if not text:
            return {"contradicts": False, "reason": "empty LLM response"}

        # Lenient JSON extraction — model might fence the response.
        cleaned = text.strip()
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if match:
            cleaned = match.group(0)
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            return {"contradicts": False, "reason": "unparseable LLM output"}

        return {
            "contradicts": bool(parsed.get("contradicts", False)),
            "reason": str(parsed.get("reason", "")).strip(),
        }

    @staticmethod
    def _mark_pair(memory_manager: Any, new_id: str, existing_id: str, group_id: str) -> None:
        """Stamp both rows with the shared conflict_group; new wins.

        Resolution policy v1: newer fact is current, older is_current = 0.
        Both rows remain visible in the database. A future API can let the
        user override this manually.
        """
        with memory_manager._connect() as conn:
            conn.execute(
                "UPDATE memories SET conflict_group = ?, is_current = 1 WHERE id = ?",
                (group_id, new_id),
            )
            conn.execute(
                "UPDATE memories SET conflict_group = ?, is_current = 0 WHERE id = ?",
                (group_id, existing_id),
            )
            conn.commit()
