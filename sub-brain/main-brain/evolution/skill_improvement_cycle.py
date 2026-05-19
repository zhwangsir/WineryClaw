"""
SkillImprovementCycle — periodic self-learning loop.

For each skill that has hit its failure-rate + usage threshold (as reported
by sub-brain's GET /api/skillhub/candidates), this cycle:

  1. asks the SkillReflector for an improved code body
  2. POSTs the improvement back to sub-brain so SkillManager writes a
     versioned fork under ~/.webrain/skills/improved/<id>/v<N>/

Errors on individual candidates are swallowed and reported — one bad skill
does not stop the cycle.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from evolution.skill_reflector import SkillReflector

logger = logging.getLogger("webrain.evolution.cycle")


@dataclass
class CycleReport:
    checked: int = 0
    improved: int = 0
    skipped: int = 0
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "checked": self.checked,
            "improved": self.improved,
            "skipped": self.skipped,
            "errors": list(self.errors),
        }


class SkillImprovementCycle:
    """Orchestrates one full pass of: read candidates → reflect → POST forks."""

    def __init__(
        self,
        reflector: SkillReflector,
        sub_brain_url: Optional[str] = None,
        timeout_s: float = 60.0,
    ):
        self.reflector = reflector
        self.sub_brain_url = (
            sub_brain_url
            or os.environ.get("WEBRAIN_SUB_BRAIN_URL")
            or "http://localhost:3000"
        ).rstrip("/")
        self.timeout_s = timeout_s

    async def run_once(self) -> CycleReport:
        report = CycleReport()
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                candidates = await self._fetch_candidates(client)
                report.checked = len(candidates)

                for cand in candidates:
                    skill = (cand or {}).get("skill") or {}
                    skill_id = skill.get("id") or "<unknown>"
                    try:
                        reflection = await self.reflector.reflect_on_skill(skill)
                        if reflection is None:
                            report.skipped += 1
                            continue
                        ok = await self._post_improvement(client, skill_id, reflection)
                        if ok:
                            report.improved += 1
                        else:
                            report.errors.append(f"{skill_id}: improve endpoint returned ok=false")
                    except Exception as e:  # don't let one bad skill kill the cycle
                        logger.warning("skill cycle: %s failed: %s", skill_id, e)
                        report.errors.append(f"{skill_id}: {e}")
        except Exception as e:
            logger.error("skill cycle: candidates fetch failed: %s", e)
            report.errors.append(f"<candidates>: {e}")

        logger.info(
            "skill cycle done: checked=%d improved=%d skipped=%d errors=%d",
            report.checked, report.improved, report.skipped, len(report.errors),
        )
        return report

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _fetch_candidates(self, client: httpx.AsyncClient) -> List[Dict[str, Any]]:
        url = f"{self.sub_brain_url}/api/skillhub/candidates"
        resp = await client.get(url)
        resp.raise_for_status()
        data = resp.json() or {}
        return list(data.get("candidates") or [])

    async def _post_improvement(
        self,
        client: httpx.AsyncClient,
        skill_id: str,
        reflection: Any,
    ) -> bool:
        url = f"{self.sub_brain_url}/api/skillhub/improve"
        payload = {
            "skillId": skill_id,
            "code": reflection.improved_code,
            "reason": reflection.reason,
        }
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        body = resp.json() or {}
        return bool(body.get("ok"))
