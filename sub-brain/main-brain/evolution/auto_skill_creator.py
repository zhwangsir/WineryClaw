"""Auto skill creator — generates skill drafts from novel successful tasks."""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx

from planner.planner import Plan
from planner.executor import ExecutionResult

logger = logging.getLogger("webrain.evolution.auto_skill")

# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SkillDraft:
    id: str
    name: str
    description: str
    triggerPatterns: List[str]
    code: str
    language: str
    tags: List[str]


# ---------------------------------------------------------------------------
# AutoSkillCreator
# ---------------------------------------------------------------------------


class AutoSkillCreator:
    def __init__(
        self,
        llm_config: Optional[Dict[str, Any]] = None,
        sub_brain_url: str = "http://127.0.0.1:3456",
    ):
        self.llm_config = llm_config or {}
        self.sub_brain_url = sub_brain_url.rstrip("/")
        self._http_client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=30.0)
        return self._http_client

    # -- LLM client ---------------------------------------------------------

    def _resolve_endpoint(self) -> Dict[str, Any]:
        endpoints = self.llm_config.get("endpoints")
        if isinstance(endpoints, list) and endpoints:
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
            raise RuntimeError("auto_skill_creator: no LLM endpoint configured")

        url = f"{base_url}/chat/completions"
        payload = {
            "model": ep["model_id"],
            "messages": messages,
            "temperature": 0.3,
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

    # -- skill fetching -----------------------------------------------------

    async def _fetch_skills(self) -> List[Dict[str, Any]]:
        try:
            client = self._get_client()
            resp = await client.get(f"{self.sub_brain_url}/skills")
            if resp.status_code == 200:
                data = resp.json()
                return data.get("skills", []) or []
        except Exception as e:
            logger.warning("auto_skill_creator: failed to fetch skills: %s", e)
        return []

    # -- core API -----------------------------------------------------------

    async def should_create_skill(self, user_input: str, plan: Plan) -> bool:
        """Check if this user_input + plan represents a novel task worth
        capturing as a skill.
        """
        if not user_input or not user_input.strip():
            return False

        skills = await self._fetch_skills()
        if not skills:
            # No skills at all — any non-trivial plan is novel.
            return bool(plan.tasks)

        # 1) Does any existing skill triggerPattern match user_input?
        input_lower = user_input.lower()
        for skill in skills:
            for pattern in skill.get("triggerPatterns", []):
                if pattern and pattern.lower() in input_lower:
                    return False

        # 2) Does the plan introduce tool patterns not seen in existing skills?
        plan_tools = {
            t.tool_hint.lower()
            for t in plan.tasks
            if t.requires_tool and t.tool_hint
        }
        if not plan_tools:
            # No tools involved — probably not worth a skill.
            return False

        # Gather tool mentions from existing skill code (very coarse).
        existing_tools: set = set()
        for skill in skills:
            code = skill.get("code", "").lower()
            for tool in list(plan_tools):
                if tool in code:
                    existing_tools.add(tool)

        novel_tools = plan_tools - existing_tools
        # If at least one tool in the plan is not obviously present in any
        # existing skill code, consider this novel.
        return bool(novel_tools)

    async def create_skill_draft(
        self,
        user_input: str,
        plan: Plan,
        execution_result: ExecutionResult,
    ) -> Optional[SkillDraft]:
        """Ask an LLM to synthesise a skill from a successful task run."""
        system = (
            "你是一个 WeBrain 技能生成助手。根据用户请求、执行计划以及成功执行的结果，"
            "生成一个可复用的 skill（JavaScript 代码）。"
            "Skill 用于封装一个常见任务模式，使系统未来遇到类似请求时可以直接调用。"
        )

        user_msg = (
            f"用户原始请求:\n{user_input}\n\n"
            f"执行计划:\n{json.dumps(plan.to_dict(), ensure_ascii=False, indent=2)}\n\n"
            f"执行结果 (overall_success={execution_result.overall_success}):\n"
            f"{json.dumps(execution_result.to_dict(), ensure_ascii=False, indent=2)}\n\n"
            "请严格按下面 JSON schema 输出，只输出 JSON，不要其他说明:\n"
            "{\n"
            '  "name": "Skill 名称",\n'
            '  "description": "一句话描述这个 skill 做什么",\n'
            '  "triggerPatterns": ["关键词1", "关键词2"],\n'
            '  "code": "完整的 JavaScript 代码字符串",\n'
            '  "language": "javascript",\n'
            '  "tags": ["tag1", "tag2"]\n'
            "}"
        )

        try:
            raw = await self._call_llm(
                [{"role": "system", "content": system}, {"role": "user", "content": user_msg}],
                max_tokens=2048,
            )
        except Exception as e:
            logger.warning("auto_skill_creator: LLM call failed: %s", e)
            return None

        parsed = _extract_json(raw)
        if not parsed or not isinstance(parsed, dict):
            logger.warning("auto_skill_creator: LLM produced non-JSON output")
            return None

        name = str(parsed.get("name", "")).strip()
        code = str(parsed.get("code", "")).strip()
        if not name or not code:
            logger.warning("auto_skill_creator: LLM produced empty name or code")
            return None

        trigger_patterns = parsed.get("triggerPatterns")
        if not isinstance(trigger_patterns, list):
            trigger_patterns = []
        trigger_patterns = [str(p).strip() for p in trigger_patterns if str(p).strip()]

        tags = parsed.get("tags")
        if not isinstance(tags, list):
            tags = []
        tags = [str(t).strip() for t in tags if str(t).strip()]

        return SkillDraft(
            id=f"skill-draft-{uuid.uuid4().hex[:8]}",
            name=name,
            description=str(parsed.get("description", "")).strip(),
            triggerPatterns=trigger_patterns,
            code=code,
            language="javascript",
            tags=tags,
        )

    async def submit_draft(self, draft: SkillDraft) -> Dict[str, Any]:
        """POST a draft skill to the sub-brain skillhub."""
        payload = {
            "name": draft.name,
            "description": draft.description,
            "code": draft.code,
            "language": draft.language,
            "triggerPatterns": draft.triggerPatterns,
            "tags": draft.tags,
            "reason": f"Auto-created from plan {draft.id}",
        }
        try:
            client = self._get_client()
            resp = await client.post(
                f"{self.sub_brain_url}/api/skillhub/drafts",
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("ok"):
                return {"ok": True, "skill_id": data.get("skill", {}).get("id", draft.id)}
            return {"ok": False, "skill_id": draft.id, "error": data.get("error", "unknown")}
        except Exception as e:
            logger.warning("auto_skill_creator: submit_draft failed: %s", e)
            return {"ok": False, "skill_id": draft.id, "error": str(e)}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_json(text: str) -> Optional[Any]:
    """Best-effort JSON extraction from an LLM response."""
    if not text:
        return None
    candidates: List[str] = []

    fenced = re.search(r"```json\s*(.+?)\s*```", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        candidates.append(fenced.group(1))

    plain_fenced = re.findall(r"```\s*(.+?)\s*```", text, re.DOTALL)
    candidates.extend(plain_fenced)

    candidates.append(text.strip())

    first_obj = re.search(r"\{[\s\S]*\}", text)
    if first_obj:
        candidates.append(first_obj.group(0))

    for c in candidates:
        try:
            return json.loads(c)
        except Exception:
            continue
    return None
