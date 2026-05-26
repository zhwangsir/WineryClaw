"""Profile builder — extracts UserProfile from conversation history via LLM."""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

from .user_profile import UserProfile

logger = logging.getLogger("webrain.user_modeling")


class ProfileBuilder:
    """Build a UserProfile by asking an LLM to analyse recent conversations."""

    def __init__(
        self,
        llm_config: Optional[Dict[str, Any]] = None,
        memory_manager: Optional[Any] = None,
    ):
        self.llm_config = llm_config or {}
        self.memory = memory_manager

    async def build_profile(self, conversations: Optional[List[dict]] = None) -> Optional[UserProfile]:
        """Build profile from provided conversations or extract them automatically.

        Returns None on any failure (fail-open).
        """
        if conversations is None:
            conversations = await self._extract_recent_conversations()

        if not conversations:
            logger.info("ProfileBuilder: no conversations available, skipping profile build")
            return None

        # De-sensitise: only keep role + content (strip metadata)
        sanitized = [
            {"role": c.get("role", "user"), "content": c.get("content", "")}
            for c in conversations
            if c.get("content", "").strip()
        ]

        prompt_messages = [
            {
                "role": "system",
                "content": (
                    "You are a user-profile extractor. Analyse the conversation history below "
                    "and output a JSON object matching this schema:\n"
                    "{\n"
                    '  "name": "string (name the user calls themselves, or empty)",\n'
                    '  "interests": ["list of interest areas"],\n'
                    '  "communication_style": "string (e.g. concise, detailed, technical, casual)",\n'
                    '  "expertise_areas": ["list of professional/domain expertise"],\n'
                    '  "preferred_tools": ["list of tools/frameworks/languages the user mentions using"],\n'
                    '  "timezone": "string or null"\n'
                    "}\n"
                    "Rules:\n"
                    "- Output ONLY valid JSON, no markdown fences, no commentary.\n"
                    "- Use empty strings / empty lists when information is absent.\n"
                    "- Infer timezone only if explicitly mentioned (city, UTC offset, etc.)."
                ),
            },
            {
                "role": "user",
                "content": "Conversation history:\n"
                + json.dumps(sanitized[:200], ensure_ascii=False, indent=2),
            },
        ]

        try:
            raw = await self._call_llm(prompt_messages)
            if not raw or not raw.strip():
                logger.warning("ProfileBuilder: LLM returned empty response")
                return None

            # Strip possible markdown fences
            text = raw.strip()
            if text.startswith("```"):
                lines = text.splitlines()
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].startswith("```"):
                    lines = lines[:-1]
                text = "\n".join(lines).strip()

            data = json.loads(text)
            if not isinstance(data, dict):
                logger.warning("ProfileBuilder: LLM returned non-dict JSON")
                return None

            now = datetime.now(timezone.utc).isoformat()
            profile = UserProfile(
                name=data.get("name", ""),
                interests=data.get("interests", []),
                communication_style=data.get("communication_style", ""),
                expertise_areas=data.get("expertise_areas", []),
                preferred_tools=data.get("preferred_tools", []),
                timezone=data.get("timezone"),
                created_at=now,
                updated_at=now,
            )
            logger.info("ProfileBuilder: profile built successfully")
            return profile
        except json.JSONDecodeError as e:
            logger.warning("ProfileBuilder: failed to parse LLM response as JSON: %s", e)
            return None
        except Exception as e:
            logger.warning("ProfileBuilder: unexpected error: %s", e)
            return None

    async def _extract_recent_conversations(self, limit: int = 100) -> List[dict]:
        """Fetch recent L1 memories and keep only user messages.

        Falls back to empty list when memory manager is unavailable.
        """
        if self.memory is None:
            return []
        try:
            rows = await self.memory.get_recent(level="L1", limit=limit)
        except Exception as e:
            logger.debug("ProfileBuilder: failed to fetch recent memories: %s", e)
            return []

        conversations: List[dict] = []
        for row in rows:
            content = row.get("content", "")
            source = row.get("source", "")
            # Skip system messages and assistant-only messages
            if source == "system":
                continue
            # Assistant messages in this codebase are stored as "Assistant: ..."
            if isinstance(content, str) and content.startswith("Assistant:"):
                # We actually keep assistant messages too so the LLM gets full context,
                # but mark them as assistant role.
                conversations.append({
                    "role": "assistant",
                    "content": content[len("Assistant:"):].strip(),
                })
                continue
            # Treat everything else as user
            conversations.append({
                "role": "user",
                "content": content,
            })

        # Reverse so oldest-first (better for LLM understanding)
        conversations.reverse()
        return conversations

    async def _call_llm(self, messages: List[Dict[str, str]]) -> str:
        """Call the configured LLM endpoint."""
        cfg = self.llm_config
        endpoints = cfg.get("endpoints")
        if isinstance(endpoints, list) and len(endpoints) > 0:
            ep = sorted(endpoints, key=lambda e: -(e.get("priority", 0)))[0]
            base_url = (ep.get("base_url") or ep.get("baseUrl", "")).rstrip("/")
            model_id = ep.get("model_id") or ep.get("modelId", "default")
            api_key = ep.get("api_key") or ep.get("apiKey")
        else:
            base_url = cfg.get("base_url", "http://localhost:1234/v1").rstrip("/")
            model_id = cfg.get("model_id", "default")
            api_key = cfg.get("api_key")

        url = f"{base_url}/chat/completions"
        payload = {
            "model": model_id,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 1024,
            "stream": False,
        }
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            return ""
