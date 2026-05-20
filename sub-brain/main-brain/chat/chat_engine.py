"""
Chat Engine — Streaming + Multi-turn Tool Calling + Multi-model Endpoint Support
"""

import asyncio
import json
import logging
import os
import time
from typing import Any, AsyncGenerator, Dict, Iterator, List, Optional, Tuple

import httpx

logger = logging.getLogger("webrain.chat")

# ---------------------------------------------------------------------------
# LLM Endpoint Router — manages multiple backends with health-check & failover
# ---------------------------------------------------------------------------

class LLMEndpoint:
    """A single LLM backend endpoint with per-call stats tracking.

    Mutated by `LLMRouter.mark_success` / `mark_failure` during real
    traffic. `health_check()` is a low-cost out-of-band probe used by the
    background monitor; in-band failures take precedence over it.
    """

    def __init__(self, name: str, base_url: str, model_id: str, api_key: Optional[str] = None,
                 priority: int = 0, timeout: float = 120.0, provider: str = "openai"):
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.model_id = model_id
        self.api_key = api_key
        self.priority = priority
        self.timeout = timeout
        self.provider = provider  # "openai" | "anthropic" | "google" | "deepseek"
        # Health flag is mutated by both in-band traffic and the background
        # monitor. In-band wins — a successful real call should re-mark
        # healthy immediately, not wait for the next probe tick.
        self.healthy: bool = True
        self.last_error: Optional[str] = None
        self.latency_ms: float = 0.0  # most-recent latency (success only)
        # Rolling counters across the process lifetime. Reset only on
        # restart — this is router-internal telemetry, not user-facing
        # billing.
        self.success_count: int = 0
        self.failure_count: int = 0
        self._total_latency_ms: float = 0.0  # sum across successes
        self.last_success_at: Optional[float] = None  # epoch seconds
        self.last_failure_at: Optional[float] = None
        self.unhealthy_since: Optional[float] = None  # set on first failure after a healthy stretch

    @property
    def avg_latency_ms(self) -> float:
        if self.success_count <= 0:
            return 0.0
        return self._total_latency_ms / self.success_count

    def record_success(self, latency_ms: float) -> None:
        self.success_count += 1
        self._total_latency_ms += latency_ms
        self.latency_ms = latency_ms
        self.last_success_at = time.time()
        self.last_error = None
        self.healthy = True
        self.unhealthy_since = None

    def record_failure(self, error: str) -> None:
        self.failure_count += 1
        self.last_error = error
        self.last_failure_at = time.time()
        if self.healthy:
            self.unhealthy_since = self.last_failure_at
        self.healthy = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "base_url": self.base_url,
            "model_id": self.model_id,
            "provider": self.provider,
            "priority": self.priority,
            "healthy": self.healthy,
            "success_count": self.success_count,
            "failure_count": self.failure_count,
            "avg_latency_ms": round(self.avg_latency_ms, 1),
            "last_latency_ms": round(self.latency_ms, 1),
            "last_success_at": self.last_success_at,
            "last_failure_at": self.last_failure_at,
            "last_error": self.last_error,
            "unhealthy_since": self.unhealthy_since,
        }

    async def health_check(self) -> bool:
        """Ping /models or /v1/models to verify availability.

        Out-of-band probe used by the background monitor. A successful
        probe re-marks the endpoint healthy (recovers from a prior
        in-band failure); a failed probe marks it unhealthy *only if*
        no successful in-band call has happened since the probe started.
        """
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                urls_to_try = [
                    f"{self.base_url}/models",
                    f"{self.base_url}/v1/models",
                ]
                for url in urls_to_try:
                    try:
                        resp = await client.get(url)
                        if resp.status_code == 200:
                            # Probe success — clear unhealthy state. Do NOT touch
                            # success_count (this isn't real traffic).
                            self.healthy = True
                            self.last_error = None
                            self.unhealthy_since = None
                            return True
                    except Exception:
                        continue
                # No probe URL succeeded
                self.healthy = False
                if self.unhealthy_since is None:
                    self.unhealthy_since = time.time()
                return False
        except Exception as e:
            self.healthy = False
            self.last_error = str(e)
            if self.unhealthy_since is None:
                self.unhealthy_since = time.time()
            return False


