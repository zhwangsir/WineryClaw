"""
Dreaming Engine — Memory Consolidation (L1→L2→L3→L4)

Simulates sleep phases to consolidate memories:
- Light Sleep: L1 → L2 (session summaries)
- REM Sleep: L2 → L3 (entity/fact extraction)
- Deep Sleep: L3 → L4 (skill pattern extraction)
"""

import collections
import json
import logging
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Deque, Dict, List, Optional

import httpx

logger = logging.getLogger("webrain.dreaming")


class DreamingEngine:
    """Consolidates memories across L1-L4 hierarchies using LLM."""

    # S6: 主动洞察缓冲区 (Proactive Intelligence) — 存放 Dreaming 周期生成的洞察
    INSIGHT_BUFFER_MAX = 20

    # S7: L3 去重——facts_created < MIN_FACTS_FOR_INSIGHT 时不调用去重 LLM
    MIN_FACTS_FOR_INSIGHT = 3  # already used in S6; kept as single source of truth

    def __init__(self, memory_manager: Any, llm_config: Optional[Dict] = None):
        self.memory = memory_manager
        self.llm_config = llm_config or {
            "base_url": "http://localhost:1234/v1",
            "model_id": "minimax/minimax-m2.7",
        }
        # S6: 滚动缓冲区存放最近 INSIGHT_BUFFER_MAX 条主动洞察
        # 使用 deque 自动淘汰最旧的条目，无需手动管理大小
        self._insight_buffer: Deque[Dict[str, Any]] = collections.deque(
            maxlen=self.INSIGHT_BUFFER_MAX
        )
        # S7: 语义去重参数 — 超过阈值的 L3 事实直接更新已有条目而非新建重复行
        self.dedup_enabled: bool = os.environ.get("WEBRAIN_DEDUP_ENABLED", "1") != "0"
        self.dedup_threshold: float = float(
            os.environ.get("WEBRAIN_DEDUP_THRESHOLD", "0.85")
        )

    async def _llm_call(self, messages: List[Dict], max_tokens: int = 1024) -> str:
        """Call LLM with multi-endpoint fallback."""
        endpoints = self.llm_config.get("endpoints", [{
            "base_url": self.llm_config.get("base_url", "http://localhost:1234/v1"),
            "model_id": self.llm_config.get("model_id", "minimax/minimax-m2.7"),
            "api_key": self.llm_config.get("api_key"),
        }])

        last_error = None
        for ep in endpoints:
            base_url = ep.get("base_url", ep.get("baseUrl", "")).rstrip("/")
            model_id = ep.get("model_id", ep.get("modelId", "default"))
            api_key = ep.get("api_key", ep.get("apiKey"))

            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    resp = await client.post(
                        f"{base_url}/chat/completions",
                        json={
                            "model": model_id,
                            "messages": messages,
                            "temperature": 0.3,
                            "max_tokens": max_tokens,
                        },
                        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {api_key}"} if api_key else {})},
                    )
                    resp.raise_for_status()
                    return resp.json()["choices"][0]["message"]["content"]
            except Exception as e:
                last_error = e
                logger.warning(f"Dreaming LLM call failed for {base_url}: {e}")
                continue

        logger.error(f"All LLM endpoints failed for dreaming: {last_error}")
        return ""

    # ========== Phase 1: Light Sleep (L1 → L2) — M-Memory-1 rewrite ==========
    # The original implementation re-ran every scheduler tick and created a
    # fresh L2 summary for the same session each time — yielding ~4
    # duplicate summaries per day per session. The rewrite:
    #   1. Only consolidates sessions that have been QUIET for `quiet_minutes`
    #      (default 30) — actively-running conversations are still mutating
    #      and shouldn't be frozen yet.
    #   2. Skips any L1 row whose `superseded_by` is already set — guarantees
    #      a single L1 contributes to exactly one L2 across all consolidation
    #      runs, ever.
    #   3. Writes provenance_source="consolidation_l1_l2" and
    #      provenance_refs=[L1 ids] on the new L2 row so the lineage can be
    #      walked back to source events.
    #   4. Marks each contributing L1 row with `superseded_by = <new L2 id>`.
    #      Original content stays — superseded means "rolled up", not deleted.
    QUIET_MINUTES = 30
    MIN_L1_PER_SESSION = 3
    MAX_L1_PER_SESSION = 80  # cap prompt size for very long sessions

    async def consolidate_l1_to_l2(
        self,
        quiet_minutes: Optional[int] = None,
        lookback_days: int = 7,
    ) -> Dict[str, Any]:
        """Summarize quiet, unconsolidated L1 session windows into L2.

        Args:
            quiet_minutes: a session is "quiet" when its latest L1 row is
                older than this many minutes. Defaults to QUIET_MINUTES.
            lookback_days: only consider sessions with L1 activity in the
                last N days; older orphans should already be archived.

        Returns dict with:
            consolidated: count of L2 rows created
            sessions_evaluated: sessions that had any L1 in scope
            sessions_skipped_active: dropped because still active
            sessions_skipped_short: dropped because fewer than MIN_L1
            sessions_skipped_done: dropped because all L1 already superseded
        """
        quiet = quiet_minutes if quiet_minutes is not None else self.QUIET_MINUTES
        cutoff_quiet = (datetime.now(timezone.utc) - timedelta(minutes=quiet)).isoformat()
        cutoff_old = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()

        # One query: fetch unsuperseded L1 in the lookback window. Filter the
        # quiet check in Python — needs per-session max(created_at) which is
        # cleaner to compute after grouping.
        with self.memory._connect() as conn:
            rows = conn.execute(
                """SELECT id, content, session_id, created_at, source
                   FROM memories
                   WHERE level = 'L1'
                     AND (superseded_by IS NULL OR superseded_by = '')
                     AND created_at > ?
                   ORDER BY created_at""",
                (cutoff_old,),
            ).fetchall()

        if not rows:
            return {
                "consolidated": 0, "sessions_evaluated": 0,
                "sessions_skipped_active": 0, "sessions_skipped_short": 0,
                "sessions_skipped_done": 0,
                "message": "No unconsolidated L1 memories in lookback window",
            }

        # Group by session (skip empty session_ids — those are orphan events
        # without a conversation thread and aren't worth a summary).
        sessions: Dict[str, List[Dict[str, Any]]] = {}
        for row in rows:
            sid = row["session_id"]
            if not sid:
                continue
            sessions.setdefault(sid, []).append(dict(row))

        consolidated = 0
        skipped_active = 0
        skipped_short = 0
        skipped_done = 0  # placeholder — query already excluded these

        for session_id, l1_rows in sessions.items():
            # Quiet check: latest L1 in this session must be older than cutoff
            latest_ts = max(r["created_at"] for r in l1_rows)
            if latest_ts >= cutoff_quiet:
                skipped_active += 1
                continue
            if len(l1_rows) < self.MIN_L1_PER_SESSION:
                skipped_short += 1
                continue

            # Cap to MAX_L1_PER_SESSION (keep earliest + latest blocks if long)
            if len(l1_rows) > self.MAX_L1_PER_SESSION:
                head = self.MAX_L1_PER_SESSION // 2
                tail = self.MAX_L1_PER_SESSION - head
                selected = l1_rows[:head] + l1_rows[-tail:]
            else:
                selected = l1_rows

            text = "\n".join(r["content"] for r in selected)
            summary = await self._llm_call(
                [
                    {
                        "role": "system",
                        "content": (
                            "You are a memory consolidation expert. Produce a concise, "
                            "factual summary in the dominant language of the input. "
                            "Capture: key facts, user preferences expressed, decisions made, "
                            "open questions, and any explicit action items. Skip pleasantries. "
                            "Stay under 200 words."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"Summarize this conversation (session {session_id[:8]}, "
                            f"{len(selected)} messages):\n\n{text}\n\nSummary:"
                        ),
                    },
                ],
                max_tokens=512,
            )

            if not summary or not summary.strip():
                # LLM unavailable or empty — leave L1 unsuperseded so next
                # run can retry. Don't mark as failed/done.
                continue

            l1_ids = [r["id"] for r in selected]
            result = await self.memory.store({
                "level": "L2",
                "content": f"[Session {session_id[:8]}] {summary.strip()}",
                "source": "dreaming_l1_to_l2",
                "session_id": session_id,
                "provenance_source": "consolidation_l1_l2",
                "provenance_refs": l1_ids,
            })
            l2_id = result["id"]

            # Mark all source L1 rows as superseded by this L2
            with self.memory._connect() as conn:
                placeholders = ",".join(["?"] * len(l1_ids))
                conn.execute(
                    f"UPDATE memories SET superseded_by = ? WHERE id IN ({placeholders})",
                    (l2_id, *l1_ids),
                )
                conn.commit()
            consolidated += 1

        logger.info(
            "[Dreaming] L1→L2: %d sessions consolidated, %d active-skip, %d short-skip",
            consolidated, skipped_active, skipped_short,
        )
        return {
            "consolidated": consolidated,
            "sessions_evaluated": len(sessions),
            "sessions_skipped_active": skipped_active,
            "sessions_skipped_short": skipped_short,
            "sessions_skipped_done": skipped_done,
        }

    # ========== Phase 2: REM Sleep (L2 → L3) — M-Memory-1 rewrite ==========
    # Original implementation:
    #   - Called memory.extract_semantic() which writes to entities/facts
    #     tables, NOT to L3 memory rows. So `levels=["L3"]` queries returned
    #     empty across the board.
    #   - Re-ran every tick, re-processing the same L2 rows.
    #
    # Rewrite:
    #   1. Only processes L2 rows that have not already produced an L3 fact
    #      (tracked via reverse provenance lookup — an L3 row exists with
    #      this L2 id in its provenance_refs).
    #   2. LLM produces a JSON list of structured facts; each becomes its
    #      own L3 row so they're independently retrievable.
    #   3. L2 is NOT superseded — it's the human-readable narrative, L3 is
    #      the semantic distillate. Both live on.
    L2_TO_L3_BATCH = 20  # Max L2 rows processed per run
    L3_FACT_KINDS = ("preference", "fact", "decision", "goal", "open_question")

    async def _find_similar_l3(self, content: str) -> Optional[Dict[str, Any]]:
        """S7: 语义去重检查 — 返回与 content 余弦相似度超过阈值的最近 L3 事实。

        失败时静默降级（返回 None），绝不阻塞 L2→L3 整合主路径。
        """
        if not self.dedup_enabled:
            return None
        try:
            candidates = await self.memory._vector_search(
                content,
                limit=3,
                levels=["L3"],
            )
            if not candidates:
                return None
            # _vector_search 为每行附加 vector_score（余弦相似度 0-1）
            top = candidates[0]
            if top.get("vector_score", 0.0) >= self.dedup_threshold:
                return top
            return None
        except Exception as e:
            logger.debug("[Dreaming/S7] 去重检查失败（非致命）: %s", e)
            return None

    async def consolidate_l2_to_l3(
        self,
        limit: Optional[int] = None,
        lookback_days: int = 14,
    ) -> Dict[str, Any]:
        """Distill recent unprocessed L2 summaries into structured L3 facts.

        Idempotency: an L2 row is "processed" iff at least one L3 row's
        provenance_refs contains its id. This survives restarts and partial
        failures — if we crash mid-batch, the next run picks up where we
        left off without duplicating already-extracted facts.

        Returns dict with:
            l2_processed: number of L2 rows we attempted
            facts_created: total L3 rows written
            facts_skipped_empty: L2 rows the LLM produced no facts for
            facts_deduplicated: L3 facts merged into existing rows (S7)
        """
        batch = limit if limit is not None else self.L2_TO_L3_BATCH
        cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()

        # Step 1: find L2 rows in the lookback window
        with self.memory._connect() as conn:
            l2_rows = conn.execute(
                """SELECT id, content, session_id, created_at
                   FROM memories
                   WHERE level = 'L2' AND created_at > ?
                   ORDER BY created_at DESC
                   LIMIT ?""",
                (cutoff, batch * 3),  # over-fetch — many may already be processed
            ).fetchall()

            # Step 2: pull all L3 rows' provenance_refs to detect already-processed L2s.
            # SQLite has no JSON_CONTAINS — fetch the whole set once and check in Python.
            # In practice this is a small set (~hundreds), much cheaper than per-L2 query.
            l3_refs_rows = conn.execute(
                "SELECT provenance_refs FROM memories WHERE level = 'L3'"
            ).fetchall()

        processed_l2_ids: set = set()
        for r in l3_refs_rows:
            try:
                refs = json.loads(r["provenance_refs"] or "[]")
                processed_l2_ids.update(refs)
            except (ValueError, TypeError):
                continue

        unprocessed = [r for r in l2_rows if r["id"] not in processed_l2_ids]
        unprocessed = unprocessed[:batch]

        if not unprocessed:
            return {
                "l2_processed": 0, "facts_created": 0, "facts_skipped_empty": 0,
                "facts_deduplicated": 0,
                "message": "No unprocessed L2 memories in lookback window",
            }

        facts_created = 0
        facts_skipped_empty = 0
        facts_deduplicated = 0  # S7: semantic dedup counter

        for row in unprocessed:
            l2_id = row["id"]
            l2_content = row["content"]
            l2_session = row["session_id"] or ""

            # Unfold L2 provenance so L3 can trace back to original L1 events.
            l2_refs_raw = row["provenance_refs"] if "provenance_refs" in row.keys() else "[]"
            if isinstance(l2_refs_raw, str):
                try:
                    l2_refs = json.loads(l2_refs_raw)
                except (ValueError, TypeError):
                    l2_refs = []
            else:
                l2_refs = l2_refs_raw or []
            l1_ids_from_l2 = [r for r in l2_refs if r != l2_id]

            facts = await self._extract_l3_facts(l2_content)
            if not facts:
                facts_skipped_empty += 1
                continue

            for fact in facts:
                kind = fact.get("kind") or "fact"
                statement = (fact.get("statement") or "").strip()
                if not statement:
                    continue
                # Format: "[kind] statement"
                # Keeping the kind in-band lets FTS/vector search hit on it
                # without needing a separate column. Provenance carries the
                # structured form for future use.
                content = f"[{kind}] {statement}"

                # S7: 语义去重 — 若已有高度相似的 L3 事实，更新已有条目而非新建重复行
                similar = await self._find_similar_l3(content)
                if similar:
                    existing_id = similar["id"]
                    existing_content = similar.get("content", "")
                    # 保留信息量更丰富的内容（取较长者）
                    merged_content = content if len(content) > len(existing_content) else existing_content
                    new_importance = min(1.0, (similar.get("importance") or 0.7) + 0.05)
                    now_iso = datetime.now(timezone.utc).isoformat()
                    # 幂等性修复：将此 l2_id 和原始 L1 ids 追加到已有行的 provenance_refs，
                    # 使该 L2 在下次 consolidate_l2_to_l3 时被识别为"已处理"，
                    # 防止全部被去重的 L2 行永远重新参与下一轮 Dreaming 循环。
                    existing_refs = json.loads(similar.get("provenance_refs") or "[]")
                    if l2_id not in existing_refs:
                        existing_refs.append(l2_id)
                    for l1_id in l1_ids_from_l2:
                        if l1_id not in existing_refs:
                            existing_refs.append(l1_id)
                    with self.memory._connect() as conn:
                        conn.execute(
                            """UPDATE memories
                               SET content=?, importance=?, last_accessed_at=?, updated_at=?,
                                   provenance_refs=?
                               WHERE id=?""",
                            (merged_content, new_importance, now_iso, now_iso,
                             json.dumps(existing_refs), existing_id),
                        )
                        conn.commit()
                    # 内容变化时同步更新向量索引
                    if merged_content != existing_content:
                        await self.memory._store_embedding(existing_id, merged_content)
                    facts_deduplicated += 1
                    logger.debug(
                        "[Dreaming/S7] 已去重 L3 事实（相似度=%.3f，existing=%s）",
                        similar.get("vector_score", 0.0), existing_id,
                    )
                    continue

                await self.memory.store({
                    "level": "L3",
                    "content": content,
                    "source": "dreaming_l2_to_l3",
                    "session_id": l2_session,
                    "provenance_source": "fact_extraction_l2_l3",
                    # Provenance includes both the L2 source and the original L1
                    # events so lineage can be walked all the way back.
                    "provenance_refs": [l2_id] + l1_ids_from_l2,
                    "importance": 0.55,  # Aligned with DEFAULT_IMPORTANCE_BY_LEVEL["L3"]
                })
                facts_created += 1

        logger.info(
            "[Dreaming] L2→L3: processed %d L2 rows, created %d L3 facts, "
            "%d empty, %d deduplicated",
            len(unprocessed), facts_created, facts_skipped_empty, facts_deduplicated,
        )
        return {
            "l2_processed": len(unprocessed),
            "facts_created": facts_created,
            "facts_skipped_empty": facts_skipped_empty,
            "facts_deduplicated": facts_deduplicated,  # S7
        }

    async def _extract_l3_facts(self, l2_content: str) -> List[Dict[str, str]]:
        """Ask the LLM to pull structured facts out of an L2 summary.

        Returns a list of {kind, statement} dicts. Each kind must be in
        L3_FACT_KINDS; the LLM is instructed accordingly and we filter
        defensively in case the model strays. Returns [] on any parse
        failure — caller treats that as "this L2 yielded nothing" and
        moves on, with no provenance written so a retry is possible.
        """
        prompt = (
            "Extract durable semantic facts from this conversation summary. "
            "Output STRICT JSON only, no markdown. Schema:\n"
            '{"facts": [{"kind": "preference|fact|decision|goal|open_question", '
            '"statement": "one concise sentence"}]}\n\n'
            "Rules:\n"
            "- preference: user expressed liking/disliking something durable\n"
            "- fact: stable truth about the user, world, or environment\n"
            "- decision: commitment made (do X, don't do Y)\n"
            "- goal: future-oriented intent\n"
            "- open_question: explicit unresolved question worth tracking\n"
            "- Skip transient context (greetings, weather, mood)\n"
            "- Each statement should be self-contained — readable without the "
            "  original conversation. Use the user's language.\n"
            "- If nothing durable, return {\"facts\": []}\n\n"
            f"Summary:\n{l2_content}"
        )

        response = await self._llm_call(
            [
                {"role": "system", "content": "You are a semantic fact extractor. Output JSON only."},
                {"role": "user", "content": prompt},
            ],
            max_tokens=1024,
        )

        if not response or not response.strip():
            return []

        # Lenient JSON parsing — model might wrap in ``` despite instruction.
        text = response.strip()
        if "```json" in text:
            text = text.split("```json", 1)[1].split("```", 1)[0].strip()
        elif "```" in text:
            text = text.split("```", 1)[1].split("```", 1)[0].strip()

        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            logger.warning("L2→L3 LLM produced invalid JSON; skipping this L2")
            return []

        raw_facts = parsed.get("facts") if isinstance(parsed, dict) else None
        if not isinstance(raw_facts, list):
            return []

        out: List[Dict[str, str]] = []
        for item in raw_facts:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("kind", "")).strip().lower()
            statement = str(item.get("statement", "")).strip()
            if not statement:
                continue
            if kind not in self.L3_FACT_KINDS:
                kind = "fact"  # safe default
            out.append({"kind": kind, "statement": statement})
        return out

    # ========== Phase 3: Deep Sleep (L3 → L4 promotion) ==========
    # The M-Memory-1 design defines L4 as "high-frequency facts promoted from
    # L3 — long-term identity, accessed many times, decay-immune". The new
    # `promote_l3_to_l4` below implements that contract: an L3 fact retrieved
    # ≥5 times with importance ≥0.7 gets a new L4 copy whose provenance_refs
    # points back at the source L3.
    #
    # The OLD `consolidate_l3_to_l4` below generated `skills` table entries
    # from frequently-mentioned entities. That's a different concept (executable
    # skill patterns) and rightfully belongs in evolution_engine. We keep the
    # method alive but rename it to `_legacy_generate_skill_patterns` and
    # remove it from run_cycle(). It can be called manually if someone wants
    # the old behaviour.

    DEFAULT_L4_PROMOTE_ACCESS_THRESHOLD = 5
    DEFAULT_L4_PROMOTE_IMPORTANCE_THRESHOLD = 0.7
    L4_PROMOTE_BATCH = 50

    async def promote_l3_to_l4(
        self,
        access_threshold: Optional[int] = None,
        importance_threshold: Optional[float] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Promote highly-recurring L3 facts to L4 (long-term identity).

        Selection criteria (M-Memory-1):
          - level = 'L3'
          - access_count >= access_threshold (default 5)
          - importance >= importance_threshold (default 0.7)
          - is_current = 1 (skip rows superseded by conflict resolution)
          - NOT already promoted (no existing L4 with this L3 id in its
            provenance_refs)

        Each qualifying L3 row produces ONE new L4 row:
          - content copied verbatim from the L3
          - provenance_source = "promotion_l3_l4"
          - provenance_refs = [source L3 id]
          - importance = 0.9 (L4 baseline)

        The source L3 is NOT superseded — L4 is an elevated copy, the L3
        keeps accumulating access for any future re-promotion decisions
        (we don't re-promote already-promoted ones — guarded above).

        Returns dict with `promoted` count and `evaluated` count.
        """
        access_min = access_threshold if access_threshold is not None else self.DEFAULT_L4_PROMOTE_ACCESS_THRESHOLD
        importance_min = importance_threshold if importance_threshold is not None else self.DEFAULT_L4_PROMOTE_IMPORTANCE_THRESHOLD
        batch = limit if limit is not None else self.L4_PROMOTE_BATCH

        # Step 1: find qualifying L3 rows
        with self.memory._connect() as conn:
            l3_rows = conn.execute(
                """SELECT id, content, session_id, importance, access_count
                   FROM memories
                   WHERE level = 'L3'
                     AND access_count >= ?
                     AND importance >= ?
                     AND (is_current = 1 OR is_current IS NULL)
                     AND archived = 0
                   ORDER BY access_count DESC, importance DESC
                   LIMIT ?""",
                (access_min, importance_min, batch * 3),  # over-fetch for filtering
            ).fetchall()

            # Step 2: filter out already-promoted (L4 rows whose
            # provenance_refs contains the L3 id)
            l4_refs_rows = conn.execute(
                "SELECT provenance_refs FROM memories WHERE level = 'L4'"
            ).fetchall()

        promoted_l3_ids: set = set()
        for r in l4_refs_rows:
            try:
                refs = json.loads(r["provenance_refs"] or "[]")
                promoted_l3_ids.update(refs)
            except (ValueError, TypeError):
                continue

        qualifying = [r for r in l3_rows if r["id"] not in promoted_l3_ids][:batch]

        if not qualifying:
            return {
                "promoted": 0,
                "evaluated": len(l3_rows),
                "message": "No L3 rows meet the promotion criteria",
            }

        promoted = 0
        for l3 in qualifying:
            try:
                await self.memory.store({
                    "level": "L4",
                    "content": l3["content"],
                    "source": "dreaming_promotion",
                    "session_id": l3["session_id"] or "",
                    "provenance_source": "promotion_l3_l4",
                    "provenance_refs": [l3["id"]],
                    "importance": 0.9,
                })
                promoted += 1
            except Exception as e:
                logger.warning(
                    "[Dreaming] L3→L4 promotion failed for %s: %s",
                    l3["id"][:8], e,
                )

        logger.info(
            "[Dreaming] L3→L4: promoted %d of %d qualifying L3 rows (access_min=%d, importance_min=%.2f)",
            promoted, len(qualifying), access_min, importance_min,
        )
        return {
            "promoted": promoted,
            "evaluated": len(l3_rows),
            "qualifying": len(qualifying),
        }

    # ========== S6: 主动洞察检测 (Proactive Intelligence) ==========
    # 在 L2→L3 提取后，分析新增 L3 事实中的行为模式，主动生成洞察通知。
    # 洞察存储在内存缓冲区中，前端可通过 /proactive/insights 轮询获取。
    # 仅在本周期创建了足够多的 L3 事实时才运行，避免无意义 LLM 调用。

    MIN_FACTS_FOR_INSIGHT = 3   # 本轮至少创建这么多 L3 才运行洞察检测
    INSIGHT_LOOK_BACK = 30      # 从最近 N 条 L3 中发现模式

    async def detect_proactive_insights(self, facts_created: int) -> List[Dict[str, Any]]:
        """分析最近 L3 事实，检测行为模式并生成主动洞察通知。

        仅在本周期 facts_created >= MIN_FACTS_FOR_INSIGHT 时运行。
        洞察写入 self._insight_buffer（deque，自动滚动淘汰旧条目）。

        Returns:
            本轮新生成的洞察列表（可为空）。
        """
        if facts_created < self.MIN_FACTS_FOR_INSIGHT:
            return []

        try:
            with self.memory._connect() as conn:
                rows = conn.execute(
                    """SELECT content FROM memories
                       WHERE level = 'L3' AND source = 'dreaming_l2_to_l3'
                         AND (is_current = 1 OR is_current IS NULL)
                         AND archived = 0
                       ORDER BY created_at DESC LIMIT ?""",
                    (self.INSIGHT_LOOK_BACK,),
                ).fetchall()
        except Exception as e:
            logger.warning("[Dreaming] S6 无法读取 L3 事实: %s", e)
            return []

        if not rows:
            return []

        facts_text = "\n".join(f"- {r['content']}" for r in rows)
        prompt = (
            "你是一个洞察分析助手。请从以下用户知识库事实列表中识别 1-2 条真正有价值的洞察或建议，"
            "帮助用户更好地利用 WeBrain 系统。\n\n"
            "仅返回 JSON 数组，格式：\n"
            '[{"title": "洞察标题（≤20字）", "content": "具体说明（≤80字）", '
            '"category": "habit|goal|knowledge|productivity"}]\n\n'
            "规则：\n"
            "- 仅在发现真正有意义的规律时输出，不要强行生成\n"
            "- 不要重复已经显而易见的事实\n"
            "- 如无洞察，返回 []\n\n"
            f"事实列表：\n{facts_text}"
        )

        response = await self._llm_call(
            [
                {"role": "system", "content": "你是一个智能分析助手。只输出 JSON，不要有其他文字。"},
                {"role": "user", "content": prompt},
            ],
            max_tokens=400,
        )

        if not response or not response.strip():
            return []

        # 宽松解析 — 模型可能包裹 ``` 或有前缀文字
        text = response.strip()
        for prefix in ("```json", "```"):
            if prefix in text:
                text = text.split(prefix, 1)[-1].split("```", 1)[0].strip()
                break

        try:
            raw = json.loads(text)
        except json.JSONDecodeError:
            logger.debug("[Dreaming] S6 洞察解析失败: %r", text[:200])
            return []

        if not isinstance(raw, list):
            return []

        new_insights: List[Dict[str, Any]] = []
        now = datetime.now(timezone.utc).isoformat()
        for item in raw:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title", "")).strip()
            content = str(item.get("content", "")).strip()
            category = str(item.get("category", "info")).strip()
            if not title or not content:
                continue
            insight: Dict[str, Any] = {
                "id": str(uuid.uuid4()),
                "title": title,
                "content": content,
                "category": category,
                "type": "info",
                "read": False,
                "createdAt": now,
            }
            self._insight_buffer.append(insight)
            new_insights.append(insight)

        if new_insights:
            logger.info(
                "[Dreaming] S6 主动洞察: 生成 %d 条新洞察", len(new_insights)
            )
        return new_insights

    # ========== Full Cycle ==========
    # Note (Round E1, 2026-05-20): the legacy `consolidate_l3_to_l4` skill-
    # generation method was REMOVED. It pre-dated M-Memory-1's L4 design,
    # wrote to a `skills` table instead of L4 memory rows, AND had a
    # latent bug (used the @contextmanager-decorated `_connect()` without
    # `with`, so every call silently returned 0). Nothing in production
    # called it. The current L3→L4 path is `promote_l3_to_l4` above,
    # which creates real L4 memory rows with provenance.
    async def run_cycle(self, quiet_minutes: Optional[int] = None) -> Dict[str, Any]:
        """Run full dreaming consolidation cycle.

        Args:
            quiet_minutes: optional override of the L1→L2 quiet-window
                threshold. None → use DreamingEngine.QUIET_MINUTES default.
                0 → consolidate ALL L1 sessions immediately (useful for
                smoke tests and forced manual runs).

        Phases:
          - light_sleep: L1 sessions → L2 summaries (consolidate_l1_to_l2)
          - rem_sleep:   L2 summaries → L3 facts (consolidate_l2_to_l3)
          - deep_sleep:  L3 high-frequency → L4 promotion (promote_l3_to_l4)

        Note: the legacy `consolidate_l3_to_l4` skill-generation method
        was removed in Round E1 (it was unreferenced + had a latent
        @contextmanager misuse bug). The deep sleep phase now correctly
        elevates L3 facts to L4 per M-Memory-1 design.
        """
        logger.info("[Dreaming] Starting consolidation cycle...")

        phase1 = await self.consolidate_l1_to_l2(quiet_minutes=quiet_minutes)
        phase2 = await self.consolidate_l2_to_l3()
        phase3 = await self.promote_l3_to_l4()

        # S6: 主动洞察检测 — 在 L3 提取后分析行为模式，生成主动通知
        facts_created = phase2.get("facts_created", 0)
        new_insights = await self.detect_proactive_insights(facts_created)

        result = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "phases": {
                "light_sleep": phase1,
                "rem_sleep": phase2,
                "deep_sleep": phase3,
            },
            "proactive_insights": len(new_insights),
        }

        logger.info(
            "[Dreaming] Cycle complete: L1→L2=%d, L2→L3=%d facts (+%d deduped), "
            "L3→L4=%d promoted, insights=%d",
            phase1.get("consolidated", 0),
            phase2.get("facts_created", 0),
            phase2.get("facts_deduplicated", 0),
            phase3.get("promoted", 0),
            len(new_insights),
        )
        return result
