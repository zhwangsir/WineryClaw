"""
OpenAI-compatible chat completion factory.

Builds a callable that matches the LLMCall protocol used by SkillReflector
and friends, sourcing endpoint config from (priority order):

1. The `llm_config` dict passed in (canonical — produced by sub-brain's
   _fetch_llm_config and shared across MemoryManager / ReasoningEngine / etc.)
2. Environment variables (WEBRAIN_LLM_BASE_URL, WEBRAIN_LLM_MODEL,
   WEBRAIN_LLM_API_KEY) — useful when running scripts outside the main app.
3. Hard-coded localhost fallback (will fail loudly if neither is configured).

Works with LM Studio, vLLM, Ollama, llama.cpp server, or any OpenAI-compatible
endpoint exposing `/chat/completions`.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Awaitable, Callable, Dict, List, Optional

import httpx

logger = logging.getLogger("webrain.evolution.llm_client")


LLMCall = Callable[..., Awaitable[str]]


def make_llm_call_from_config(
    llm_config: Optional[Dict[str, Any]] = None,
    *,
    timeout_s: float = 120.0,
    default_temperature: float = 0.3,
) -> LLMCall:
    """Return an async callable that POSTs to <base>/chat/completions.

    The returned callable signature matches LLMCall:
        async def(messages, *, temperature=None, max_tokens=4096, **_) -> str

    Configuration lookup precedence:
      llm_config.base_url > WEBRAIN_LLM_BASE_URL > http://localhost:1234/v1
      llm_config.model_id / .model > WEBRAIN_LLM_MODEL > "default"
      llm_config.api_key > WEBRAIN_LLM_API_KEY > (omit Authorization header)
    """
    cfg = llm_config or {}

    base_url = (
        cfg.get("base_url")
        or os.environ.get("WEBRAIN_LLM_BASE_URL")
        or "http://localhost:1234/v1"
    ).rstrip("/")

    model_id = (
        cfg.get("model_id")
        or cfg.get("model")
        or os.environ.get("WEBRAIN_LLM_MODEL")
        or "default"
    )

    api_key = cfg.get("api_key") or os.environ.get("WEBRAIN_LLM_API_KEY")
    cfg_temperature = cfg.get("temperature", default_temperature)

    url = f"{base_url}/chat/completions"

    async def call(
        messages: List[Dict[str, str]],
        *,
        temperature: Optional[float] = None,
        max_tokens: int = 4096,
        **_: Any,
    ) -> str:
        payload: Dict[str, Any] = {
            "model": model_id,
            "messages": messages,
            "temperature": temperature if temperature is not None else cfg_temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as e:
            logger.warning(
                "llm_client: unexpected response shape from %s: %s", url, e
            )
            return ""

    return call
