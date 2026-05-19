"""
Skill Reflector — generate improved skill code from accumulated failure telemetry.

Consumes the candidate records produced by sub-brain's
SkillManager.getCandidatesForImprovement() (one record per skill that has hit
its failure-rate threshold and is out of cooldown), and asks the configured
LLM to propose a revised implementation.

Designed to be transport-agnostic and testable: the LLM call is injected via
constructor (callable returning a Coroutine[..., str]). Production wiring
points it at the project's local LLM gateway; tests pass a fake that returns
canned strings.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional

logger = logging.getLogger("webrain.reflection.skill")


# Type alias for the LLM completion callable: takes messages + kwargs,
# returns the assistant content string.
LLMCall = Callable[..., Awaitable[str]]


@dataclass(frozen=True)
class Reflection:
    improved_code: str
    reason: str


SYSTEM_PROMPT = (
    "You are a code reviewer fixing a recurring failure in an agent skill.\n"
    "You will receive: the skill's current code, its language, and a list of\n"
    "observed failure modes (each with an error signature, an occurrence count,\n"
    "and up to 3 raw example messages).\n\n"
    "Respond with STRICT JSON on a single line, with two keys:\n"
    '  {"improved_code": "<the full revised skill body>",\n'
    '   "reason": "<one sentence describing what you changed and why>"}\n\n'
    "Constraints:\n"
    "- Output the entire new skill body, not a diff.\n"
    "- Keep the same `params` contract the caller already uses.\n"
    "- If you cannot meaningfully improve the code, return:\n"
    '    {"improved_code": "", "reason": "no improvement"}\n'
)


class SkillReflector:
    """Turn a failing-skill record into a proposed code improvement."""

    def __init__(self, llm_call: LLMCall, max_examples_per_mode: int = 3):
        self.llm_call = llm_call
        self.max_examples_per_mode = max_examples_per_mode

    async def reflect_on_skill(self, skill: Dict[str, Any]) -> Optional[Reflection]:
        """Returns Reflection on success, None when no useful improvement was produced.

        Inputs `skill` is the dict shape produced by sub-brain's SkillManager
        (id, name, language, code, usageCount, successRate, failureModes[]).
        """
        if not skill.get("code"):
            logger.warning("skill_reflector: skill %s has no code; skipping", skill.get("id"))
            return None

        failure_modes = skill.get("failureModes") or []
        if not failure_modes:
            logger.info("skill_reflector: skill %s has no failureModes; skipping", skill.get("id"))
            return None

        user_prompt = self._build_user_prompt(skill, failure_modes)

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]

        try:
            raw = await self.llm_call(messages)
        except Exception as e:  # pragma: no cover — caller-owned errors
            logger.warning("skill_reflector: llm_call failed for %s: %s", skill.get("id"), e)
            return None

        parsed = self._parse_response(raw)
        if parsed is None:
            return None

        improved = parsed.get("improved_code", "").strip()
        reason = (parsed.get("reason") or "").strip()
        # Reject no-ops and degenerate outputs.
        if not improved or improved == skill["code"].strip():
            logger.info(
                "skill_reflector: %s — LLM returned no meaningful change", skill.get("id")
            )
            return None

        return Reflection(improved_code=improved, reason=reason or "LLM proposed refinement")

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _build_user_prompt(self, skill: Dict[str, Any], failure_modes: List[Dict[str, Any]]) -> str:
        # Sort modes by count desc; cap examples per mode.
        sorted_modes = sorted(failure_modes, key=lambda m: m.get("count", 0), reverse=True)

        lines: List[str] = []
        lines.append(f"Skill id: {skill.get('id')}")
        lines.append(f"Skill name: {skill.get('name', '<unnamed>')}")
        lines.append(f"Language: {skill.get('language', 'unknown')}")
        usage = skill.get("usageCount", 0)
        success = skill.get("successRate", 0.0)
        lines.append(f"Telemetry: {usage} invocations, successRate={success:.2f}")
        lines.append("")
        lines.append("Current code:")
        lines.append("```")
        lines.append(skill["code"])
        lines.append("```")
        lines.append("")
        lines.append("Observed failure modes (highest count first):")
        for mode in sorted_modes:
            sig = mode.get("signature", "<unknown>")
            count = mode.get("count", 0)
            lines.append(f"- [{count}x] {sig}")
            examples = (mode.get("examples") or [])[: self.max_examples_per_mode]
            for ex in examples:
                lines.append(f"    e.g. {str(ex)[:400]}")
        lines.append("")
        lines.append(
            "Propose an improved skill body that addresses the top failure mode "
            "without breaking the current params contract."
        )
        return "\n".join(lines)

    def _parse_response(self, raw: str) -> Optional[Dict[str, Any]]:
        """Locate the first JSON object in the LLM response and parse it.

        Permissive: handles fenced ```json blocks or trailing prose.
        """
        if not raw:
            return None

        text = raw.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

        try:
            obj = json.loads(text)
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            pass

        first = text.find("{")
        if first < 0:
            return None
        depth = 0
        for i in range(first, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    candidate = text[first : i + 1]
                    try:
                        obj = json.loads(candidate)
                        return obj if isinstance(obj, dict) else None
                    except json.JSONDecodeError:
                        return None
        return None
