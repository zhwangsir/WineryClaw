"""Task decomposition planner.

The Planner takes a user's natural-language request and returns either:
  - None, if the request is trivial enough to answer in one shot, or
  - A structured Plan with N atomic subtasks the assistant intends to
    work through, plus a one-line rationale.

Design tenets (M2 scope):
  - **Fail open**: any LLM error or schema mismatch returns None — chat
    continues unaltered. The planner is an enrichment layer, never a
    blocker.
  - **Cheap pre-filter**: trivial requests skip the LLM call entirely
    via `is_complex()`. Saves a model round-trip for "hi" / "thanks" /
    "what time is it" style asks.
  - **No execution**: the planner only *names* the steps. Running them,
    verifying outputs, and retrying on failure is M3+ work.

Public surface:
  Planner(llm_config).plan(user_input) -> Optional[Plan]
  Planner(llm_config).is_complex(user_input) -> bool
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("webrain.planner")

# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------

# Cap N to keep prompts readable and avoid runaway LLM output. The LLM is
# instructed to stay under this; we also truncate defensively after parse.
MAX_TASKS_PER_PLAN = 8

# Cheap heuristic markers — presence of any of these in a >= MIN_COMPLEX_LEN
# request flips it from trivial to "worth planning". Bilingual on purpose:
# users mix zh/en regularly.
_COMPLEX_MARKERS_RE = re.compile(
    r"(然后|接着|再(去|来)?|之后|完成后|并且|和|以及|还要|首先|其次|最后|"
    r"step\s*by\s*step|first[, ]|then[, ]|after\s+that|finally|"
    r"plan\s+to|break\s+down|逐步|分步)",
    re.IGNORECASE,
)

# Below this length, even with markers, we don't plan — too little signal.
MIN_COMPLEX_LEN = 30
# Above this length, plan regardless of markers — long requests usually
# benefit from explicit decomposition.
LONG_REQUEST_LEN = 120


@dataclass(frozen=True)
class PlanTask:
    """One atomic step the assistant intends to perform."""

    id: str
    description: str
    requires_tool: bool = False
    tool_hint: str = ""
    expected_output: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Plan:
    """Structured plan returned to chat callers and the frontend."""

    plan_id: str
    user_input: str
    tasks: List[PlanTask] = field(default_factory=list)
    confidence: float = 0.0
    reasoning: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "user_input": self.user_input,
            "tasks": [t.to_dict() for t in self.tasks],
            "confidence": self.confidence,
            "reasoning": self.reasoning,
        }


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------


class Planner:
    """LLM-backed task decomposer with cheap pre-filter and fail-open errors."""

    def __init__(self, llm_config: Optional[Dict[str, Any]] = None):
        # llm_config matches what ChatEngine/ReasoningEngine accept: either
        # a flat {base_url, model_id, api_key} or a multi-endpoint config
        # with an `endpoints` list (first entry is used here for simplicity).
        self.llm_config = llm_config or {}

    # -- pre-filter ---------------------------------------------------------

    def is_complex(self, user_input: str) -> bool:
        """Heuristic: should we bother planning this request?

        Returns True for multi-step asks, long-form asks, or asks with
        explicit decomposition cues. Designed to be conservative — when
        in doubt, do *not* plan (an extra LLM call has cost).
        """
        if not user_input or not user_input.strip():
            return False
        s = user_input.strip()
        if len(s) < MIN_COMPLEX_LEN:
            return False
        if len(s) >= LONG_REQUEST_LEN:
            return True
        if _COMPLEX_MARKERS_RE.search(s):
            return True
        # Multiple distinct questions in one breath
        if (s.count("?") + s.count("？")) >= 2:
            return True
        return False

    # -- LLM client ---------------------------------------------------------

    def _resolve_endpoint(self) -> Dict[str, Any]:
        """Pick the highest-priority endpoint from llm_config."""
        endpoints = self.llm_config.get("endpoints")
        if isinstance(endpoints, list) and endpoints:
            # Sort by priority descending — same convention as LLMRouter.
            best = sorted(endpoints, key=lambda e: -e.get("priority", 0))[0]
            return {
                "base_url": best.get("base_url") or best.get("baseUrl", ""),
                "model_id": best.get("model_id") or best.get("modelId", ""),
                "api_key": best.get("api_key") or best.get("apiKey"),
            }
        return {
            "base_url": self.llm_config.get("base_url") or self.llm_config.get("baseUrl", ""),
            "model_id": self.llm_config.get("model_id") or self.llm_config.get("modelId", ""),
            "api_key": self.llm_config.get("api_key") or self.llm_config.get("apiKey"),
        }

    async def _call_llm(self, messages: List[Dict[str, str]], max_tokens: int = 1024) -> str:
        ep = self._resolve_endpoint()
        base_url = ep["base_url"].rstrip("/")
        if not base_url or not ep["model_id"]:
            raise RuntimeError("planner: no LLM endpoint configured")

        url = f"{base_url}/chat/completions"
        payload = {
            "model": ep["model_id"],
            "messages": messages,
            "temperature": 0.2,  # planning is deterministic-ish work
            "max_tokens": max_tokens,
        }
        headers = {"Content-Type": "application/json"}
        if ep.get("api_key"):
            headers["Authorization"] = f"Bearer {ep['api_key']}"

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
        return data["choices"][0]["message"]["content"]

    # -- core API -----------------------------------------------------------

    async def plan(self, user_input: str, context: Optional[Dict[str, Any]] = None) -> Optional[Plan]:
        """Decompose `user_input` into a structured plan.

        Returns None if:
          - the request is too trivial to plan (per is_complex), OR
          - the LLM call/parse fails (fail-open).

        Never raises into the chat flow.
        """
        if not self.is_complex(user_input):
            return None

        system = (
            "你是一个任务规划助手。把用户请求拆成 2 到 "
            f"{MAX_TASKS_PER_PLAN} 个最小的、可验证的子任务。"
            "每个子任务要明确「做什么」「需要工具吗」「期望产出」。"
            "保持中立——只规划,不要执行,不要给最终答案。"
        )

        user_msg = (
            f"用户请求:\n{user_input}\n\n"
            "请严格按下面 JSON schema 输出,只输出 JSON,不要其他说明:\n"
            "{\n"
            '  "tasks": [\n'
            '    {"description": "...", "requires_tool": false, "tool_hint": "", "expected_output": "..."},\n'
            "    ...\n"
            "  ],\n"
            '  "confidence": 0.0,\n'
            '  "reasoning": "一句话说明为什么这样拆"\n'
            "}"
        )

        try:
            raw = await self._call_llm(
                [{"role": "system", "content": system}, {"role": "user", "content": user_msg}]
            )
        except Exception as e:  # pragma: no cover — covered via injected fake LLM
            logger.warning("planner LLM call failed, skipping plan: %s", e)
            return None

        parsed = _extract_json(raw)
        if not parsed or not isinstance(parsed, dict):
            logger.warning("planner produced non-JSON output, skipping plan")
            return None

        tasks_raw = parsed.get("tasks") or []
        if not isinstance(tasks_raw, list) or not tasks_raw:
            return None

        tasks: List[PlanTask] = []
        for i, t in enumerate(tasks_raw[:MAX_TASKS_PER_PLAN], start=1):
            if not isinstance(t, dict):
                continue
            desc = str(t.get("description", "")).strip()
            if not desc:
                continue
            tasks.append(
                PlanTask(
                    id=f"task-{i}",
                    description=desc,
                    requires_tool=bool(t.get("requires_tool", False)),
                    tool_hint=str(t.get("tool_hint", "")).strip(),
                    expected_output=str(t.get("expected_output", "")).strip(),
                )
            )

        if not tasks:
            return None

        try:
            confidence = float(parsed.get("confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5
        confidence = max(0.0, min(1.0, confidence))

        return Plan(
            plan_id=f"plan-{uuid.uuid4().hex[:8]}",
            user_input=user_input,
            tasks=tasks,
            confidence=confidence,
            reasoning=str(parsed.get("reasoning", "")).strip(),
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def plan_from_dict(data: Dict[str, Any]) -> Optional[Plan]:
    """Rebuild a Plan dataclass from a JSON-shape dict.

    Accepts the wire format produced by `Plan.to_dict()` and emitted to the
    frontend by `/chat`. Used by `/plan/execute` to re-run a plan a client
    already received (e.g. user clicked "execute" in the UI).

    Returns None if the dict has no usable tasks — we'd rather fail loud
    than fabricate a single-task placeholder.
    """
    if not isinstance(data, dict):
        return None
    tasks_raw = data.get("tasks") or []
    if not isinstance(tasks_raw, list) or not tasks_raw:
        return None

    tasks: List[PlanTask] = []
    for i, t in enumerate(tasks_raw, start=1):
        if not isinstance(t, dict):
            continue
        desc = str(t.get("description", "")).strip()
        if not desc:
            continue
        tasks.append(
            PlanTask(
                id=str(t.get("id") or f"task-{i}"),
                description=desc,
                requires_tool=bool(t.get("requires_tool", False)),
                tool_hint=str(t.get("tool_hint", "")).strip(),
                expected_output=str(t.get("expected_output", "")).strip(),
            )
        )
    if not tasks:
        return None

    try:
        confidence = float(data.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))

    return Plan(
        plan_id=str(data.get("plan_id") or "plan-adhoc"),
        user_input=str(data.get("user_input") or ""),
        tasks=tasks,
        confidence=confidence,
        reasoning=str(data.get("reasoning", "")).strip(),
    )


def _extract_json(text: str) -> Optional[Any]:
    """Best-effort JSON extraction from an LLM response.

    Handles bare JSON, ```json fenced blocks, and unfenced ``` blocks.
    Returns None if nothing parseable is found.
    """
    if not text:
        return None
    candidates: List[str] = []

    # ```json ... ``` fenced
    fenced = re.search(r"```json\s*(.+?)\s*```", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        candidates.append(fenced.group(1))

    # ``` ... ``` fenced without lang
    plain_fenced = re.findall(r"```\s*(.+?)\s*```", text, re.DOTALL)
    candidates.extend(plain_fenced)

    # Whole text
    candidates.append(text.strip())

    # First {...} blob in text
    first_obj = re.search(r"\{[\s\S]*\}", text)
    if first_obj:
        candidates.append(first_obj.group(0))

    for c in candidates:
        try:
            return json.loads(c)
        except Exception:
            continue
    return None