class LLMRouter:
    """Routes LLM requests across multiple endpoints with priority-based
    failover and per-endpoint stats.

    Iteration order is *priority desc, then healthy first*. A caller
    that exhausts `iter_failover()` has tried every endpoint exactly
    once, healthy ones before unhealthy ones — that is the strongest
    guarantee we can make without changing the priority semantics.
    """

    def __init__(self):
        self.endpoints: List[LLMEndpoint] = []

    def add_endpoint(self, endpoint: LLMEndpoint) -> None:
        self.endpoints.append(endpoint)
        # Sort by priority (higher first)
        self.endpoints.sort(key=lambda e: -e.priority)

    def set_endpoints_from_config(self, config: Dict[str, Any]) -> None:
        """Parse config which may contain single endpoint or endpoints list."""
        self.endpoints = []

        # Multi-endpoint config
        endpoints_cfg = config.get("endpoints")
        if isinstance(endpoints_cfg, list):
            for i, ecfg in enumerate(endpoints_cfg):
                self.add_endpoint(LLMEndpoint(
                    name=ecfg.get("name", f"endpoint-{i}"),
                    base_url=ecfg.get("base_url", ecfg.get("baseUrl", "")),
                    model_id=ecfg.get("model_id", ecfg.get("modelId", "unknown")),
                    api_key=ecfg.get("api_key", ecfg.get("apiKey")),
                    priority=ecfg.get("priority", 0),
                    timeout=ecfg.get("timeout", 120.0),
                    provider=ecfg.get("provider", "openai"),
                ))
            return

        # Single endpoint fallback
        base_url = config.get("base_url", config.get("baseUrl", "http://192.168.71.100:1234/v1"))
        model_id = config.get("model_id", config.get("modelId", "minimax/minimax-m2.7"))
        api_key = config.get("api_key", config.get("apiKey"))
        self.add_endpoint(LLMEndpoint(
            name="primary",
            base_url=base_url,
            model_id=model_id,
            api_key=api_key,
            priority=10,
        ))

    def get_primary(self) -> Optional[LLMEndpoint]:
        """Return first healthy endpoint, or first endpoint if none healthy.

        Retained for callers that don't yet implement failover (the
        streaming path still uses this). New non-streaming traffic
        should iterate via `iter_failover()` instead.
        """
        for ep in self.endpoints:
            if ep.healthy:
                return ep
        return self.endpoints[0] if self.endpoints else None

    def get_all(self) -> List[LLMEndpoint]:
        return self.endpoints

    def iter_failover(self) -> Iterator[LLMEndpoint]:
        """Yield endpoints in priority-desc order, healthy first.

        A caller that walks the full iterator has tried every endpoint
        exactly once. The split (healthy vs unhealthy) is so a known-bad
        endpoint isn't tried again before a known-good one, but we still
        give unhealthy endpoints a last shot because liveness probes
        can lag actual recovery.
        """
        healthy = [ep for ep in self.endpoints if ep.healthy]
        unhealthy = [ep for ep in self.endpoints if not ep.healthy]
        for ep in healthy:
            yield ep
        for ep in unhealthy:
            yield ep

    def find_by_name(self, name: str) -> Optional[LLMEndpoint]:
        for ep in self.endpoints:
            if ep.name == name:
                return ep
        return None

    def mark_success(self, name: str, latency_ms: float) -> None:
        ep = self.find_by_name(name)
        if ep is not None:
            ep.record_success(latency_ms)

    def mark_failure(self, name: str, error: str) -> None:
        ep = self.find_by_name(name)
        if ep is not None:
            ep.record_failure(error)

    def stats(self) -> Dict[str, Any]:
        """Return rich snapshot of all endpoints for monitoring UI."""
        eps = [ep.to_dict() for ep in self.endpoints]
        healthy_count = sum(1 for e in eps if e["healthy"])
        return {
            "total_count": len(eps),
            "healthy_count": healthy_count,
            "status": "healthy" if healthy_count == len(eps) else "degraded" if healthy_count > 0 else "down",
            "endpoints": eps,
        }

    async def health_check_all(self) -> Dict[str, Any]:
        results = {}
        for ep in self.endpoints:
            ok = await ep.health_check()
            results[ep.name] = {
                "healthy": ok,
                "base_url": ep.base_url,
                "model_id": ep.model_id,
                "last_error": ep.last_error,
            }
        return results


# ---------------------------------------------------------------------------
# Chat Engine
# ---------------------------------------------------------------------------

MAX_TOOL_ITERATIONS = 10


class ChatEngine:
    def __init__(self, memory_manager: Any, sub_brain_client: Any, llm_config: Optional[Dict[str, Any]] = None,
                 sub_brain_url: str = "http://127.0.0.1:3000", rag_retriever: Any = None,
                 planner: Any = None, active_memory: Any = None):
        self.memory = memory_manager
        self.sub_brain = sub_brain_client
        self.sub_brain_url = sub_brain_url
        # Optional. When provided, chat() retrieves top-k chunks for the user's
        # message and injects them into the system prompt's {{rag_context}} slot.
        self.rag = rag_retriever
        # Optional. When provided, chat() decomposes complex requests into a
        # structured task plan and surfaces it in the response so the UI can
        # render "here's what I'm about to do" before content streams.
        self.planner = planner
        # Optional. When provided, chat() fires ActiveMemory.process_conversation
        # in the background AFTER each successful exchange — pattern-rule
        # extraction (preferences, facts, tasks, goals) into L2/L3. Without
        # this wiring, ActiveMemory was an orphan endpoint that no one called.
        # Round B2 (2026-05-20) wires it in.
        self.active_memory = active_memory
        # Round E1 fix: retain strong refs to background tasks so CPython's
        # GC can't collect them mid-flight. asyncio.create_task returns a
        # Task object that the event loop only weakly references; without
        # a strong ref the task can be silently dropped before it gets
        # scheduled. Pattern: add on create, discard on done.
        self._background_tasks: set = set()
        self.router = LLMRouter()
        self.llm_config = llm_config or {}
        self._update_router()
        self._http_client: Optional[httpx.AsyncClient] = None
        self._agent_config_cache: Dict[str, Any] = {}
        self._agent_config_ttl = 30  # seconds
        self._agent_config_fetched_at: Dict[str, float] = {}
        # Tunables (env-overridable so users can adjust at deploy time)
        self.rag_top_k: int = int(os.environ.get("WEBRAIN_RAG_TOP_K", "3"))
        self.rag_min_score: float = float(os.environ.get("WEBRAIN_RAG_MIN_SCORE", "0.0"))
        # Disable planning entirely via env, even if a planner instance is wired.
        # Useful for cost-sensitive deploys.
        self.planner_enabled: bool = os.environ.get("WEBRAIN_PLANNER_ENABLED", "1") != "0"
        # Same gating for ActiveMemory — fires per exchange so it's worth
        # making opt-out cheap. WEBRAIN_ACTIVE_MEMORY_ENABLED=0 disables.
        self.active_memory_enabled: bool = os.environ.get("WEBRAIN_ACTIVE_MEMORY_ENABLED", "1") != "0"

    def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=120.0)
        return self._http_client

    async def close(self) -> None:
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()

    def _update_router(self) -> None:
        self.router.set_endpoints_from_config(self.llm_config)

    def update_config(self, llm_config: Dict[str, Any]) -> None:
        self.llm_config = llm_config
        self._update_router()

    # -----------------------------------------------------------------------
    # ActiveMemory fire-and-forget helper
    # -----------------------------------------------------------------------
    # process_conversation() runs LLM-driven pattern-rule extraction over the
    # last 10 messages. Per-exchange latency is non-trivial (one LLM call per
    # enabled rule × N rules); blocking the chat reply on it would be a
    # regression. So we hand it to the event loop and return immediately —
    # if extraction fails or hangs, the chat reply is unaffected.
    def _fire_active_memory_async(self, session_id: str, user_input: str, reply: str) -> None:
        if not self.active_memory_enabled or self.active_memory is None:
            return
        if not session_id or not reply:
            # No reply means nothing useful to learn from; no session means
            # we can't tie the extraction back to a conversation.
            return
        messages = [
            {"role": "user", "content": user_input},
            {"role": "assistant", "content": reply},
        ]

        async def _run() -> None:
            try:
                await self.active_memory.process_conversation(session_id, messages)
            except Exception as exc:  # noqa: BLE001 — background task must never crash chat
                logger.warning(
                    "active_memory.process_conversation failed (session=%s): %s",
                    session_id, exc,
                )

        try:
            task = asyncio.create_task(_run())
        except RuntimeError:
            # No running loop (rare — only happens if chat() is called from
            # a sync context). Skip silently; the chat reply still works.
            logger.debug("no running loop for active_memory fire-and-forget; skipping")
            return
        # Hold a strong ref until the task finishes — see __init__ note.
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    # ---- Tool definitions registry ----
    _TOOL_REGISTRY: Dict[str, Dict] = {
        "execute_shell": {"type": "function", "function": {"name": "execute_shell", "description": "执行本地 shell 命令", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
        "read_file": {"type": "function", "function": {"name": "read_file", "description": "读取文件", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        "write_file": {"type": "function", "function": {"name": "write_file", "description": "写入文件", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
        "http_request": {"type": "function", "function": {"name": "http_request", "description": "HTTP 请求", "parameters": {"type": "object", "properties": {"url": {"type": "string"}, "method": {"type": "string"}}, "required": ["url", "method"]}}},
        "browse_web": {"type": "function", "function": {"name": "browse_web", "description": "浏览网页", "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
        "shell": {"type": "function", "function": {"name": "execute_shell", "description": "执行本地 shell 命令", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
        "file_read": {"type": "function", "function": {"name": "read_file", "description": "读取文件", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        "file_write": {"type": "function", "function": {"name": "write_file", "description": "写入文件", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    }

    def _get_tools_for_agent(self, agent_id: str, agent_config: Optional[Dict] = None) -> List[Dict]:
        """Build tool list for a specific agent. Falls back to all tools."""
        if not agent_config:
            return list(self._TOOL_REGISTRY.values())
        enabled = agent_config.get("tools", [])
        if not enabled:
            return list(self._TOOL_REGISTRY.values())
        tools = []
        seen = set()
        for name in enabled:
            if name in seen:
                continue
            # Map aliases
            tool_name = name
            if name == "shell":
                tool_name = "execute_shell"
            elif name == "file_read":
                tool_name = "read_file"
            elif name == "file_write":
                tool_name = "write_file"
            if tool_name in self._TOOL_REGISTRY and tool_name not in seen:
                tools.append(self._TOOL_REGISTRY[tool_name])
                seen.add(tool_name)
        return tools if tools else list(self._TOOL_REGISTRY.values())

    async def _fetch_agent_config(self, agent_id: str) -> Optional[Dict]:
        """Fetch agent config from sub-brain with caching."""
        now = asyncio.get_event_loop().time()
        cached = self._agent_config_cache.get(agent_id)
        fetched_at = self._agent_config_fetched_at.get(agent_id, 0)
        if cached and (now - fetched_at) < self._agent_config_ttl:
            return cached
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.sub_brain_url}/agents/{agent_id}")
                if resp.status_code == 200:
                    data = resp.json()
                    agent = data.get("agent") or data
                    self._agent_config_cache[agent_id] = agent
                    self._agent_config_fetched_at[agent_id] = now
                    return agent
        except Exception as e:
            logger.warning(f"Failed to fetch agent config for {agent_id}: {e}")
        return None

    def _retrieve_rag_context(self, user_input: str) -> Tuple[str, List[Dict[str, Any]]]:
        """Retrieve top-k document chunks relevant to user_input and format as text.

        Returns (rendered_text, sources) where sources is a list of
        {doc_path, chunk_idx, score} dicts for response metadata so the
        frontend can show "consulted N documents" with click-throughs.

        Failure modes (all return empty, never raise into chat flow):
          - RAG not configured (self.rag is None)
          - RAG embedder not available (e.g. sentence-transformers missing)
          - Empty index (no documents indexed yet)
        """
        if self.rag is None:
            return "", []
        if not user_input or not user_input.strip():
            return "", []
        try:
            chunks = self.rag.retrieve(user_input, k=self.rag_top_k)
        except Exception as e:  # pragma: no cover — fail open, log only
            logger.warning("rag.retrieve failed for chat: %s", e)
            return "", []

        # Filter by min score (cosine similarity floor)
        chunks = [c for c in chunks if c.score >= self.rag_min_score]
        if not chunks:
            return "", []

        # Render context block
        from pathlib import Path
        rendered_parts: List[str] = []
        sources: List[Dict[str, Any]] = []
        for c in chunks:
            name = Path(c.doc_path).name
            rendered_parts.append(
                f"### {name} (chunk #{c.chunk_idx}, similarity {c.score:.2f})\n{c.text.strip()}"
            )
            sources.append({
                "doc_path": c.doc_path,
                "chunk_idx": c.chunk_idx,
                "score": c.score,
            })
        rendered = "\n\n".join(rendered_parts)
        return rendered, sources

    async def _make_plan(self, user_input: str) -> Optional[Dict[str, Any]]:
        """Run the planner against `user_input` if one is wired in.

        Returns a JSON-serialisable dict (Plan.to_dict()) or None. Never
        raises into the chat flow — the planner is an enrichment layer,
        not a gate.
        """
        if not self.planner_enabled or self.planner is None:
            return None
        try:
            plan = await self.planner.plan(user_input)
        except Exception as e:  # pragma: no cover — defensive
            logger.warning("planner.plan() raised, skipping plan: %s", e)
            return None
        if plan is None:
            return None
        try:
            return plan.to_dict()
        except AttributeError:
            # Forward-compat: if planner returns a dict directly someday
            return plan if isinstance(plan, dict) else None

    @staticmethod
    def _format_plan_for_prompt(plan: Optional[Dict[str, Any]]) -> str:
        """Render a plan as a markdown block to splice into the system prompt.

        Returns empty string when there's no plan or no tasks — caller can
        unconditionally concat it.
        """
        if not plan:
            return ""
        tasks = plan.get("tasks") or []
        if not tasks:
            return ""
        lines = ["## Plan (subtasks the assistant intends to address)"]
        for t in tasks:
            tid = t.get("id", "?")
            desc = t.get("description", "")
            tool_hint = t.get("tool_hint", "")
            tool_part = f" — tool: {tool_hint}" if t.get("requires_tool") and tool_hint else ""
            lines.append(f"- [{tid}] {desc}{tool_part}")
        return "\n".join(lines)

    async def _build_system_prompt(self, agent_id: str, memory_text: str, rag_text: str = "",
                                    plan_block: str = "") -> str:
        """Build system prompt from agent's system.md with template substitution."""
        agent = await self._fetch_agent_config(agent_id)

        if agent and agent.get("systemPrompt"):
            prompt = agent["systemPrompt"]
        else:
            # Fallback: try to fetch system-prompt endpoint
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(f"{self.sub_brain_url}/agents/{agent_id}/system-prompt")
                    if resp.status_code == 200:
                        data = resp.json()
                        prompt = data.get("content", "")
                    else:
                        prompt = ""
            except Exception:
                prompt = ""

        if not prompt:
            # Ultimate fallback: generic assistant + RAG context if available
            prompt = (
                "You are a helpful AI assistant.\n\n"
                "## Available Tools\n{{tools}}\n\n"
                "## Relevant Memories\n{{memory}}\n\n"
                "## Document Context\n{{rag_context}}"
            )

        # Substitute template variables
        agent_name = agent.get("name", "AI Assistant") if agent else "AI Assistant"
        agent_role = agent.get("role", "assistant") if agent else "assistant"
        tools = agent.get("tools", []) if agent else []
        tools_text = "\n".join([f"- {t}" for t in tools]) if tools else "- execute_shell\n- read_file\n- write_file\n- http_request\n- browse_web"

        # If user's system_prompt template doesn't contain {{rag_context}} but
        # we have rag_text, append it as a final section so docs aren't lost.
        if rag_text and "{{rag_context}}" not in prompt:
            prompt = prompt + "\n\n## Document Context\n{{rag_context}}"

        # Same shape for the plan block — append if missing slot but we have one.
        if plan_block and "{{plan}}" not in prompt:
            prompt = prompt + "\n\n{{plan}}"

        rag_block = rag_text or "(no relevant documents)"

        prompt = prompt.replace("{{memory}}", memory_text)
        prompt = prompt.replace("{{tools}}", tools_text)
        prompt = prompt.replace("{{agent_name}}", agent_name)
        prompt = prompt.replace("{{agent_role}}", agent_role)
        prompt = prompt.replace("{{rag_context}}", rag_block)
        # Empty string replacement when no plan — keeps the slot from leaking
        # into the rendered prompt as literal `{{plan}}`.
        prompt = prompt.replace("{{plan}}", plan_block)

        return prompt

    # -----------------------------------------------------------------------
    # Core LLM call (non-streaming)
    # -----------------------------------------------------------------------
    def _build_request(self, ep: LLMEndpoint, messages: List[Dict], tools: Optional[List[Dict]] = None,
                        max_tokens: int = 2048, temperature: Optional[float] = None, stream: bool = False) -> tuple:
        """Build (url, payload, headers) for the given provider."""
        headers = {"Content-Type": "application/json"}
        temp = temperature if temperature is not None else self.llm_config.get("temperature", 0.7)

        if ep.provider == "anthropic":
            url = f"{ep.base_url}/messages"
            headers["x-api-key"] = ep.api_key or ""
            headers["anthropic-version"] = "2023-06-01"
            # Convert OpenAI format messages to Anthropic format
            system_msg = ""
            anthropic_messages = []
            for m in messages:
                if m["role"] == "system":
                    system_msg = m["content"]
                else:
                    anthropic_messages.append({"role": m["role"], "content": m["content"]})
            payload: Dict[str, Any] = {
                "model": ep.model_id,
                "messages": anthropic_messages,
                "max_tokens": max_tokens,
                "temperature": temp,
                "stream": stream,
            }
            if system_msg:
                payload["system"] = system_msg
            return url, payload, headers

        elif ep.provider == "google":
            url = f"{ep.base_url}/models/{ep.model_id}:generateContent"
            if stream:
                url += "?alt=sse"
            if ep.api_key:
                url += ("&" if "?" in url else "?") + f"key={ep.api_key}"
            # Simple conversion
            contents = [{"role": m["role"], "parts": [{"text": m["content"]}]} for m in messages if m["role"] != "system"]
            payload = {"contents": contents, "generationConfig": {"temperature": temp, "maxOutputTokens": max_tokens}}
            return url, payload, headers

        else:
            # OpenAI-compatible (openai, deepseek, lm-studio, exo)
            url = f"{ep.base_url}/chat/completions"
            payload = {
                "model": ep.model_id,
                "messages": messages,
                "temperature": temp,
                "max_tokens": max_tokens,
                "stream": stream,
            }
            if tools:
                payload["tools"] = tools
                payload["tool_choice"] = "auto"
            if ep.api_key:
                headers["Authorization"] = f"Bearer {ep.api_key}"
            return url, payload, headers

    def _parse_response(self, ep: LLMEndpoint, data: Dict) -> Dict:
        """Normalize provider response to OpenAI format."""
        if ep.provider == "anthropic":
            content = ""
            tool_calls = []
            for block in data.get("content", []):
                if block.get("type") == "text":
                    content += block.get("text", "")
                elif block.get("type") == "tool_use":
                    tool_calls.append({
                        "id": block.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": block.get("name", ""),
                            "arguments": json.dumps(block.get("input", {})),
                        }
                    })
            return {
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": content,
                        "tool_calls": tool_calls if tool_calls else None,
                    },
                    "finish_reason": "tool_calls" if tool_calls else "stop",
                }]
            }
        elif ep.provider == "google":
            parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts)
            return {
                "choices": [{
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }]
            }
        return data

    async def _chat_completion(self, messages: List[Dict], tools: Optional[List[Dict]] = None,
                                max_tokens: int = 2048, temperature: Optional[float] = None) -> Dict[str, Any]:
        """Call an LLM endpoint with automatic failover (M4a).

        Walks endpoints in priority-desc order, healthy ones first.
        Records per-endpoint success/failure stats. Raises only if every
        endpoint has been tried and all failed — the resulting error
        names which endpoint produced the last error for diagnosis.
        """
        if not self.router.endpoints:
            raise RuntimeError("No LLM endpoint available")

        last_error: Optional[Exception] = None
        last_endpoint_name: Optional[str] = None
        tried = 0

        for ep in self.router.iter_failover():
            tried += 1
            last_endpoint_name = ep.name
            url, payload, headers = self._build_request(
                ep, messages, tools, max_tokens, temperature, stream=False
            )
            t0 = time.time()
            try:
                async with httpx.AsyncClient(timeout=ep.timeout) as client:
                    resp = await client.post(url, json=payload, headers=headers)
                    resp.raise_for_status()
                    data = resp.json()
                latency_ms = (time.time() - t0) * 1000.0
                self.router.mark_success(ep.name, latency_ms)
                result = self._parse_response(ep, data)
                # Surface which endpoint won so callers / tests can assert
                # failover happened. Non-OpenAI shape, but harmless to
                # downstream consumers that ignore unknown keys.
                if isinstance(result, dict):
                    result.setdefault("_endpoint", ep.name)
                return result
            except Exception as e:
                err_msg = f"{type(e).__name__}: {e}"
                self.router.mark_failure(ep.name, err_msg)
                last_error = e
                logger.warning(
                    "LLM endpoint %s failed (%s) — failing over to next endpoint",
                    ep.name,
                    err_msg,
                )
                continue

        # All endpoints exhausted
        raise RuntimeError(
            f"All {tried} LLM endpoint(s) failed; last endpoint {last_endpoint_name!r} "
            f"raised {type(last_error).__name__ if last_error else 'unknown'}: {last_error}"
        )

    # -----------------------------------------------------------------------
    # Streaming LLM call
    # -----------------------------------------------------------------------
    async def _chat_completion_stream(self, messages: List[Dict], tools: Optional[List[Dict]] = None,
                                       max_tokens: int = 2048, temperature: Optional[float] = None) -> AsyncGenerator[Dict[str, Any], None]:
        ep = self.router.get_primary()
        if not ep:
            yield {"type": "error", "data": "No LLM endpoint available"}
            return

        url, payload, headers = self._build_request(ep, messages, tools, max_tokens, temperature, stream=True)

        client = self._get_client()
        async with client.stream("POST", url, json=payload, headers=headers, timeout=ep.timeout) as resp:
                resp.raise_for_status()
                if ep.provider == "anthropic":
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data == "[DONE]":
                            yield {"type": "done"}
                            break
                        try:
                            chunk = json.loads(data)
                            if chunk.get("type") == "content_block_delta":
                                text = chunk.get("delta", {}).get("text", "")
                                if text:
                                    yield {"type": "content", "data": text}
                            elif chunk.get("type") == "message_stop":
                                yield {"type": "done"}
                                break
                        except Exception as e:
                            logger.warning(f"Anthropic stream parse error: {e}")
                            continue
                else:
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data == "[DONE]":
                            yield {"type": "done"}
                            break
                        try:
                            chunk = json.loads(data)
                            delta = chunk["choices"][0].get("delta", {})
                            if delta.get("reasoning_content"):
                                yield {"type": "reasoning", "data": delta["reasoning_content"]}
                            if delta.get("content"):
                                yield {"type": "content", "data": delta["content"]}
                            elif delta.get("tool_calls"):
                                yield {"type": "tool_call_delta", "data": delta["tool_calls"]}
                            elif chunk["choices"][0].get("finish_reason") == "tool_calls":
                                yield {"type": "tool_calls_ready", "data": chunk}
                        except Exception as e:
                            logger.warning(f"Stream parse error: {e}")
                            continue

    # -----------------------------------------------------------------------
    # Tool execution
    # -----------------------------------------------------------------------
    async def _execute_tool(self, tool_call: Dict) -> str:
        func = tool_call.get("function", {})
        tool_name = func.get("name", "")
        try:
            args = json.loads(func.get("arguments", "{}"))
        except Exception:
            args = {}

        # Map to sub-brain tool names
        sub_tool = {
            "execute_shell": "shell",
            "read_file": "file_read",
            "write_file": "file_write",
            "http_request": "http_request",
            "browse_web": "screenshot",
        }.get(tool_name, tool_name)

        try:
            result = await asyncio.wait_for(
                self.sub_brain.execute_tool(sub_tool, args),
                timeout=30.0,
            )
            return json.dumps(result, ensure_ascii=False) if not isinstance(result, str) else result
        except asyncio.TimeoutError:
            return f"Error: Tool '{tool_name}' timed out after 30s"
        except Exception as e:
            return f"Error: {type(e).__name__}: {str(e)}"

    # -----------------------------------------------------------------------
    # Multi-turn chat with recursive tool calling
    # -----------------------------------------------------------------------
    async def chat(self, user_input: str, session_id: str,
                   agent_id: str = "agent-default", context: Optional[Dict] = None) -> Dict[str, Any]:
        # Store user message
        await self.memory.store({"level": "L1", "content": user_input, "session_id": session_id, "source": "user"})

        # Retrieve memories
        relevant = await self.memory.query({"query": user_input, "levels": ["L2", "L3"], "limit": 5})
        memory_text = "\n".join([f"- {m.get('content', '')}" for m in relevant]) or "无相关记忆"

        # Plan-execution call sites set these flags to prevent recursion
        # (the executor already has a plan; running it shouldn't re-plan) and
        # to skip RAG, which was applied at plan time.
        ctx = context or {}
        disable_planner = bool(ctx.get("disable_planner", False))
        disable_rag = bool(ctx.get("disable_rag", False))

        # Retrieve RAG document chunks (top-k cosine similar)
        if disable_rag:
            rag_text, rag_sources = "", []
        else:
            rag_text, rag_sources = self._retrieve_rag_context(user_input)

        # Decompose complex requests into a structured plan (M2)
        plan_dict = None if disable_planner else await self._make_plan(user_input)
        plan_block = self._format_plan_for_prompt(plan_dict)

        # Fetch agent config and build prompt
        agent_config = await self._fetch_agent_config(agent_id)
        system_prompt = await self._build_system_prompt(agent_id, memory_text, rag_text, plan_block)
        messages: List[Dict] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ]

        tools_enabled = (context or {}).get("tools_enabled", True)
        available_tools = self._get_tools_for_agent(agent_id, agent_config) if tools_enabled else None
        all_tool_calls: List[Dict] = []
        all_tool_results: List[Dict] = []

        iteration = 0
        while iteration < MAX_TOOL_ITERATIONS:
            iteration += 1

            # LLM call
            result = await self._chat_completion(messages, tools=available_tools)
            msg = result["choices"][0]["message"]
            tool_calls = msg.get("tool_calls", [])

            if not tool_calls:
                reply = msg.get("content", "")
                await self.memory.store({"level": "L1", "content": f"Assistant: {reply}", "session_id": session_id, "source": "assistant"})
                # Fire ActiveMemory extraction in the background. Must come
                # AFTER the L1 store so process_conversation sees a coherent
                # exchange when it queries memory, and BEFORE return so we
                # don't lose the reference if the caller never awaits again.
                self._fire_active_memory_async(session_id, user_input, reply)
                return {
                    "reply": reply,
                    "tool_calls": all_tool_calls,
                    "tool_results": all_tool_results,
                    "session_id": session_id,
                    "iterations": iteration,
                    "rag_sources": rag_sources,
                    "plan": plan_dict,
                }

            # Execute tools
            tool_results = []
            for tc in tool_calls:
                result_text = await self._execute_tool(tc)
                tool_results.append({
                    "tool_call_id": tc.get("id", ""),
                    "tool": tc.get("function", {}).get("name", ""),
                    "args": tc.get("function", {}).get("arguments", ""),
                    "result": result_text,
                })
                all_tool_calls.append(tc)
                all_tool_results.append(tool_results[-1])

            # Add assistant message with tool_calls to context
            messages.append(msg)

            # Add tool results
            for tr in tool_results:
                messages.append({
                    "role": "tool",
                    "tool_call_id": tr["tool_call_id"],
                    "content": tr["result"],
                })

            # Continue loop for next LLM decision

        # Max iterations reached
        return {
            "reply": "任务执行轮次过多，请简化您的请求。",
            "tool_calls": all_tool_calls,
            "tool_results": all_tool_results,
            "session_id": session_id,
            "iterations": iteration,
            "rag_sources": rag_sources,
            "plan": plan_dict,
        }

    # -----------------------------------------------------------------------
    # Streaming chat (first iteration only streamed; tool calls are blocking)
    # -----------------------------------------------------------------------
    async def chat_stream(self, user_input: str, session_id: str,
                          agent_id: str = "agent-default", context: Optional[Dict] = None) -> AsyncGenerator[Dict[str, Any], None]:
        """Streaming chat. Yields content chunks during LLM generation.
        If tool calls are needed, yields tool_call events and pauses.
        After tool execution, continues with final response."""

        await self.memory.store({"level": "L1", "content": user_input, "session_id": session_id, "source": "user"})

        relevant = await self.memory.query({"query": user_input, "levels": ["L2", "L3"], "limit": 5})
        memory_text = "\n".join([f"- {m.get('content', '')}" for m in relevant]) or "无相关记忆"

        # Mirror the chat() flags so PlanExecutor + ChatEngine.chat_stream
        # can share a code path without re-planning recursively.
        ctx = context or {}
        disable_planner = bool(ctx.get("disable_planner", False))
        disable_rag = bool(ctx.get("disable_rag", False))

        # Retrieve RAG document chunks (top-k cosine similar)
        if disable_rag:
            rag_text, rag_sources = "", []
        else:
            rag_text, rag_sources = self._retrieve_rag_context(user_input)
        if rag_sources:
            # Notify frontend up-front so the UI can render a "consulted N docs" badge
            # before the model starts streaming a reply.
            yield {"type": "rag_sources", "data": rag_sources}

        # Decompose complex requests into a structured plan (M2). Emit the
        # plan event BEFORE the first content chunk so the UI can render the
        # subtask list while tokens are still streaming.
        plan_dict = None if disable_planner else await self._make_plan(user_input)
        if plan_dict:
            yield {"type": "plan", "data": plan_dict}
        plan_block = self._format_plan_for_prompt(plan_dict)

        # Fetch agent config and build prompt
        agent_config = await self._fetch_agent_config(agent_id)
        system_prompt = await self._build_system_prompt(agent_id, memory_text, rag_text, plan_block)
        messages: List[Dict] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ]

        tools_enabled = (context or {}).get("tools_enabled", True)
        available_tools = self._get_tools_for_agent(agent_id, agent_config) if tools_enabled else None
        all_tool_calls: List[Dict] = []
        all_tool_results: List[Dict] = []

        iteration = 0
        while iteration < MAX_TOOL_ITERATIONS:
            iteration += 1

            # First iteration: try streaming
            if iteration == 1:
                full_content = ""
                collected_tool_calls: List[Dict] = []
                has_tool_calls = False

                async for chunk in self._chat_completion_stream(messages, tools=available_tools):
                    if chunk["type"] == "content":
                        full_content += chunk["data"]
                        yield chunk
                    elif chunk["type"] == "tool_call_delta":
                        has_tool_calls = True
                        # Accumulate tool call deltas (simplified)
                        yield {"type": "thinking", "data": "正在思考使用工具..."}
                    elif chunk["type"] == "done":
                        break
                    elif chunk["type"] == "error":
                        yield chunk
                        return

                if not has_tool_calls:
                    # No tool calls needed — done
                    await self.memory.store({"level": "L1", "content": f"Assistant: {full_content}", "session_id": session_id, "source": "assistant"})
                    self._fire_active_memory_async(session_id, user_input, full_content)
                    yield {"type": "done", "data": full_content}
                    return

                # Tool calls detected — fall back to non-streaming for reliable parsing
                yield {"type": "thinking", "data": "检测到需要使用工具，正在执行..."}
                result = await self._chat_completion(messages, tools=available_tools)
            else:
                result = await self._chat_completion(messages, tools=available_tools)

            msg = result["choices"][0]["message"]
            tool_calls = msg.get("tool_calls", [])

            if not tool_calls:
                reply = msg.get("content", "")
                await self.memory.store({"level": "L1", "content": f"Assistant: {reply}", "session_id": session_id, "source": "assistant"})
                self._fire_active_memory_async(session_id, user_input, reply)
                yield {"type": "content", "data": reply}
                yield {"type": "done", "data": reply}
                return

            # Execute tools
            tool_results = []
            for tc in tool_calls:
                tool_name = tc.get("function", {}).get("name", "")
                yield {"type": "tool_start", "data": {"name": tool_name, "args": tc.get("function", {}).get("arguments", "")}}

                result_text = await self._execute_tool(tc)

                yield {"type": "tool_end", "data": {"name": tool_name, "result_preview": result_text[:200]}}

                tool_results.append({
                    "tool_call_id": tc.get("id", ""),
                    "tool": tool_name,
                    "args": tc.get("function", {}).get("arguments", ""),
                    "result": result_text,
                })
                all_tool_calls.append(tc)
                all_tool_results.append(tool_results[-1])

            # Update messages for next iteration
            messages.append(msg)
            for tr in tool_results:
                messages.append({
                    "role": "tool",
                    "tool_call_id": tr["tool_call_id"],
                    "content": tr["result"],
                })

        yield {"type": "error", "data": "任务执行轮次过多，请简化您的请求。"}
