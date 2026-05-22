"""
Chat Engine — Streaming + Multi-turn Tool Calling + Multi-model Endpoint Support
"""

import asyncio
import hashlib
import json
import logging
import os
import re
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
        base_url = config.get("base_url", config.get("baseUrl", "http://localhost:1234/v1"))
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
                 planner: Any = None, active_memory: Any = None, kg: Optional[Any] = None):
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
        # S9: 知识图谱上下文注入 (KG Context Injection) — 将 KG 中与当前消息相关的
        # 实体及其关联无条件注入系统提示。零成本：纯内存子串匹配，无 LLM 调用/DB 查询。
        self.kg = kg
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
        # Round O3 — instance-level tool embedding cache + lock
        # (was class-level in N1; the class-level approach raced).
        self._tool_embedding_cache = {}
        self._tool_embedding_signature = ""
        self._tool_embedding_lock = asyncio.Lock()
        # Tunables (env-overridable so users can adjust at deploy time)
        self.rag_top_k: int = int(os.environ.get("WEBRAIN_RAG_TOP_K", "3"))
        self.rag_min_score: float = float(os.environ.get("WEBRAIN_RAG_MIN_SCORE", "0.0"))
        # Disable planning entirely via env, even if a planner instance is wired.
        # Useful for cost-sensitive deploys.
        self.planner_enabled: bool = os.environ.get("WEBRAIN_PLANNER_ENABLED", "1") != "0"
        # Same gating for ActiveMemory — fires per exchange so it's worth
        # making opt-out cheap. WEBRAIN_ACTIVE_MEMORY_ENABLED=0 disables.
        self.active_memory_enabled: bool = os.environ.get("WEBRAIN_ACTIVE_MEMORY_ENABLED", "1") != "0"

        # ── Round S: AI 能力升级 ──────────────────────────────────────────────
        # S1: HyDE (Hypothetical Document Embeddings) — 生成假设性答案文档辅助向量检索。
        # 将原始问题扩展为一个"理想答案草稿"，用该草稿的 embedding 检索语义更接近答案空间
        # 的记忆块，比直接用问题 embedding 精度更高（尤其对知识密集型问题）。
        # 代价：每次记忆检索额外一次 LLM 调用（快速小模型可控）。
        self.hyde_enabled: bool = os.environ.get("WEBRAIN_HYDE_ENABLED", "1") != "0"
        self.hyde_max_tokens: int = int(os.environ.get("WEBRAIN_HYDE_MAX_TOKENS", "120"))

        # S2: 反思循环 (Reflection Loop) — 生成答复后对自身进行评分，分低则修订。
        # 仅在非工具调用路径且答复长度 > 100 字时触发，最多修订 1 次，避免无限循环。
        # 默认关闭（每次对话增加一个额外 LLM 调用）。
        self.reflection_enabled: bool = os.environ.get("WEBRAIN_REFLECTION_ENABLED", "0") != "0"
        self.reflection_threshold: int = int(os.environ.get("WEBRAIN_REFLECTION_THRESHOLD", "3"))

        # S3: 工作记忆 (Working Memory) — 会话内短期上下文记忆，独立于 L1-L4 长期记忆。
        # 每轮对话结束后异步提取 3-5 条关键实体/事实，注入下一轮 system prompt。
        # 防止长对话中早期重要信息被淡忘（与 M2 摘要互补，M2 负责压缩历史，
        # WorkingMemory 负责保持当前任务关键信息的即时可达性）。
        self.working_memory_enabled: bool = os.environ.get("WEBRAIN_WORKING_MEMORY_ENABLED", "1") != "0"
        self.working_memory_max: int = int(os.environ.get("WEBRAIN_WORKING_MEMORY_MAX", "10"))
        self._working_memory: Dict[str, List[str]] = {}  # session_id → 当前会话关键事实列表

        # S4: 工具结果缓存 (Tool Result Cache) — 对只读工具结果按 (工具名+参数) 缓存。
        # 避免在同一对话内重复调用相同的文件读取/HTTP 请求。TTL 单位秒。
        self._tool_cache: Dict[str, Tuple[str, float]] = {}  # cache_key → (result, timestamp)
        self.tool_cache_ttl: float = float(os.environ.get("WEBRAIN_TOOL_CACHE_TTL", "300"))

        # S5: 上下文压缩 (Context Compression) — 防止多工具调用链撑爆上下文窗口。
        # 当 messages 列表超过阈值时，将中间的工具调用往返历史压缩为摘要，
        # 保留系统提示、首条用户消息和最近 N 条消息。
        # 默认开启；过度激进的压缩可能损失精度，可通过 WEBRAIN_CONTEXT_COMPRESS_THRESHOLD
        # 调大阈值来减少触发频率。
        self.context_compress_enabled: bool = os.environ.get("WEBRAIN_CONTEXT_COMPRESS_ENABLED", "1") != "0"
        self.context_compress_threshold: int = int(os.environ.get("WEBRAIN_CONTEXT_COMPRESS_THRESHOLD", "12"))
        self.context_compress_keep_recent: int = int(os.environ.get("WEBRAIN_CONTEXT_COMPRESS_KEEP", "4"))

        # S8: 持久化用户上下文 (Persistent User Context) — 将 L3/L4 中的 [preference] 和
        # [goal] 事实无条件注入每次对话的系统提示，不依赖查询相关性。
        # 与 S3 工作记忆互补：S3 保持当前会话事实，S8 保持跨会话的用户身份/偏好。
        # 结果按 TTL 秒缓存，避免高频 DB 查询。
        self.user_profile_enabled: bool = os.environ.get("WEBRAIN_USER_PROFILE_ENABLED", "1") != "0"
        self.user_profile_top_k: int = int(os.environ.get("WEBRAIN_USER_PROFILE_TOP_K", "5"))
        self.user_profile_ttl: float = float(os.environ.get("WEBRAIN_USER_PROFILE_TTL", "60"))
        self._user_profile_cache: Optional[str] = None
        self._user_profile_cached_at: float = 0.0
        # S8 并发锁：防止 TTL 到期时多个协程同时发出 DB 查询（惊群效应）。
        # 注意：asyncio.Lock 必须在运行中的 event loop 内创建；此处设为 None，
        # 在第一次 _load_user_profile 调用时（已在协程中）惰性初始化。
        self._user_profile_lock: Optional[asyncio.Lock] = None

        # S9: 知识图谱上下文 (KG Context) — 将 KG 中命中当前消息关键词的实体和关系
        # 直接注入系统提示。纯内存操作，延迟 <1ms。不影响无 KG 场景（直接跳过）。
        self.kg_context_enabled: bool = os.environ.get("WEBRAIN_KG_CONTEXT_ENABLED", "1") != "0"
        self.kg_context_top_k: int = int(os.environ.get("WEBRAIN_KG_CONTEXT_TOP_K", "3"))
        self.kg_context_max_rels: int = int(os.environ.get("WEBRAIN_KG_CONTEXT_MAX_RELS", "3"))

        # S10: 会话锚点 (Conversation Anchor) — 新会话第一条消息时，检索近期相关的
        # L2 对话摘要注入系统提示，帮助 AI 理解跨会话上下文（"上次我们在讨论..."）。
        # 与 S3 工作记忆互补：S3 是当前会话内的短期记忆；S10 是跨会话的对话脉络。
        self.conv_anchor_enabled: bool = os.environ.get("WEBRAIN_CONV_ANCHOR_ENABLED", "1") != "0"
        self.conv_anchor_top_k: int = int(os.environ.get("WEBRAIN_CONV_ANCHOR_TOP_K", "2"))
        self.conv_anchor_days: int = int(os.environ.get("WEBRAIN_CONV_ANCHOR_DAYS", "7"))
        # 本进程内已"激活"的 session_id 集合 — 用于识别新会话（S10 只在首条消息触发）
        self._anchored_sessions: set = set()

        # S11: 记忆置信度标注 (Memory Confidence Grounding) — 在 memory_text 末尾追加
        # 一行元信号，告知 AI 当前查出的记忆中有多少条是已验证（importance ≥ 阈值）的
        # L3/L4 事实，而非仅为原始 L1/L2 片段。AI 可据此校准其回答的确信度。
        # 零成本：仅统计 memory.query 已返回的结果，无额外 DB/LLM 调用。
        self.mem_confidence_enabled: bool = os.environ.get("WEBRAIN_MEM_CONFIDENCE_ENABLED", "1") != "0"
        try:
            self.mem_confidence_threshold: float = float(
                os.environ.get("WEBRAIN_MEM_CONFIDENCE_THRESHOLD", "0.7")
            )
        except ValueError:
            logger.warning("WEBRAIN_MEM_CONFIDENCE_THRESHOLD 无效，使用默认值 0.7")
            self.mem_confidence_threshold = 0.7

        # S12: 分层记忆展示 (Importance-Tiered Memory Display) — 将 memory_text 中的
        # 记忆条目按重要性分组：已验证事实（importance ≥ 阈值）与近期对话片段分开展示，
        # 帮助 AI 在事实层面区分高置信来源与原始片段，而非仅依赖 S11 的汇总信号。
        # 与 S11 共用 mem_confidence_threshold 阈值，默认开启。
        self.mem_tiered_enabled: bool = os.environ.get("WEBRAIN_MEM_TIERED_ENABLED", "1") != "0"

        # S13: L4 身份锚点强制注入 (Always-On L4 Identity Anchors) — 每次对话时，
        # 将 importance 最高的 K 条 L4 记忆（用户的长期身份事实）前置追加到 relevant 列表。
        # L4 事实仅在与当前 query 语义相似时才会出现在 memory.query 结果中；
        # S13 确保无论当前 query 主题如何，用户的核心身份信息（工作风格、技术偏好、
        # 长期目标等）始终进入 AI 上下文。与 S8 的 [preference]/[goal] 过滤互补：
        # S8 仅注入标签明确的偏好/目标；S13 注入所有 L4（包括未打标签的身份事实）。
        self.l4_anchor_enabled: bool = os.environ.get("WEBRAIN_L4_ANCHOR_ENABLED", "1") != "0"
        self.l4_anchor_top_k: int = int(os.environ.get("WEBRAIN_L4_ANCHOR_TOP_K", "2"))

        # S14: 时态上下文注入 (Temporal Context Injection) — 将当前日期、星期、时间
        # 注入每次对话的系统提示，使 AI 具备时态感知能力。
        # 解决 "帮我规划这周的任务"、"今天是什么日期" 等时态查询 AI 无法作答的问题。
        # 零成本：单次 datetime.now() 调用，无额外 LLM/DB 调用。默认开启。
        self.temporal_context_enabled: bool = (
            os.environ.get("WEBRAIN_TEMPORAL_CONTEXT_ENABLED", "1") != "0"
        )

        # S15: 记忆时效信号 (Memory Freshness Signal) — 计算 relevant 记忆的平均新鲜度，
        # 补充 S11 的"置信度"信号（S11 基于 importance，S15 基于创建时间）。
        # 一条重要但过时的记忆（用户观点可能已改变）与一条近期创建的高置信记忆在
        # S11 看来是等价的；S15 区分这两种情况，帮助 AI 适当地对陈旧记忆保持谨慎。
        # 零成本：仅解析已查询结果的 created_at 字段，无额外 DB/LLM 调用。
        self.mem_freshness_enabled: bool = (
            os.environ.get("WEBRAIN_MEM_FRESHNESS_ENABLED", "1") != "0"
        )
        try:
            self.mem_freshness_fresh_days: int = int(
                os.environ.get("WEBRAIN_MEM_FRESHNESS_FRESH_DAYS", "7")
            )
            self.mem_freshness_stale_days: int = int(
                os.environ.get("WEBRAIN_MEM_FRESHNESS_STALE_DAYS", "30")
            )
        except ValueError:
            logger.warning("WEBRAIN_MEM_FRESHNESS_*_DAYS 含非法值，使用默认值 7/30")
            self.mem_freshness_fresh_days = 7
            self.mem_freshness_stale_days = 30

        # S16: 知识缺口检测 (Knowledge Gap Detection) — 当 relevant 为空或全部为低置信/
        # 陈旧记忆时，向系统提示注入行为指令 [知识缺口]，引导 AI 主动向用户澄清，
        # 而非基于不充分的上下文进行猜测或幻觉。
        # 将一个已知弱点（无记忆上下文时 AI 易幻觉）转化为主动行为信号。
        # 零成本：纯逻辑判断，无额外 DB/LLM 调用。
        self.knowledge_gap_enabled: bool = (
            os.environ.get("WEBRAIN_KNOWLEDGE_GAP_ENABLED", "1") != "0"
        )

        # S17: 记忆信号使用指南 (Memory Signal Usage Guide) — 在 memory_text 顶部注入
        # 一行紧凑的自文档化说明，告知 AI 如何解读 S11-S16 注入的各类标签。
        # 解决"信号存在但 AI 不知道该如何使用"的问题 — 将 S11-S16 从被动装饰转化为
        # 有明确语义的行为指令。约 20 token 的开销，但使整个 S 系列信号形成闭环。
        self.mem_signal_guide_enabled: bool = (
            os.environ.get("WEBRAIN_MEM_SIGNAL_GUIDE_ENABLED", "1") != "0"
        )

        # S18: 查询意图感知 (Query Intent Awareness) — 纯关键词分类（零 LLM 调用），
        # 根据用户消息类型动态注入记忆使用提示，帮助 AI 在不同查询场景下调整
        # 记忆引用策略（个人信息回溯 / 历史回溯 / 任务执行）。
        # 与 S16 知识缺口检测形成互补：S16 告诉 AI 记忆有多少，S18 告诉 AI 如何使用。
        self.query_intent_enabled: bool = (
            os.environ.get("WEBRAIN_QUERY_INTENT_ENABLED", "1") != "0"
        )

        # S19: 记忆来源多样性信号 (Memory Source Diversity Signal) — 统计 relevant 中
        # L3/L4（已验证事实）与 L1/L2（近期片段）的条数分布，生成单行来源标签。
        # 与 S11 置信度聚合互补：S11 给出整体评级，S19 给出条数拆解，帮助 AI 了解
        # 当前记忆集的可信度结构，而非仅凭聚合分数做判断。零成本（纯列表统计）。
        self.mem_source_diversity_enabled: bool = (
            os.environ.get("WEBRAIN_MEM_SOURCE_DIVERSITY_ENABLED", "1") != "0"
        )

        # S20: 记忆充分性信号 (Memory Adequacy Signal) — 根据 S18 查询意图 +
        # validated 条数，生成意图特定的行为指令（充足/有限/不足）。与 S11/S19
        # 聚合-统计互补：S11 给评级、S19 给条数、S20 给"该怎么做"。仅在
        # PERSONAL_RECALL / TEMPORAL_RECALL 意图下注入；GENERAL/TASK_ASSIST 不注入。
        # Assembly 层在 S16 gap_hint 触发时跳过 S20，避免矛盾指令（HIGH fix）。
        self.mem_adequacy_enabled: bool = (
            os.environ.get("WEBRAIN_MEM_ADEQUACY_ENABLED", "1") != "0"
        )

        # S21: 实体关注度信号 (Entity Spotlight) — 检测 user message 命中的
        # KG 实体,生成 `[本轮关注实体: A, B, C]` 单行,让 AI 显式知道用户
        # 正在谈的是哪些已有实体。与 S9 KG 上下文注入互补:S9 注入实体
        # 详细信息到系统提示,S21 在 memory block 末尾点名"本轮焦点"。
        # 零成本(KG.search 已内存索引)。
        self.entity_spotlight_enabled: bool = (
            os.environ.get("WEBRAIN_ENTITY_SPOTLIGHT_ENABLED", "1") != "0"
        )
        try:
            self.entity_spotlight_top_k: int = int(
                os.environ.get("WEBRAIN_ENTITY_SPOTLIGHT_TOP_K", "5")
            )
        except ValueError:
            self.entity_spotlight_top_k = 5

        # S22: 对话主题分类 (Conversation Topic) — 纯关键词分类用户当前
        # 消息属于哪个主题域(编程/写作/学习/工作/生活/通用),注入相应
        # 行为提示。与 S18 查询意图(回溯式 vs 任务式)互补:S18 看"问什么",
        # S22 看"哪个领域"。两者联合让 AI 既知道用户的查询模式又知道
        # 应该用什么语气/术语回答。零 LLM 调用。
        self.topic_classifier_enabled: bool = (
            os.environ.get("WEBRAIN_TOPIC_CLASSIFIER_ENABLED", "1") != "0"
        )

        # S23: 对话连贯性信号 (Conversation Coherence) — 用 embedder 计算
        # 本轮与上轮 user message 的语义相似度,提示 AI 是否在话题切换。
        # 三档:连贯(>0.65) / 中等(0.35-0.65,不注入) / 切换(<0.35)。
        # 帮 AI 在话题切换时主动跨越上下文鸿沟(例如"好的我们换个话题
        # 来聊 X"),而不是延续上一轮的语境。每会话首条不触发。
        # 单次 embedder 调用(~10ms),CPU 已有 embedder cache。
        self.coherence_enabled: bool = (
            os.environ.get("WEBRAIN_COHERENCE_ENABLED", "1") != "0"
        )
        try:
            self.coherence_high_threshold: float = float(
                os.environ.get("WEBRAIN_COHERENCE_HIGH", "0.65")
            )
            self.coherence_low_threshold: float = float(
                os.environ.get("WEBRAIN_COHERENCE_LOW", "0.35")
            )
        except ValueError:
            self.coherence_high_threshold = 0.65
            self.coherence_low_threshold = 0.35
        # 每个会话保留上一条 user message 的 embedding,用于本轮比较
        self._last_user_embedding: Dict[str, Any] = {}

        # S24: 高频引用记忆标记 (Hot Memory Highlight) — 统计本会话内某条
        # memory 被 retrieve 命中的次数,在 memory_text 中给高频项(>=3 次)
        # 加 [高频] 前缀,帮 AI 识别"反复出现的关键事实"——这通常是
        # 用户最在意的信息。session-scope 内存计数,无需 DB schema 改动。
        self.hot_memory_enabled: bool = (
            os.environ.get("WEBRAIN_HOT_MEMORY_ENABLED", "1") != "0"
        )
        try:
            self.hot_memory_threshold: int = int(
                os.environ.get("WEBRAIN_HOT_MEMORY_THRESHOLD", "3")
            )
        except ValueError:
            self.hot_memory_threshold = 3
        # 会话级 memory hit counter: {session_id: {memory_id: count}}
        self._memory_hit_counter: Dict[str, Dict[str, int]] = {}

        # S25: 用户行为节律信号 (User Cadence) — 基于本会话消息时间戳
        # 推断用户当前的对话节律:快速(<60s 一条)/常规(60-300s)/慢思考
        # (>300s)。在快速节律下,AI 应回答更简短;慢思考时,可详尽展开。
        # 与 S22 主题协同:慢思考 + LEARNING 主题 = 深度解释最合适。
        # 纯时间戳计算,无 LLM/DB 开销。
        self.cadence_enabled: bool = (
            os.environ.get("WEBRAIN_CADENCE_ENABLED", "1") != "0"
        )
        # 会话级最近 5 条消息时间戳: {session_id: [ts1, ts2, ...]}
        self._cadence_timestamps: Dict[str, List[float]] = {}

        # S26: 对话回合深度信号 (Turn Depth) — 当前会话已经进行了多少轮对话?
        # 深对话(>5 轮)需要更注重一致性,避免前后矛盾;首轮对话需要更开放性。
        # 与 S10 跨会话锚点互补:S10 跨会话,S26 同会话内深度。零成本(计数器)。
        self.turn_depth_enabled: bool = (
            os.environ.get("WEBRAIN_TURN_DEPTH_ENABLED", "1") != "0"
        )
        # 会话级回合计数器: {session_id: count}
        self._turn_counters: Dict[str, int] = {}

        # S27: 记忆陈旧度告警 (Memory Staleness Alert) — 与 S15 时效信号互补,
        # 但聚焦"单条最旧记忆": 当某条 relevant 记忆 > N 天前(默认 90),
        # 在 memory_text 末尾追加 `[陈旧记忆告警: M1 已 120 天前,引用时需说明]`,
        # 让 AI 主动告知用户"这是较老的信息"避免信息时滞误导。
        self.staleness_alert_enabled: bool = (
            os.environ.get("WEBRAIN_STALENESS_ALERT_ENABLED", "1") != "0"
        )
        try:
            self.staleness_alert_days: int = int(
                os.environ.get("WEBRAIN_STALENESS_ALERT_DAYS", "90")
            )
        except ValueError:
            self.staleness_alert_days = 90

        # S28: 用户专业级别推断 (Expertise Inference) — 基于本会话累计的
        # CODING 主题 + 术语密度推断用户在某领域是 NOVICE / INTERMEDIATE /
        # EXPERT。EXPERT 时跳过基础解释直接给代码,NOVICE 时多解释。零 LLM
        # 调用(纯关键词 + 计数)。
        self.expertise_enabled: bool = (
            os.environ.get("WEBRAIN_EXPERTISE_ENABLED", "1") != "0"
        )
        # 会话级专业级别累积证据 {session_id: {"expert_hits": int, "novice_hits": int}}
        self._expertise_counters: Dict[str, Dict[str, int]] = {}

        # S29: 响应长度建议 (Response Length Hint) — 综合 S22 主题 + S25 节律 +
        # S26 回合深度,给 AI 一个明确的响应长度提示: 精简(<150 字)/常规
        # (150-500)/详尽(>500)。统一长度策略让 UX 更可预期。
        self.length_hint_enabled: bool = (
            os.environ.get("WEBRAIN_LENGTH_HINT_ENABLED", "1") != "0"
        )

        # S30: 工具调用频次提示 (Tool Call Frequency) — 统计本会话内的 tool_call
        # 次数,若 >= 阈值(默认 5)提示 AI"已多次工具调用,考虑直接给结论"。
        # 防止 LLM 陷入工具调用循环不收敛。
        self.tool_freq_enabled: bool = (
            os.environ.get("WEBRAIN_TOOL_FREQ_ENABLED", "1") != "0"
        )
        try:
            self.tool_freq_threshold: int = int(
                os.environ.get("WEBRAIN_TOOL_FREQ_THRESHOLD", "5")
            )
        except ValueError:
            self.tool_freq_threshold = 5
        # 会话级工具调用计数 {session_id: count}
        self._tool_call_counters: Dict[str, int] = {}

        # S31: 对话节奏切换信号 (Pace Switch) — 跟踪本会话最近 N 条用户消息字数,
        # 若最近 3 条 vs 之前 3 条均长发生显著切换(>= 2x),提示 AI 调整深浅度。
        # 帮助 AI 感知用户"快速问答 → 深入探讨"或反向切换。零成本(滑动窗口)。
        self.pace_switch_enabled: bool = (
            os.environ.get("WEBRAIN_PACE_SWITCH_ENABLED", "1") != "0"
        )
        # 会话级近期消息字数历史 {session_id: [len, len, ...]} (最多 6 条)
        self._pace_history: Dict[str, List[int]] = {}

        # S32: 重复性问题检测 (Repeat Question) — 比较当前用户消息与本会话近 5 条
        # 用户消息的 Jaccard 字符 3-gram 重合度,若 >= 阈值视为重复询问。
        # 帮助 AI 意识到用户对上次回答不满意,应换角度或更具体回答。零成本。
        self.repeat_question_enabled: bool = (
            os.environ.get("WEBRAIN_REPEAT_QUESTION_ENABLED", "1") != "0"
        )
        try:
            self.repeat_question_threshold: float = float(
                os.environ.get("WEBRAIN_REPEAT_QUESTION_THRESHOLD", "0.6")
            )
        except ValueError:
            self.repeat_question_threshold = 0.6
        # 会话级近期用户消息缓存 {session_id: [msg, msg, ...]} (最多 5 条)
        self._user_msg_history: Dict[str, List[str]] = {}

        # S33: 时段感知行为信号 (Time-of-day) — 基于当前小时为深夜/晚间/工作时段
        # 注入语气/深度提示。复用 S14 datetime 资源,零额外成本。
        self.time_of_day_enabled: bool = (
            os.environ.get("WEBRAIN_TIME_OF_DAY_ENABLED", "1") != "0"
        )

        # S34: 短句上下文遗漏检测 (Context Drop) — 若用户消息很短(< 10 字符)
        # 且本会话已有 >= 2 条历史,且消息中无明确指代代词(我/你/这/那),
        # 提示 AI 联系上下文推断意图或主动询问。零成本(字符长度判断)。
        self.context_drop_enabled: bool = (
            os.environ.get("WEBRAIN_CONTEXT_DROP_ENABLED", "1") != "0"
        )
        try:
            self.context_drop_max_chars: int = int(
                os.environ.get("WEBRAIN_CONTEXT_DROP_MAX_CHARS", "10")
            )
        except ValueError:
            self.context_drop_max_chars = 10

        # S35: 失败反馈识别 (Negative Feedback) — 扫描用户消息中"不对/错了/没明白"
        # 等失败信号关键词,触发后提示 AI 彻底重新理解需求,避免再次重复同思路。
        # 零成本(关键词匹配)。
        self.negative_feedback_enabled: bool = (
            os.environ.get("WEBRAIN_NEGATIVE_FEEDBACK_ENABLED", "1") != "0"
        )

        # S36: 用户角色推断 (Role Inference) — 基于本会话累积关键词分布推断
        # 用户主要身份: DEVELOPER / MANAGER / STUDENT / CREATOR / GENERAL。
        # 帮助 AI 调整回答风格(技术深度 / 抽象高度 / 启发性 / 创意感)。
        # 零成本(关键词计数 + 阈值)。
        self.role_inference_enabled: bool = (
            os.environ.get("WEBRAIN_ROLE_INFERENCE_ENABLED", "1") != "0"
        )
        try:
            self.role_inference_min_signals: int = int(
                os.environ.get("WEBRAIN_ROLE_INFERENCE_MIN", "3")
            )
        except ValueError:
            self.role_inference_min_signals = 3
        # 会话级角色信号累计 {session_id: {DEVELOPER: int, MANAGER: int, ...}}
        self._role_counters: Dict[str, Dict[str, int]] = {}

        # S37: 情绪倾向标注 (Sentiment) — 单条消息扫描情绪关键词:
        # 焦虑 / 困惑 / 期待 / 中性。提示 AI 镜像/缓冲适当情感语气。
        # 零成本(关键词匹配)。
        self.sentiment_enabled: bool = (
            os.environ.get("WEBRAIN_SENTIMENT_ENABLED", "1") != "0"
        )

        # S38: 多语种切换检测 (Lang Switch) — 比较当前消息与上一条用户消息的
        # 中文字符占比,若 >= 50% vs < 50% 视为语言切换,提示 AI 切换回复语言。
        # 零成本(字符分类计数)。
        self.lang_switch_enabled: bool = (
            os.environ.get("WEBRAIN_LANG_SWITCH_ENABLED", "1") != "0"
        )

        # S39: 任务清单化触发 (Task Listing) — 用户消息含 "列出/罗列/总结一下/
        # 做个清单/list/summarize" 等关键词时,提示 AI 把答案组织为 bullet/numbered
        # list 而非段落。零成本(关键词匹配)。
        self.task_listing_enabled: bool = (
            os.environ.get("WEBRAIN_TASK_LISTING_ENABLED", "1") != "0"
        )

        # S40: 输出格式偏好 (Output Format) — 跟踪本会话用户对"代码/表格/列表/
        # markdown/json" 的偏好关键词,累计后提示 AI 在模糊请求时倾向使用该格式。
        # 零成本(关键词计数)。
        self.output_format_enabled: bool = (
            os.environ.get("WEBRAIN_OUTPUT_FORMAT_ENABLED", "1") != "0"
        )
        # 会话级输出格式偏好 {session_id: {code: int, table: int, list: int, ...}}
        self._format_counters: Dict[str, Dict[str, int]] = {}

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
    def _fire_session_summarize_async(self, session_id: str) -> None:
        """Round M2 — when a session crosses a turn threshold, summarize
        the earliest L1 messages into one L2 entry so we never lose
        context but stop bloating per-session storage / retrieval.

        Background task — never blocks the chat reply. Errors are
        logged at WARN, never re-raised.
        """
        if not session_id:
            return
        # Threshold + retain window are env-tunable so tests can drop
        # them low without spending real LLM budget.
        try:
            threshold = int(os.environ.get("WEBRAIN_SESSION_SUMMARIZE_THRESHOLD", "30"))
            retain = int(os.environ.get("WEBRAIN_SESSION_SUMMARIZE_RETAIN", "10"))
        except ValueError:
            threshold, retain = 30, 10
        if threshold <= retain:
            # nonsensical config — bail rather than infinite-loop
            return

        async def _run() -> None:
            try:
                # Pull a generous history; only need L1 rows for this session.
                all_rows = await self.memory.get_session_memories(session_id, limit=500)
                l1 = [r for r in all_rows if r.get("level") == "L1"]
                if len(l1) < threshold:
                    return
                # Check if we already summarized recently — avoid re-running
                # every turn once we cross the threshold.
                # O3 hardening: parse covers_until out of the metadata JSON
                # instead of doing substring matches on the raw blob (which
                # broke as soon as any other field in metadata sorted before
                # the timestamp, causing duplicate summary stores).
                def _covers_until(row: Dict[str, Any]) -> str:
                    raw = row.get("metadata", "")
                    if not isinstance(raw, str) or not raw:
                        return ""
                    try:
                        meta = json.loads(raw)
                    except (TypeError, ValueError):
                        return ""
                    if not isinstance(meta, dict) or meta.get("kind") != "session-summary":
                        return ""
                    return str(meta.get("covers_until", ""))

                summaries = [r for r in all_rows if r.get("level") == "L2" and _covers_until(r)]
                # Sort L1 oldest-first for chronological summary.
                l1.sort(key=lambda r: r.get("created_at", ""))
                # We only summarize messages OLDER than the most recent
                # `retain` L1s. The retain window stays as raw L1 for
                # nuance + replayability.
                to_summarize = l1[:-retain]
                if not to_summarize:
                    return
                last_to_cover = to_summarize[-1].get("created_at", "")
                # Skip if a prior summary already covers up to (or past)
                # the last L1 we're about to summarize.
                if summaries and last_to_cover:
                    latest_cover = max(_covers_until(s) for s in summaries)
                    if latest_cover and latest_cover >= last_to_cover:
                        return
                # Build a compact prompt for the LLM. Truncate hard at 200
                # messages so the prompt itself doesn't blow up.
                chunk_text = "\n".join(
                    f"- {r.get('source','?')}: {(r.get('content','') or '')[:280]}"
                    for r in to_summarize[-200:]
                )
                messages = [
                    {
                        "role": "system",
                        "content": (
                            "你是会话摘要器。基于以下早期会话片段,写一段不超过 180 字的中文摘要,"
                            "保留:用户身份/偏好/正在做的事/关键决定/未解决的问题。"
                            "不要复述每条消息,提取核心。"
                        ),
                    },
                    {"role": "user", "content": chunk_text},
                ]
                result = await self._chat_completion(messages, max_tokens=512, temperature=0.3)
                choices = result.get("choices") or []
                content = ""
                if choices:
                    msg = choices[0].get("message", {})
                    content = (msg.get("content") or msg.get("reasoning_content") or "").strip()
                    # Strip <think>...</think> for reasoning models.
                    import re as _re
                    content = _re.sub(r"<think>[\s\S]*?</think>", "", content).strip()
                if not content:
                    logger.warning("session summarizer: empty content from LLM, skipping")
                    return
                covers_until = to_summarize[-1].get("created_at", "")
                await self.memory.store({
                    "level": "L2",
                    "content": f"会话摘要 ({len(to_summarize)} 条):{content}",
                    "session_id": session_id,
                    "source": "summarizer",
                    "metadata": json.dumps(
                        {"kind": "session-summary", "covers_until": covers_until, "count": len(to_summarize)}
                    ),
                })
                logger.info(
                    "[session-summarize] session=%s covered=%d retained=%d summary_chars=%d",
                    session_id, len(to_summarize), retain, len(content),
                )
            except Exception as exc:  # noqa: BLE001 — background must never crash chat
                logger.warning("session summarizer failed (session=%s): %s", session_id, exc)

        try:
            task = asyncio.create_task(_run())
        except RuntimeError:
            logger.debug("no running loop for session summarizer; skipping")
            return
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

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

    # ── Round N1 — embedding-based tool selection ────────────────────
    # Pre-computed tool-description embeddings. Lazy-built on first
    # filter() call; rebuilt whenever the tool registry changes (rare).
    # Stored as {tool_name: numpy.ndarray} so cosine compare is cheap.
    #
    # Round O3 hardening:
    #   - Was: sync method that called embedder.encode() directly on the
    #     event loop (CPU-bound, can block 100ms-30s cold).
    #     Now: async, all embedder.encode calls go through
    #     loop.run_in_executor(None, ...) per the project's hot-bug-#4
    #     pattern (see CLAUDE.md).
    #   - Was: class-level dict cache with no lock, racy across instances
    #     and across concurrent chat() calls.
    #     Now: instance-level cache + asyncio.Lock to serialize writes.
    _tool_embedding_cache: Dict[str, "Any"]  # type: ignore[name-defined]
    _tool_embedding_signature: str
    _tool_embedding_lock: "asyncio.Lock"

    async def _filter_tools_by_query(self, tools: List[Dict], user_query: str) -> List[Dict]:
        """Round N1 (hardened in O3) — narrow the tool list to the
        top-K most semantically relevant entries for the user query.

        Returns the full `tools` list unchanged when any of:
          - User query is empty / very short (< 2 chars)
          - sentence-transformers / embedder unavailable
          - Tool count already at-or-below the configured top-K
          - numpy import or cosine math fails for any reason

        Tunable via env `WEBRAIN_TOOL_SELECT_TOP_K` (default 8).
        Disabled entirely when env `WEBRAIN_TOOL_SELECT_DISABLED=1`.
        """
        if os.environ.get("WEBRAIN_TOOL_SELECT_DISABLED") == "1":
            return tools
        try:
            top_k = max(1, int(os.environ.get("WEBRAIN_TOOL_SELECT_TOP_K", "8")))
        except ValueError:
            top_k = 8
        if not tools or len(tools) <= top_k:
            return tools
        q = (user_query or "").strip()
        if len(q) < 2:
            return tools

        try:
            from memory.memory_manager import _get_embedder
            import numpy as np  # type: ignore[import-untyped]
            embedder = _get_embedder()
            if embedder is None:
                return tools

            # Cache invalidates if the set of tools changed (name + desc).
            sig = "|".join(
                sorted(
                    f"{t['function']['name']}:{t['function'].get('description', '')[:80]}"
                    for t in tools
                    if isinstance(t, dict) and t.get("type") == "function"
                )
            )

            loop = asyncio.get_event_loop()
            # Acquire the per-instance lock so concurrent chat() calls don't
            # race when filling or invalidating the cache.
            async with self._tool_embedding_lock:
                if sig != self._tool_embedding_signature:
                    self._tool_embedding_cache = {}
                    self._tool_embedding_signature = sig

                # Embed the user query OFF the event loop.
                q_vec_arr = await loop.run_in_executor(
                    None,
                    lambda: embedder.encode([q], convert_to_numpy=True, show_progress_bar=False),
                )
                q_vec = q_vec_arr[0]
                q_norm = float(np.linalg.norm(q_vec)) or 1.0

                to_embed_names: List[str] = []
                to_embed_texts: List[str] = []
                for t in tools:
                    fn = t.get("function") if isinstance(t, dict) else None
                    if not fn:
                        continue
                    name = fn.get("name", "")
                    if name not in self._tool_embedding_cache:
                        to_embed_names.append(name)
                        to_embed_texts.append(f"{name}: {fn.get('description', '')}")
                if to_embed_texts:
                    # Batch encode OFF the event loop.
                    vecs = await loop.run_in_executor(
                        None,
                        lambda: embedder.encode(
                            to_embed_texts, convert_to_numpy=True, show_progress_bar=False
                        ),
                    )
                    for n, v in zip(to_embed_names, vecs):
                        self._tool_embedding_cache[n] = v

                # Score under the lock too — cheap (NumPy dot products) and
                # ensures the cache snapshot we read is consistent.
                scored: List[Tuple[float, Dict]] = []
                for t in tools:
                    fn = t.get("function", {})
                    name = fn.get("name", "")
                    v = self._tool_embedding_cache.get(name)
                    if v is None:
                        # Couldn't embed this one — give it a neutral score
                        # so it's not unfairly dropped.
                        scored.append((0.0, t))
                        continue
                    v_norm = float(np.linalg.norm(v)) or 1.0
                    cos = float(np.dot(q_vec, v) / (q_norm * v_norm))
                    scored.append((cos, t))

            scored.sort(key=lambda pair: pair[0], reverse=True)
            return [t for _score, t in scored[:top_k]]
        except Exception as exc:  # noqa: BLE001 — embedding is opportunistic
            logger.warning("tool selection by embedding failed; using full list: %s", exc)
            return tools

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

    async def _load_conversation_anchor(self, session_id: str, user_message: str) -> str:
        """S10: 会话锚点 — 新会话首条消息时检索近期相关 L2 对话摘要，注入系统提示。

        只在当前进程中首次见到该 session_id 时触发（一次性，后续消息走 S3 工作记忆）。
        失败时静默降级，返回空字符串，不影响正常对话。
        """
        if not self.conv_anchor_enabled:
            return ""
        if session_id in self._anchored_sessions:
            return ""  # 已激活的会话：跳过
        # 无论是否找到相关摘要，都将本 session 标记为"已激活"
        self._anchored_sessions.add(session_id)
        if not user_message.strip():
            return ""
        try:
            from datetime import datetime, timezone, timedelta
            cutoff = (datetime.now(timezone.utc) - timedelta(days=self.conv_anchor_days)).isoformat()
            results = await self.memory.query({
                "query": user_message,
                "levels": ["L2"],
                "limit": self.conv_anchor_top_k + 3,  # 过取后过滤日期
                "use_rerank": False,
            })
            # 过滤 cutoff 之内的摘要（memory.query 本身不支持日期过滤）
            recent = [
                r for r in results
                if (r.get("created_at") or "") >= cutoff
            ][:self.conv_anchor_top_k]
            if not recent:
                return ""
            lines = ["[近期相关对话摘要]"]
            for r in recent:
                content = (r.get("content") or "").strip()
                ts = (r.get("created_at") or "")[:10]  # 只保留日期部分
                if content:
                    lines.append(f"- ({ts}) {content[:200]}")  # 截断超长摘要
            return "\n".join(lines) if len(lines) > 1 else ""
        except Exception as e:
            logger.debug("[ChatEngine/S10] 会话锚点加载失败（非致命）: %s", e)
            return ""

    async def _get_l4_anchors(self) -> List[Dict]:
        """S13: L4 身份锚点 — 检索 importance 最高的 L4 记忆，强制注入对话上下文。

        失败时静默降级返回空列表，不影响正常对话流程。
        """
        if not self.l4_anchor_enabled:
            return []
        try:
            return await self.memory.get_top_l4(limit=self.l4_anchor_top_k)
        except Exception as e:
            logger.debug("[ChatEngine/S13] L4 锚点加载失败（非致命）: %s", e)
            return []

    def _get_temporal_context_line(self) -> str:
        """S14: 时态上下文注入 — 返回当前日期、星期、时间的单行标注。

        注入每次对话系统提示，使 AI 具备时态感知能力，能正确回答
        "今天是几号"、"这周的规划" 等时态相关问题。
        功能关闭时返回空字符串，调用方无需额外判断。
        """
        if not self.temporal_context_enabled:
            return ""
        from datetime import datetime
        now = datetime.now()
        weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
        weekday = weekdays[now.weekday()]
        return f"[当前时间: {now.strftime('%Y-%m-%d')} {weekday} {now.strftime('%H:%M')}]"

    def _format_tiered_memory_text(self, relevant: List[Dict]) -> str:
        """S12: 分层记忆展示 — 将记忆结果按重要性分为已验证事实/近期对话片段两组。

        当 mem_tiered_enabled=False 时，退回到扁平格式（与 S12 前行为一致）。
        两组均为空时返回空字符串（调用方需处理 '无相关记忆' 回落）。
        """
        if not relevant:
            return ""
        if not self.mem_tiered_enabled:
            # 降级：扁平格式
            return "\n".join(f"- {m.get('content', '')}" for m in relevant if m.get("content"))

        validated = [m for m in relevant if (m.get("importance") or 0.0) >= self.mem_confidence_threshold]
        raw = [m for m in relevant if (m.get("importance") or 0.0) < self.mem_confidence_threshold]

        parts: List[str] = []
        # 先收集各组有内容的行；仅当存在实际内容时才追加区块标题，
        # 避免产生标题后无条目的孤立区块（HIGH fix）。
        validated_lines = [f"- {m.get('content', '')}" for m in validated if m.get("content")]
        if validated_lines:
            parts.append("[已验证事实]")
            parts.extend(validated_lines)
        raw_lines = [f"- {m.get('content', '')}" for m in raw if m.get("content")]
        if raw_lines:
            parts.append("[近期对话片段]")
            parts.extend(raw_lines)
        return "\n".join(parts)

    def _compute_memory_confidence_line(self, relevant: List[Dict]) -> str:
        """S11: 记忆置信度标注 — 统计已验证事实数量，返回单行元信号。

        调用方将此行追加到 memory_text 末尾。当无相关记忆或功能关闭时返回空字符串。
        置信度级别（基于已验证事实占比）：
          - 高: validated ≥ 2
          - 中: validated == 1
          - 低: validated == 0（有相关记忆但均为 L1/L2 原始片段）
        """
        if not self.mem_confidence_enabled or not relevant:
            return ""
        total = len(relevant)
        validated = sum(
            1 for m in relevant
            if (m.get("importance") or 0.0) >= self.mem_confidence_threshold
        )
        if validated >= 2:
            level = "高"
        elif validated == 1:
            level = "中"
        else:
            level = "低"
        return f"[记忆支撑: {total} 条相关 · 其中 {validated} 条已验证事实 · 置信度: {level}]"

    def _compute_memory_freshness_line(self, relevant: List[Dict]) -> str:
        """S15: 记忆时效信号 — 基于 created_at 字段计算记忆平均新鲜度，返回单行元信号。

        与 S11 置信度互补：S11 衡量记忆的"固化程度"（importance），S15 衡量
        记忆的"时效性"（创建时间距今）。两者组合给 AI 完整的可信度画面：
          - 高: 多数记忆在 fresh_days 内创建
          - 中: 多数记忆在 stale_days 内创建
          - 低: 多数记忆超过 stale_days
        missing created_at 按最大时效（stale）处理，鼓励 AI 谨慎对待无时间戳记忆。
        """
        if not self.mem_freshness_enabled or not relevant:
            return ""
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        ages_days: List[float] = []
        valid_ts_count: int = 0  # 有效时间戳计数（区别于无时间戳的兜底值）
        for m in relevant:
            created_raw = m.get("created_at")
            if not created_raw:
                # 无时间戳 → 按最大陈旧度兜底，但不计入有效计数。
                # 场景：S13 注入的 L4 锚定记忆可能无 created_at，不应将其标记为"时效低"。
                ages_days.append(float(self.mem_freshness_stale_days + 1))
                continue
            try:
                # 支持 ISO 8601 格式（带/不带时区）
                ts_str = str(created_raw)
                if ts_str.endswith("Z"):
                    ts_str = ts_str[:-1] + "+00:00"
                created_dt = datetime.fromisoformat(ts_str)
                if created_dt.tzinfo is None:
                    created_dt = created_dt.replace(tzinfo=timezone.utc)
                age = (now - created_dt).total_seconds() / 86400  # 转为天数
                ages_days.append(max(0.0, age))
                valid_ts_count += 1
            except (ValueError, TypeError):
                ages_days.append(float(self.mem_freshness_stale_days + 1))

        # 如果全部为无效时间戳（如纯 L4 锚定条目），跳过信号以免误导 AI
        if valid_ts_count == 0:
            return ""
        avg_age = sum(ages_days) / len(ages_days)
        # 使用严格小于（<）避免浮点边界歧义；边界值归入更保守的级别。
        if avg_age < self.mem_freshness_fresh_days:
            level = "高"
        elif avg_age < self.mem_freshness_stale_days:
            level = "中"
        else:
            level = "低"
        return f"[记忆时效: {level}（平均 {avg_age:.0f} 天前）]"

    def _compute_memory_source_diversity_line(self, relevant: List[Dict]) -> str:
        """S19: 记忆来源多样性信号 — 分析 relevant 的 L3/L4 vs L1/L2 分布，返回单行标签。

        根据 importance 阈值（与 S11/S12 共用 mem_confidence_threshold）将记忆分为：
          - 已验证事实（L3/L4）：importance >= threshold（默认 0.7）
          - 近期片段（L1/L2）：importance < threshold

        输出格式举例：
            [记忆来源: 已验证事实主导(3/3条) — 可直接引用]
            [记忆来源: 近期片段主导(3/3条未验证) — 置信度低，引用时请说明不确定性]
            [记忆来源: 混合来源(已验证 2条 · 近期片段 1条) — 优先引用已验证事实]
            [记忆来源: 混合来源(已验证 1条 · 近期片段 2条) — 已验证事实较少，引用时注意置信度差异]

        与 S11 置信度聚合互补：S11 给整体评级（高/中/低），S19 给条数拆解。
        功能关闭或 relevant 为空时返回空字符串。

        Args:
            relevant: 从记忆库检索到的记忆记录列表。

        Returns:
            格式化的单行来源多样性标签（不含换行符），或空字符串（禁用 / 无记忆时）。
        """
        if not self.mem_source_diversity_enabled or not relevant:
            return ""

        total = len(relevant)
        validated = sum(
            1 for m in relevant
            if (m.get("importance") or 0.0) >= self.mem_confidence_threshold
        )
        raw_count = total - validated

        if validated == total:
            return f"[记忆来源: 已验证事实主导({validated}/{total}条) — 可直接引用]"
        elif validated == 0:
            return (
                f"[记忆来源: 近期片段主导({total}/{total}条未验证) — "
                f"置信度低，引用时请说明不确定性]"
            )
        else:
            # 已验证比例 >= 50% → 正面引导；< 50% → 谨慎引导
            if validated / total >= 0.5:
                advice = "优先引用已验证事实"
            else:
                advice = "已验证事实较少，引用时注意置信度差异"
            return (
                f"[记忆来源: 混合来源(已验证 {validated}条 · 近期片段 {raw_count}条) — {advice}]"
            )

    def _compute_memory_adequacy_line(
        self, relevant: List[Dict], intent: str
    ) -> str:
        """S20: 记忆充分性信号 — 基于 S18 意图 + validated 条数生成行为指令。

        与 S11 / S19 互补:
            S11 聚合评级(高/中/低), S19 条数拆解, S20 给"在这个意图下该怎么做"。

        意图分支:
            PERSONAL_RECALL — 看已验证(importance >= threshold)条数
                validated >= 2 → "充足 — 可自信回答 / 有据可查"
                validated == 1 → "有限 — 据我所知"
                validated == 0 → "不足 — 主动确认/询问关键信息"
            TEMPORAL_RECALL — 只看总条数(时序重建依赖事件密度,与置信度无关)
                total >= 2 → "充足(共 N 条历史记录)"
                total == 1 → "有限 — 时序重建可能不完整"
            GENERAL / TASK_ASSIST → 不注入(返回空字符串)

        Args:
            relevant: 从记忆库检索到的记忆记录列表(每条 dict 含 importance)。
            intent: S18 _classify_query_intent 的返回值。

        Returns:
            形如 "[记忆充分性: <verdict> — <action_hint>]" 的紧凑单行
            (无换行,< 100 字符), 或空字符串(禁用/relevant 空/非个人或时序意图)。
        """
        if not self.mem_adequacy_enabled or not relevant:
            return ""
        if intent not in ("PERSONAL_RECALL", "TEMPORAL_RECALL"):
            return ""

        if intent == "PERSONAL_RECALL":
            validated = sum(
                1
                for m in relevant
                if (m.get("importance") or 0.0) >= self.mem_confidence_threshold
            )
            if validated >= 2:
                return "[记忆充分性: 充足 — 已验证事实可自信回答,有据可查]"
            if validated == 1:
                return (
                    "[记忆充分性: 有限 — 仅 1 条已验证事实,"
                    "建议用\"据我所知\"等限定语回答]"
                )
            # validated == 0
            return (
                "[记忆充分性: 不足 — 无已验证事实,"
                "建议主动确认或询问关键信息]"
            )

        # intent == "TEMPORAL_RECALL"
        total = len(relevant)
        if total >= 2:
            return f"[记忆充分性: 充足(共 {total} 条历史记录) — 可整合时序脉络]"
        # total == 1 (total == 0 已被上面 not relevant 兜底)
        return "[记忆充分性: 有限 — 仅 1 条历史记录,时序重建可能不完整]"

    # ── S21: Entity Spotlight ───────────────────────────────────────────
    def _compute_entity_spotlight_line(self, user_message: str) -> str:
        """S21: 实体关注度信号 — 检测 user message 命中的 KG 实体,生成
        单行 `[本轮关注实体: A, B, C]`,让 AI 显式知道本轮谈的是哪些已知实体。

        与 S9 KG 上下文注入互补:S9 注入实体详细信息到系统提示顶部,
        S21 在 memory block 末尾点名"焦点"。失败开放(KG 缺失/空/异常
        返回 "")。零成本(子串匹配)。
        """
        if not self.entity_spotlight_enabled or not self.kg:
            return ""
        if not user_message or not user_message.strip():
            return ""
        try:
            entities = self.kg.search(
                user_message, limit=self.entity_spotlight_top_k
            )
            if not entities:
                return ""
            names = [e.get("name", "") for e in entities if e.get("name")]
            names = [n for n in names if n][: self.entity_spotlight_top_k]
            if not names:
                return ""
            return f"[本轮关注实体: {', '.join(names)} — 用户正讨论这些已有实体]"
        except Exception:  # pragma: no cover — defensive
            return ""

    # ── S22: Conversation Topic Classifier ──────────────────────────────
    # Topic categories ordered by precedence — first match wins.
    _TOPIC_PATTERNS = (
        (
            "CODING",
            r"(代码|程序|编程|函数|class\b|def\b|import\b|bug|debug|"
            r"python|javascript|typescript|rust|go\b|java\b|c\+\+|"
            r"react|vue|sql|api|server|前端|后端|测试|repo|git|"
            r"npm|pip|cargo|docker|kubernetes)",
        ),
        (
            "WRITING",
            r"(写[一份篇个文]|撰写|草拟|起草|文案|文章|博客|论文|"
            r"报告|邮件|信件|演讲|总结一下|改写|润色|翻译)",
        ),
        (
            "LEARNING",
            r"(为什么|什么是|解释|原理|怎么理解|区别|不同|"
            r"对比|教我|学习|教程|入门|how does|explain|"
            r"why does|the difference)",
        ),
        (
            "WORK",
            r"(项目|计划|任务|会议|deadline|安排|工时|"
            r"日程|进度|审批|流程|kpi|okr|周报|月报)",
        ),
        (
            "LIFE",
            r"(吃[什啥]|去[哪那]|出行|旅行|健康|睡眠|运动|"
            r"心情|天气|食谱|菜谱|购物|价格|预算)",
        ),
    )

    def _classify_conversation_topic(self, user_message: str) -> str:
        """S22: 主题分类 — 纯关键词,返回 CODING/WRITING/LEARNING/WORK/LIFE/GENERAL。"""
        if not self.topic_classifier_enabled or not user_message:
            return "GENERAL"
        msg = user_message.lower()
        for topic, pattern in self._TOPIC_PATTERNS:
            if re.search(pattern, msg, re.IGNORECASE):
                return topic
        return "GENERAL"

    def _get_topic_hint(self, topic: str) -> str:
        """S22: 根据主题分类返回单行行为提示。"""
        if not self.topic_classifier_enabled or topic == "GENERAL":
            return ""
        hints = {
            "CODING": (
                "[主题: 编程 — 给出可执行代码;注释要简洁;"
                "如需 import 写完整;假设默认环境是 Python 3.11+/Node 22+]"
            ),
            "WRITING": (
                "[主题: 写作 — 给出完整文本而不是大纲;"
                "若用户给了片段或要求改写,保留原作者风格]"
            ),
            "LEARNING": (
                "[主题: 学习/解释 — 先给一句直接结论,再展开原理;"
                "举一个具体例子;避免空洞抽象]"
            ),
            "WORK": (
                "[主题: 工作 — 给出可立即执行的下一步;"
                "如涉及多人协作,标明 owner 和 ETA]"
            ),
            "LIFE": (
                "[主题: 生活 — 给出实用建议,避免说教;"
                "如涉及偏好,询问用户而非默认]"
            ),
        }
        return hints.get(topic, "")

    # ── S23: Conversation Coherence ─────────────────────────────────────
    async def _compute_coherence_line(
        self, session_id: str, user_message: str
    ) -> str:
        """S23: 对话连贯性 — embedding 比对当前 vs 上轮 user message。"""
        if not self.coherence_enabled or not user_message.strip():
            return ""
        # 没有 memory manager 就无法访问 embedder
        if not self.memory or not hasattr(self.memory, "_get_embedder"):
            return ""
        try:
            embedder = self.memory._get_embedder()
            if embedder is None:
                return ""
            loop = asyncio.get_event_loop()
            current_vec = await loop.run_in_executor(
                None, lambda: embedder.encode([user_message], show_progress_bar=False)[0]
            )
            last_vec = self._last_user_embedding.get(session_id)
            # 记下本轮 embedding 给下轮用,然后看是否能比对上轮
            self._last_user_embedding[session_id] = current_vec
            if last_vec is None:
                return ""
            # 余弦相似度
            import numpy as np  # local import to avoid global cost
            cur = np.asarray(current_vec, dtype=float)
            prev = np.asarray(last_vec, dtype=float)
            denom = (float(np.linalg.norm(cur)) * float(np.linalg.norm(prev))) or 1.0
            sim = float(np.dot(cur, prev) / denom)
            if sim >= self.coherence_high_threshold:
                return "[对话连贯: 本轮与上文紧扣 — 可延续上下文语境]"
            if sim <= self.coherence_low_threshold:
                return (
                    "[话题切换: 用户跳到了新话题 — "
                    "请主动确认转向,不要套用上文语境]"
                )
            return ""  # 中间区间不注入,避免噪音
        except Exception:  # pragma: no cover
            return ""

    # ── S24: Hot Memory Highlight ───────────────────────────────────────
    def _annotate_hot_memories(
        self, session_id: str, relevant: List[Dict]
    ) -> List[Dict]:
        """S24: 给本会话内重复命中 >= threshold 次的 memory 加 `[高频]` 前缀。

        返回 *新的* relevant 列表,不修改输入。每条 dict 加 `hot: bool` 字段
        让下游格式化代码可读取。增加 hit count 是 side-effect — 调用方
        每轮触发一次。
        """
        if not self.hot_memory_enabled or not relevant:
            return relevant
        try:
            counter = self._memory_hit_counter.setdefault(session_id, {})
            out: List[Dict] = []
            for m in relevant:
                mid = m.get("id") or m.get("memory_id") or m.get("hash")
                if mid is None:
                    out.append(m)
                    continue
                counter[mid] = counter.get(mid, 0) + 1
                hot = counter[mid] >= self.hot_memory_threshold
                if hot:
                    out.append({**m, "hot": True})
                else:
                    out.append(m)
            return out
        except Exception:  # pragma: no cover
            return relevant

    def _compute_hot_memory_line(self, relevant: List[Dict]) -> str:
        """S24: 总结本轮有多少 hot 项 — 单行 hint。"""
        if not self.hot_memory_enabled or not relevant:
            return ""
        hot_count = sum(1 for m in relevant if m.get("hot"))
        if hot_count == 0:
            return ""
        return (
            f"[高频引用: 本轮含 {hot_count} 条反复出现的记忆 — "
            f"这些是用户最在意的事实]"
        )

    # ── S25: User Cadence ───────────────────────────────────────────────
    def _record_cadence_tick(self, session_id: str) -> None:
        """S25: 在每次 chat() 入口调用,记录当前时间戳到会话历史(末 5 条)。"""
        if not self.cadence_enabled:
            return
        ts_list = self._cadence_timestamps.setdefault(session_id, [])
        ts_list.append(time.time())
        # 仅保留最近 5 条以避免内存增长
        if len(ts_list) > 5:
            del ts_list[: len(ts_list) - 5]

    def _compute_cadence_line(self, session_id: str) -> str:
        """S25: 基于近期消息间隔推断节律 — 快速/常规/慢思考。"""
        if not self.cadence_enabled:
            return ""
        ts_list = self._cadence_timestamps.get(session_id, [])
        if len(ts_list) < 2:
            return ""
        # 平均消息间隔(秒)
        deltas = [ts_list[i + 1] - ts_list[i] for i in range(len(ts_list) - 1)]
        if not deltas:
            return ""
        avg = sum(deltas) / len(deltas)
        if avg < 60:
            return "[用户节律: 快速对话 — 回复尽量简短,直击要点]"
        if avg > 300:
            return "[用户节律: 慢思考 — 可详尽展开,提供更多背景]"
        return ""  # 常规节律不注入

    # ── S26: Turn Depth ─────────────────────────────────────────────────
    def _record_turn(self, session_id: str) -> None:
        """S26: 在每次 chat() 入口调用,会话回合数 +1。"""
        if not self.turn_depth_enabled:
            return
        self._turn_counters[session_id] = self._turn_counters.get(session_id, 0) + 1

    def _compute_turn_depth_line(self, session_id: str) -> str:
        """S26: 给出当前会话深度的行为提示。"""
        if not self.turn_depth_enabled:
            return ""
        depth = self._turn_counters.get(session_id, 0)
        if depth <= 1:
            return ""  # 首轮不注入,避免干扰开放性
        if depth >= 8:
            return (
                f"[对话回合: 第 {depth} 轮(深对话) — "
                f"注意与前文一致性,避免反复或矛盾]"
            )
        if depth >= 4:
            return f"[对话回合: 第 {depth} 轮(中度) — 可引用前文已建立的事实]"
        return ""

    # ── S27: Memory Staleness Alert ─────────────────────────────────────
    def _compute_staleness_alert_line(self, relevant: List[Dict]) -> str:
        """S27: 若 relevant 中某条记忆 > staleness_alert_days 天前,告警。"""
        if not self.staleness_alert_enabled or not relevant:
            return ""
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        old_count = 0
        oldest_days = 0
        for m in relevant:
            ts_raw = m.get("created_at") or m.get("timestamp")
            if not ts_raw:
                continue
            try:
                if isinstance(ts_raw, (int, float)):
                    ts = datetime.fromtimestamp(float(ts_raw), tz=timezone.utc)
                else:
                    s = str(ts_raw).replace("Z", "+00:00")
                    ts = datetime.fromisoformat(s)
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                days_old = (now - ts).days
                if days_old > self.staleness_alert_days:
                    old_count += 1
                    oldest_days = max(oldest_days, days_old)
            except (ValueError, TypeError, OSError):
                continue
        if old_count == 0:
            return ""
        return (
            f"[陈旧记忆告警: {old_count} 条已 {oldest_days}+ 天前 — "
            f"引用时需向用户说明时效]"
        )

    # ── S28: User Expertise Inference ───────────────────────────────────
    _EXPERT_TERMS = re.compile(
        r"(async|await|generator|decorator|trait|borrow|monad|"
        r"协程|闭包|装饰器|尾递归|多态|大端|位运算|"
        r"o\(n\)|amortized|race condition|deadlock|sigterm|"
        r"throughput|p95|p99|otel|opentelemetry|sli|slo)",
        re.IGNORECASE,
    )
    _NOVICE_PHRASES = re.compile(
        r"(什么是|怎么读|怎么写|新手|入门|不懂|不明白|为什么这样|"
        r"小白|不会|帮我看看|教我|从零开始|first time|noob)",
        re.IGNORECASE,
    )

    def _record_expertise_signal(self, session_id: str, user_message: str) -> None:
        """S28: 扫描 user message 找专家/新手信号,累加会话 counter。"""
        if not self.expertise_enabled or not user_message:
            return
        counters = self._expertise_counters.setdefault(
            session_id, {"expert_hits": 0, "novice_hits": 0}
        )
        if self._EXPERT_TERMS.search(user_message):
            counters["expert_hits"] += 1
        if self._NOVICE_PHRASES.search(user_message):
            counters["novice_hits"] += 1

    def _compute_expertise_line(self, session_id: str) -> str:
        """S28: 基于会话累积信号推断 NOVICE / INTERMEDIATE / EXPERT。"""
        if not self.expertise_enabled:
            return ""
        c = self._expertise_counters.get(session_id, {})
        expert = c.get("expert_hits", 0)
        novice = c.get("novice_hits", 0)
        # 需要至少 2 个证据才下结论,避免首轮误判
        if expert + novice < 2:
            return ""
        if expert >= novice * 2 and expert >= 2:
            return (
                "[用户级别: EXPERT — 跳过基础解释,"
                "直接给代码/术语;假设熟悉常见 idiom]"
            )
        if novice >= expert * 2 and novice >= 2:
            return (
                "[用户级别: NOVICE — 多用比喻和具体例子;"
                "避免生僻术语,需要时先解释术语]"
            )
        return ""  # INTERMEDIATE 不注入(默认行为)

    # ── S29: Response Length Hint ───────────────────────────────────────
    def _compute_length_hint_line(
        self, session_id: str, topic: str
    ) -> str:
        """S29: 综合 S22 主题 + S25 节律 + S26 深度,给响应长度建议。"""
        if not self.length_hint_enabled:
            return ""
        depth = self._turn_counters.get(session_id, 0)
        ts_list = self._cadence_timestamps.get(session_id, [])
        avg_gap = 0.0
        if len(ts_list) >= 2:
            deltas = [ts_list[i + 1] - ts_list[i] for i in range(len(ts_list) - 1)]
            avg_gap = sum(deltas) / max(1, len(deltas))
        # 决策规则:
        # - 快速节律(<60s) 或 深对话(>=8) → 精简
        # - LEARNING 主题 + 慢思考(>300s) → 详尽
        # - 其他 → 不注入(常规)
        if avg_gap > 0 and avg_gap < 60:
            return "[响应长度: 精简 — 用户在快速对话,< 150 字直击要点]"
        if depth >= 8:
            return "[响应长度: 精简 — 深对话已建立上下文,无需重复铺垫]"
        if topic == "LEARNING" and avg_gap > 300:
            return "[响应长度: 详尽 — 用户在慢思考学习,展开原理 + 例子 + 注意事项]"
        return ""

    # ── S30: Tool Call Frequency ────────────────────────────────────────
    def _record_tool_call(self, session_id: str) -> None:
        """S30: 每次 chat() 触发 tool_call 时调用,累计会话计数。"""
        if not self.tool_freq_enabled:
            return
        self._tool_call_counters[session_id] = (
            self._tool_call_counters.get(session_id, 0) + 1
        )

    def _compute_tool_freq_line(self, session_id: str) -> str:
        """S30: 若 tool call 已超阈值,提示 AI 收敛到结论。"""
        if not self.tool_freq_enabled:
            return ""
        n = self._tool_call_counters.get(session_id, 0)
        if n < self.tool_freq_threshold:
            return ""
        return (
            f"[工具调用提醒: 本会话已调用 {n} 次工具,"
            f"考虑直接给出结论而非继续探索]"
        )

    # ── S31: Conversation Pace Switch ───────────────────────────────────
    def _record_pace_sample(self, session_id: str, user_message: str) -> None:
        """S31: 在 chat() 入口记录本条消息字数,维护滑动窗口(最多 6 条)。"""
        if not self.pace_switch_enabled or not user_message:
            return
        history = self._pace_history.setdefault(session_id, [])
        history.append(len(user_message))
        if len(history) > 6:
            del history[0 : len(history) - 6]

    def _compute_pace_switch_line(self, session_id: str) -> str:
        """S31: 比较最近 3 条 vs 之前 3 条均长,若发生显著切换则提示。

        切换判定:
          深度切换 (短 → 长): recent_avg >= 2.0 * prior_avg AND recent_avg >= 60
          快速切换 (长 → 短): prior_avg >= 2.0 * recent_avg AND prior_avg >= 60
        """
        if not self.pace_switch_enabled:
            return ""
        history = self._pace_history.get(session_id, [])
        if len(history) < 6:
            return ""
        prior = history[-6:-3]
        recent = history[-3:]
        prior_avg = sum(prior) / 3
        recent_avg = sum(recent) / 3
        # 深度切换:用户开始展开详细问题
        if recent_avg >= 60 and recent_avg >= 2.0 * max(prior_avg, 1):
            return (
                f"[对话节奏: 用户已切换到深度模式(均字数 {int(prior_avg)}→{int(recent_avg)}),"
                f"建议展开详细分析]"
            )
        # 快速切换:用户开始追问简短问题
        if prior_avg >= 60 and prior_avg >= 2.0 * max(recent_avg, 1):
            return (
                f"[对话节奏: 用户已切换到快速问答(均字数 {int(prior_avg)}→{int(recent_avg)}),"
                f"建议精简回答]"
            )
        return ""

    # ── S32: Repeat Question Detection ──────────────────────────────────
    @staticmethod
    def _char_trigrams(text: str) -> set:
        """生成字符 3-gram 集合用于 Jaccard 相似度。"""
        if not text or len(text) < 3:
            # 短文本直接降为单字符集合
            return set(text) if text else set()
        return {text[i : i + 3] for i in range(len(text) - 2)}

    def _record_user_message(self, session_id: str, user_message: str) -> None:
        """S32: 在 chat() 入口记录本条 user 消息,维护滑动窗口(最多 5 条)。

        注意:必须在 _compute_repeat_question_line 之后调用以避免自匹配。
        """
        if not self.repeat_question_enabled or not user_message:
            return
        history = self._user_msg_history.setdefault(session_id, [])
        history.append(user_message)
        if len(history) > 5:
            del history[0 : len(history) - 5]

    def _compute_repeat_question_line(
        self, session_id: str, user_message: str
    ) -> str:
        """S32: 若当前消息与近 5 条用户消息任一 Jaccard 重合 >= 阈值,标记重复。"""
        if not self.repeat_question_enabled or not user_message:
            return ""
        history = self._user_msg_history.get(session_id, [])
        if not history:
            return ""
        current_tri = self._char_trigrams(user_message)
        if not current_tri:
            return ""
        for prev in history:
            prev_tri = self._char_trigrams(prev)
            if not prev_tri:
                continue
            inter = len(current_tri & prev_tri)
            union = len(current_tri | prev_tri)
            if union == 0:
                continue
            jaccard = inter / union
            if jaccard >= self.repeat_question_threshold:
                return (
                    "[重复询问检测: 用户在重复类似问题(与上轮重合度高),"
                    "上次回答可能未解决问题,建议换角度或更具体回答]"
                )
        return ""

    # ── S33: Time-of-day Behavior ───────────────────────────────────────
    def _compute_time_of_day_line(self) -> str:
        """S33: 基于当前小时返回时段语气提示。

        深夜 (0-5 时):简洁友好优先
        晚间 (22-23 时):语气可更轻松
        其他时段:不注入
        """
        if not self.time_of_day_enabled:
            return ""
        from datetime import datetime

        hour = datetime.now().hour
        if 0 <= hour < 6:
            return (
                "[时段提示: 当前为深夜时段(可能用户疲惫),"
                "请使用简洁友好且降低认知负荷的语言]"
            )
        if 22 <= hour <= 23:
            return "[时段提示: 当前为夜间时段,语气可更轻松自然]"
        return ""

    # ── S34: Context Drop on Short Message ──────────────────────────────
    def _compute_context_drop_line(
        self, session_id: str, user_message: str
    ) -> str:
        """S34: 若消息很短且缺乏指代,在已有历史时提示上下文不完整。

        触发条件:
          - 消息非空且字符数 <= context_drop_max_chars
          - 不包含任何代词("我/你/这/那/它/他/她/我的/你的")
          - 本会话已有 >= 2 条历史
        """
        if not self.context_drop_enabled or not user_message:
            return ""
        stripped = user_message.strip()
        if len(stripped) > self.context_drop_max_chars or len(stripped) == 0:
            return ""
        pronouns = ["我", "你", "这", "那", "它", "他", "她", "i ", "you", "this", "that", "it"]
        lower = stripped.lower()
        if any(p in lower for p in pronouns):
            return ""
        # 检查本会话用户历史(S32 维护的 _user_msg_history)
        history = self._user_msg_history.get(session_id, [])
        if len(history) < 2:
            return ""
        return (
            "[上下文不完整: 用户当前消息非常简短且缺乏指代,"
            "建议联系历史推断意图或主动询问澄清]"
        )

    # ── S35: Negative Feedback Detection ────────────────────────────────
    def _compute_negative_feedback_line(self, user_message: str) -> str:
        """S35: 扫描失败/不满意关键词,触发后提示彻底重新理解需求。

        触发关键词(中文 + 部分英文):不对/错了/不是这样/你没明白/弄错/搞错/
        没听懂/不是我想要的/wrong/again/no that's not。
        匹配采用精确子串(全部小写比较),确保高召回低误报。
        """
        if not self.negative_feedback_enabled or not user_message:
            return ""
        lower = user_message.lower()
        keywords = [
            "不对",
            "错了",
            "不是这样",
            "你没明白",
            "弄错",
            "搞错",
            "没听懂",
            "理解错",
            "不是我想要的",
            "我不是这个意思",
            "wrong",
            "that's not what",
            "you misunderstood",
            "no that's not",
        ]
        for kw in keywords:
            if kw in lower:
                return (
                    "[反馈识别: 用户对上一回答不满意,"
                    "请彻底重新理解需求,避免重复相同思路]"
                )
        return ""

    # ── S36: User Role Inference ────────────────────────────────────────
    # 角色关键词字典 — 类级常量,避免每次调用重建。
    _ROLE_KEYWORDS: Dict[str, List[str]] = {
        "DEVELOPER": [
            "代码", "api", "函数", "git", "部署", "debug", "调试",
            "接口", "类", "方法", "异常", "重构", "测试", "ci",
            "数据库", "sql", "json", "性能", "并发", "线程",
        ],
        "MANAGER": [
            "团队", "流程", "进度", "汇报", "绩效", "资源",
            "优先级", "计划", "kpi", "okr", "战略", "管理",
            "协调", "决策", "目标", "里程碑",
        ],
        "STUDENT": [
            "学习", "作业", "考试", "老师", "笔记", "复习", "不懂",
            "题目", "课程", "教材", "提交", "毕业", "成绩",
            "怎么做", "教教我",
        ],
        "CREATOR": [
            "设计", "创作", "文案", "灵感", "作品", "构思", "审美",
            "排版", "色彩", "插画", "视频剪辑", "脚本", "标题",
            "品牌", "营销文案",
        ],
    }

    def _record_role_signal(self, session_id: str, user_message: str) -> None:
        """S36: 在 chat() 入口扫描关键词,累加角色计数器。"""
        if not self.role_inference_enabled or not user_message:
            return
        lower = user_message.lower()
        counters = self._role_counters.setdefault(
            session_id, {k: 0 for k in self._ROLE_KEYWORDS}
        )
        for role, kws in self._ROLE_KEYWORDS.items():
            for kw in kws:
                if kw in lower:
                    counters[role] = counters.get(role, 0) + 1

    def _compute_role_inference_line(self, session_id: str) -> str:
        """S36: 基于累积信号推断主要身份,返回行为提示。

        最高分必须 >= min_signals 且 >= 第二名 2 倍才确定角色,
        否则视为 GENERAL 不注入。
        """
        if not self.role_inference_enabled:
            return ""
        c = self._role_counters.get(session_id, {})
        if not c:
            return ""
        sorted_roles = sorted(c.items(), key=lambda x: -x[1])
        top_role, top_score = sorted_roles[0]
        if top_score < self.role_inference_min_signals:
            return ""
        # 至少比第二名高 2 倍才算明显
        second_score = sorted_roles[1][1] if len(sorted_roles) > 1 else 0
        if top_score < 2 * max(second_score, 1):
            return ""
        hints = {
            "DEVELOPER": "技术深入,可使用代码块和精确技术术语",
            "MANAGER": "聚焦目标价值与决策影响,避免过深技术细节",
            "STUDENT": "解释概念时多举例,使用循序渐进结构",
            "CREATOR": "保持启发性语言,留有创作发挥空间",
        }
        hint = hints.get(top_role, "")
        return f"[角色推断: {top_role}({top_score} 个累积信号) — {hint}]"

    # ── S37: Sentiment Tracking ─────────────────────────────────────────
    _SENTIMENT_KEYWORDS: Dict[str, List[str]] = {
        "ANXIOUS": [
            "急", "着急", "赶", "来不及", "快点", "紧急", "紧迫", "马上",
            "deadline", "asap", "urgent",
        ],
        "CONFUSED": [
            "?", "？", "不懂", "迷糊", "搞不清", "不明白", "云里雾里",
            "wtf", "wait", "??",
        ],
        "POSITIVE": [
            "期待", "好棒", "喜欢", "感谢", "谢谢", "太好了", "完美",
            "thanks", "great", "awesome",
        ],
    }

    def _compute_sentiment_line(self, user_message: str) -> str:
        """S37: 扫描情绪关键词,触发情绪 → 行为提示。

        优先级: ANXIOUS > CONFUSED > POSITIVE(因为焦虑最需即时缓冲)。
        无匹配返回空字符串(中性)。
        """
        if not self.sentiment_enabled or not user_message:
            return ""
        lower = user_message.lower()
        for sentiment in ("ANXIOUS", "CONFUSED", "POSITIVE"):
            for kw in self._SENTIMENT_KEYWORDS[sentiment]:
                if kw in lower:
                    hint = {
                        "ANXIOUS": "用户情绪紧迫,请直接给关键答案,省略铺垫",
                        "CONFUSED": "用户感到困惑,请放慢节奏从概念基础开始解释",
                        "POSITIVE": "用户情绪正向,保持同等热情语气",
                    }[sentiment]
                    return f"[情绪信号: {sentiment} — {hint}]"
        return ""

    # ── S38: Multi-language Switch Detection ────────────────────────────
    @staticmethod
    def _zh_char_ratio(text: str) -> float:
        """计算字符串中中文字符的占比(范围 CJK Unified Ideographs)。"""
        if not text:
            return 0.0
        total = 0
        zh = 0
        for ch in text:
            if ch.isspace():
                continue
            total += 1
            # 简单 CJK 范围检测
            cp = ord(ch)
            if 0x4E00 <= cp <= 0x9FFF:
                zh += 1
        if total == 0:
            return 0.0
        return zh / total

    def _compute_lang_switch_line(
        self, session_id: str, user_message: str
    ) -> str:
        """S38: 比较当前消息与上一条用户消息的中文占比,若跨过 50% 视为切换。"""
        if not self.lang_switch_enabled or not user_message:
            return ""
        history = self._user_msg_history.get(session_id, [])
        if not history:
            return ""
        prev = history[-1]
        curr_ratio = self._zh_char_ratio(user_message)
        prev_ratio = self._zh_char_ratio(prev)
        # 切换判定:一方 >= 0.5 另一方 < 0.5
        if curr_ratio >= 0.5 and prev_ratio < 0.5:
            return "[语言切换: 用户切换到中文 — 请用中文回复]"
        if curr_ratio < 0.5 and prev_ratio >= 0.5:
            return "[语言切换: 用户切换到英文 — 请用英文回复]"
        return ""

    # ── S39: Task Listing Trigger ───────────────────────────────────────
    def _compute_task_listing_line(self, user_message: str) -> str:
        """S39: 检测用户是否要求列出/总结/罗列,触发结构化输出提示。"""
        if not self.task_listing_enabled or not user_message:
            return ""
        lower = user_message.lower()
        keywords = [
            "列出", "罗列", "总结一下", "做个清单", "做一个清单",
            "帮我列", "给我个清单", "list", "summarize", "enumerate",
            "bullet", "要点",
        ]
        for kw in keywords:
            if kw in lower:
                return (
                    "[结构化输出: 用户要求列表/总结式回答,"
                    "请使用 bullet 或 numbered list 而非段落]"
                )
        return ""

    # ── S40: Output Format Preference ───────────────────────────────────
    _FORMAT_KEYWORDS: Dict[str, List[str]] = {
        "code": ["代码", "code block", "```", "function", "snippet", "脚本"],
        "table": ["表格", "table", "对比表", "比较一下"],
        "list": ["列表", "list", "bullet", "要点", "清单"],
        "markdown": ["markdown", "md 格式", "标题层级"],
        "json": ["json", "json 格式", "结构化数据"],
    }

    def _record_format_signal(self, session_id: str, user_message: str) -> None:
        """S40: 累计本会话用户对各种格式的偏好关键词。"""
        if not self.output_format_enabled or not user_message:
            return
        lower = user_message.lower()
        counters = self._format_counters.setdefault(
            session_id, {k: 0 for k in self._FORMAT_KEYWORDS}
        )
        for fmt, kws in self._FORMAT_KEYWORDS.items():
            for kw in kws:
                if kw in lower:
                    counters[fmt] = counters.get(fmt, 0) + 1
                    break  # 一种格式累 1 次即可

    def _compute_output_format_line(self, session_id: str) -> str:
        """S40: 若某格式累计 >= 2 次,作为用户偏好提示给 AI。

        模糊请求时倾向使用该格式;明确格式请求由 S39 等其他信号处理。
        """
        if not self.output_format_enabled:
            return ""
        c = self._format_counters.get(session_id, {})
        if not c:
            return ""
        top_fmt, top_score = max(c.items(), key=lambda x: x[1])
        if top_score < 2:
            return ""
        names = {
            "code": "代码块",
            "table": "表格",
            "list": "列表",
            "markdown": "Markdown",
            "json": "JSON",
        }
        return (
            f"[格式偏好: 用户本会话已 {top_score} 次倾向 {names[top_fmt]} 格式,"
            f"在模糊请求时优先使用]"
        )

    def _compute_knowledge_gap_hint(self, relevant: List[Dict]) -> str:
        """S16: 知识缺口检测 — 检测记忆上下文是否严重不足，返回行为指令行。

        三种缺口场景（按严重程度从高到低）：
          1. 完全空白 (relevant=[])：无任何相关记忆 → "无相关记忆" 缺口
          2. 全低置信 (全部 importance < threshold)：有记忆但均为未固化片段 → "低置信" 缺口
          3. 仅部分低置信：有验证事实但数量不足 → 不触发（由 S11 置信度标注处理）

        返回格式：`[知识缺口: <场景描述>]`，调用方将其追加到 memory_text 末尾。
        功能关闭或未检测到缺口时返回空字符串。
        """
        if not self.knowledge_gap_enabled:
            return ""
        if not relevant:
            return "[知识缺口: 当前无相关记忆，如需准确回答请主动向用户确认关键信息]"
        # 检查是否全部为低置信记忆
        all_low = all(
            (m.get("importance") or 0.0) < self.mem_confidence_threshold
            for m in relevant
        )
        if all_low:
            return "[知识缺口: 当前记忆均为低置信片段，建议确认关键事实后再作判断]"
        return ""

    def _get_memory_signal_guide_line(self) -> str:
        """S17: 记忆信号使用指南 — 返回紧凑的单行标签说明，前置到 memory_text 顶部。

        通过一行自文档化注释，让 AI 正确解读 S11-S16 注入的各类元信号：
          · 已验证事实 = L3/L4 高置信记忆，可自信引用
          · 近期片段   = L1/L2 原始片段，低置信，作上下文参考
          · 知识缺口   = 信息不足，主动向用户澄清
          · 时效低     = 记忆陈旧，引用时加保留措辞
        功能关闭时返回空字符串；只在有实际记忆信号时注入（由调用方判断）。
        """
        if not self.mem_signal_guide_enabled:
            return ""
        return (
            "[记忆标签说明: 已验证事实=L3/L4高置信可引用; "
            "近期片段=L1/L2低置信仅供参考; "
            "知识缺口=信息不足请主动澄清; "
            "时效低=记忆陈旧引用时加保留措辞]"
        )

    def _classify_query_intent(self, user_message: str) -> str:
        """S18: 查询意图分类 — 纯关键词/模式匹配，零额外 LLM 调用。

        将用户消息分为 4 类：
          PERSONAL_RECALL — 询问关于自身的信息（我叫什么、我的偏好等）
          TEMPORAL_RECALL — 询问历史/上次/之前的内容（历史回溯）
          TASK_ASSIST     — 编程、写作、计算等执行型任务
          GENERAL         — 不匹配以上任何类型的通用查询

        分类优先级：PERSONAL_RECALL > TEMPORAL_RECALL > TASK_ASSIST > GENERAL
        匹配采用精确子串（PERSONAL/TEMPORAL）和正则词边界（英文 TASK 词汇），
        避免前缀歧义和过宽匹配。
        功能关闭或消息为空时返回 GENERAL（无任何额外注入）。
        """
        if not self.query_intent_enabled or not user_message:
            return "GENERAL"
        # PERSONAL_RECALL: 显式询问关于用户自身的信息。
        # 注意：使用精确子串避免前缀歧义：
        #   "记得我的" 不匹配 "记得我们"；"你知道我的" 不匹配 "你知道我们"
        personal_patterns = [
            "我叫", "我的名字", "关于我", "我是谁", "你知道我的", "记得我的", "我有没有告诉",
            "我喜欢", "我不喜欢", "我的偏好", "我的习惯", "我的工作", "我的目标",
        ]
        if any(p in user_message for p in personal_patterns):
            return "PERSONAL_RECALL"
        # TEMPORAL_RECALL: 询问历史/上次/之前的内容。
        # "历史" 单独出现时过于宽泛（"中国历史"等非对话历史），改为更具体的复合词。
        temporal_patterns = [
            "上次", "之前", "上周", "昨天", "最近", "以前", "记得我们",
            "我们聊过", "上一次", "之前说过", "你之前", "我之前",
            "对话历史", "历史记录", "聊天历史",
        ]
        if any(p in user_message for p in temporal_patterns):
            return "TEMPORAL_RECALL"
        # TASK_ASSIST: 编程、写作、计算等执行型任务（中英文混合）。
        # 英文词汇使用 \b 词边界匹配，避免 trailing-space 漏匹配和内部词干误匹配。
        import re as _re
        msg_lower = user_message.lower()
        chinese_task_patterns = [
            "帮我写", "帮我做", "帮我实现", "帮我分析", "帮我生成", "帮我创建",
            "给我写", "写一个", "写一段", "实现一个", "创建一个", "生成一个",
            "代码", "python", "javascript", "typescript", "sql", "bash", "shell",
        ]
        if any(p in msg_lower for p in chinese_task_patterns):
            return "TASK_ASSIST"
        if _re.search(r"\b(write|generate|create|implement|code)\b", msg_lower):
            return "TASK_ASSIST"
        return "GENERAL"

    def _get_query_intent_hint(self, intent: str) -> str:
        """S18: 根据查询意图返回单行行为提示，追加到 memory_text 末尾。

        设计目标：帮助 AI 在不同查询场景下灵活调整记忆引用策略：
          PERSONAL_RECALL → 强调已验证事实的引用价值
          TEMPORAL_RECALL → 强调时序整合，近期摘要同等重要
          TASK_ASSIST     → 提示聚焦执行，避免不必要的记忆陈述占用输出
          GENERAL         → 不注入，保持默认行为

        与 S16 知识缺口检测互补：S16 反映记忆"有多少"，S18 反映"如何使用"。
        功能关闭或 GENERAL 意图时返回空字符串。
        """
        if not self.query_intent_enabled or intent == "GENERAL":
            return ""
        if intent == "PERSONAL_RECALL":
            return (
                "[查询意图: 个人信息回溯 — 优先引用已验证事实(L3/L4)；"
                "无相关记忆时请明确告知用户而非猜测]"
            )
        if intent == "TEMPORAL_RECALL":
            return (
                "[查询意图: 历史回溯 — 近期对话摘要与低时效记忆同等重要；"
                "请整合时序脉络而非仅引用最新条目]"
            )
        if intent == "TASK_ASSIST":
            return (
                "[查询意图: 任务执行 — 聚焦完成用户请求；"
                "记忆仅作用户背景参考，不必在回复中逐一陈述]"
            )
        return ""

    def _load_kg_context(self, user_message: str) -> str:
        """S9: KG 上下文注入 — 用消息内容在知识图谱中检索相关实体，注入系统提示。

        使用 KG.search() 的内存子串匹配，零成本（无 LLM 调用、无 DB 查询）。
        对每个命中实体额外展开其直接邻居（深度 1），提供一跳关联知识。
        若 KG 未启用、为空或检索无结果则返回空字符串。
        """
        if not self.kg_context_enabled or not self.kg:
            return ""
        if not user_message.strip():
            return ""
        try:
            entities = self.kg.search(user_message, limit=self.kg_context_top_k)
            if not entities:
                return ""
            lines: List[str] = []
            for entity in entities:
                eid = entity["id"]
                name = entity.get("name", "")
                etype = entity.get("type", "unknown")
                desc = (entity.get("description") or "").strip()
                header = f"**{name}** ({etype})"
                if desc:
                    header += f": {desc}"
                lines.append(header)
                # 展开直接邻居（深度 1，最多 kg_context_max_rels 条）
                neighbors = self.kg.get_neighbors(eid)[:self.kg_context_max_rels]
                for nb in neighbors:
                    rel_type = nb.get("relation", "关联")
                    nb_name = nb.get("name", "")
                    if nb.get("direction", "out") == "out":
                        lines.append(f"  → {rel_type}: {nb_name}")
                    else:
                        lines.append(f"  ← {rel_type}: {nb_name}")
            return "\n".join(lines)
        except Exception as e:
            logger.debug("[ChatEngine/S9] KG 上下文加载失败（非致命）: %s", e)
            return ""

    async def _load_user_profile(self) -> str:
        """S8: 持久化用户上下文 — 从 L3/L4 加载 [preference]/[goal] 事实注入系统提示。

        结果按 TTL 缓存，避免每轮对话都查 DB。失败时静默降级，返回空字符串。
        锁防止 TTL 到期瞬间多个并发请求同时穿透缓存（惊群效应）。
        """
        if not self.user_profile_enabled:
            return ""
        now = time.monotonic()
        # 快路径：缓存有效，无需加锁
        if (
            self._user_profile_cache is not None
            and (now - self._user_profile_cached_at) < self.user_profile_ttl
        ):
            return self._user_profile_cache
        # 慢路径：取锁后二次检查，防止多个协程同时穿透
        # 惰性初始化：在第一次协程调用时创建，确保与运行中的 event loop 绑定
        if self._user_profile_lock is None:
            self._user_profile_lock = asyncio.Lock()
        async with self._user_profile_lock:
            now = time.monotonic()  # 重新采样：锁等待期间缓存可能已被另一协程填充
            if (
                self._user_profile_cache is not None
                and (now - self._user_profile_cached_at) < self.user_profile_ttl
            ):
                return self._user_profile_cache
            try:
                results = await self.memory.query({
                    "query": "[preference] [goal]",
                    "levels": ["L3", "L4"],
                    "limit": self.user_profile_top_k,
                    "use_rerank": False,  # profile 不需要 cross-encoder re-ranking
                })
                profile_facts = [
                    r["content"]
                    for r in results
                    if r.get("content", "").startswith(("[preference]", "[goal]"))
                ]
                profile_text = "\n".join([f"- {f}" for f in profile_facts]) if profile_facts else ""
                self._user_profile_cache = profile_text
                self._user_profile_cached_at = now
                return profile_text
            except Exception as e:
                # 失败时将空结果写入缓存，防止短 TTL 内持续重试拖慢每轮对话
                logger.warning("S8 用户画像加载失败（已降级为空，TTL 内不再重试）: %s", e)
                self._user_profile_cache = ""
                self._user_profile_cached_at = now
                return ""

    async def _build_system_prompt(self, agent_id: str, memory_text: str, rag_text: str = "",
                                    plan_block: str = "", user_profile_text: str = "",
                                    kg_context_text: str = "",
                                    conv_anchor_text: str = "",
                                    temporal_context_line: str = "") -> str:
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

        # S8: 持久化用户上下文 — 若有 user_profile_text，在模板末尾追加（或替换槽位）
        if user_profile_text and "{{user_profile}}" not in prompt:
            prompt = prompt + "\n\n## 用户偏好与目标\n{{user_profile}}"

        # S9: KG 实体上下文 — 若检索到相关实体，在模板末尾追加（或替换槽位）
        if kg_context_text and "{{kg_context}}" not in prompt:
            prompt = prompt + "\n\n## 相关知识图谱实体\n{{kg_context}}"

        # S10: 会话锚点 — 新会话首条消息携带近期相关对话摘要
        if conv_anchor_text and "{{conv_anchor}}" not in prompt:
            prompt = prompt + "\n\n## 相关历史对话\n{{conv_anchor}}"

        # S14: 时态上下文注入 — 将当前日期/时间前置追加到提示，不依赖槽位
        # （大多数 system.md 模板不会预置 {{current_time}}，直接 prepend 更安全）
        if temporal_context_line:
            if "{{current_time}}" in prompt:
                prompt = prompt.replace("{{current_time}}", temporal_context_line)
            else:
                # 前置：时态信息对 AI 定向很关键，放最前面确保不被截断
                prompt = temporal_context_line + "\n\n" + prompt

        rag_block = rag_text or "(no relevant documents)"

        prompt = prompt.replace("{{memory}}", memory_text)
        prompt = prompt.replace("{{tools}}", tools_text)
        prompt = prompt.replace("{{agent_name}}", agent_name)
        prompt = prompt.replace("{{agent_role}}", agent_role)
        prompt = prompt.replace("{{rag_context}}", rag_block)
        # Empty string replacement when no plan — keeps the slot from leaking
        # into the rendered prompt as literal `{{plan}}`.
        prompt = prompt.replace("{{plan}}", plan_block)
        # S8: 用户画像槽位替换；若无 profile，同样清理占位符
        prompt = prompt.replace("{{user_profile}}", user_profile_text)
        # S9: KG 实体槽位替换；若无 KG 上下文，清理占位符防止泄漏到最终提示
        prompt = prompt.replace("{{kg_context}}", kg_context_text)
        # S10: 会话锚点槽位替换；空时清理占位符
        prompt = prompt.replace("{{conv_anchor}}", conv_anchor_text)
        # S14: 清理残余的 {{current_time}} 占位符（当 temporal_context_line="" 时）
        prompt = prompt.replace("{{current_time}}", "")

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

    async def _fire_plugin_hook(
        self, phase: str, payload: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """v2.12: Cross-process plugin hook notification.

        Fires `POST {sub_brain_url}/hooks/llm/{phase}` so sub-brain plugins
        registered against `pre_llm_call` / `post_llm_call` can run. The
        call is "best effort":
          - 1 second hard timeout (plugins shouldn't block LLM path)
          - All exceptions swallowed (a buggy plugin can't break chat)
          - Returns the sub-brain response dict, or None on any failure

        Phase: "pre" or "post" — corresponds to /hooks/llm/pre / /hooks/llm/post.
        """
        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                resp = await client.post(
                    f"{self.sub_brain_url}/hooks/llm/{phase}",
                    json=payload,
                )
                if resp.status_code == 200:
                    return resp.json()
        except Exception:
            # plugin error must NEVER break the chat path
            pass
        return None

    async def _chat_completion(self, messages: List[Dict], tools: Optional[List[Dict]] = None,
                                max_tokens: int = 2048, temperature: Optional[float] = None) -> Dict[str, Any]:
        """Call an LLM endpoint with automatic failover (M4a).

        Walks endpoints in priority-desc order, healthy ones first.
        Records per-endpoint success/failure stats. Raises only if every
        endpoint has been tried and all failed — the resulting error
        names which endpoint produced the last error for diagnosis.

        v2.12: fires pre_llm_call / post_llm_call plugin hooks via sub-brain
        cross-process bridge. Plugin can `allowed: false` to short-circuit.
        Plugin errors / timeouts allow-through (chat path stays robust).
        """
        if not self.router.endpoints:
            raise RuntimeError("No LLM endpoint available")

        # v2.12: pre_llm_call hook
        pre_payload: Dict[str, Any] = {
            "messages": messages,
            "temperature": temperature,
        }
        pre_result = await self._fire_plugin_hook("pre", pre_payload)
        if pre_result is not None and pre_result.get("allowed") is False:
            raise RuntimeError(
                f"pre_llm_call hook rejected: {pre_result.get('reason') or 'no reason given'}"
            )
        # Honor `modified` envelope from hook (messages / temperature)
        if pre_result is not None and isinstance(pre_result.get("modified"), dict):
            mod = pre_result["modified"]
            if isinstance(mod.get("messages"), list):
                messages = mod["messages"]
            if "temperature" in mod and mod["temperature"] is not None:
                temperature = mod["temperature"]

        last_error: Optional[Exception] = None
        last_endpoint_name: Optional[str] = None
        tried = 0

        # v2.17 Axis 3: privacy-mode filter. When user has flipped privacy on,
        # only local endpoints (LM Studio / Ollama / 127.* / 10.* / 192.168.*)
        # are allowed; remote providers are skipped entirely for this call.
        try:
            from audit.privacy_mode import get_privacy_state, is_local_url
            privacy_on = get_privacy_state().is_on()
        except Exception:
            privacy_on = False
            is_local_url = lambda _u: True  # noqa: E731 — defensive fallback

        for ep in self.router.iter_failover():
            if privacy_on and not is_local_url(ep.base_url):
                logger.info(
                    "Privacy mode ON: skipping remote endpoint %s (%s)",
                    ep.name,
                    ep.base_url,
                )
                continue
            tried += 1
            last_endpoint_name = ep.name
            url, payload, headers = self._build_request(
                ep, messages, tools, max_tokens, temperature, stream=False
            )
            # v2.16 Axis 3: pre-compute request bytes for audit ledger.
            try:
                request_bytes = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            except Exception:
                request_bytes = 0
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
                # v2.16 Axis 3: record successful outbound LLM call to
                # network_ledger.jsonl for user audit. Never raises.
                try:
                    response_bytes = len(
                        json.dumps(data, ensure_ascii=False).encode("utf-8")
                    )
                except Exception:
                    response_bytes = 0
                try:
                    from audit.network_ledger import get_ledger
                    get_ledger().record_success(
                        endpoint=ep.name,
                        base_url=ep.base_url,
                        model=ep.model_id,
                        latency_ms=latency_ms,
                        request_bytes=request_bytes,
                        response_bytes=response_bytes,
                    )
                except Exception as audit_err:
                    logger.debug("network_ledger record_success failed: %s", audit_err)
                # v2.12: post_llm_call hook (fire-and-forget; result still
                # returned regardless of hook outcome)
                await self._fire_plugin_hook(
                    "post",
                    {
                        "context": {
                            "messages": messages,
                            "temperature": temperature,
                            "model": ep.model_id,
                        },
                        "response": result,
                    },
                )
                return result
            except Exception as e:
                err_msg = f"{type(e).__name__}: {e}"
                self.router.mark_failure(ep.name, err_msg)
                last_error = e
                # v2.16 Axis 3: record failure to network_ledger too —
                # users want to see "endpoint X errored" in audit.
                # v2.19 fix: pass request_bytes (already computed before send)
                # so audit shows "you sent X bytes that then errored", not null.
                latency_ms_to_fail = (time.time() - t0) * 1000.0
                try:
                    from audit.network_ledger import get_ledger
                    get_ledger().record(
                        event="llm_call",
                        endpoint=ep.name,
                        base_url=ep.base_url,
                        model=ep.model_id,
                        success=False,
                        latency_ms=latency_ms_to_fail,
                        request_bytes=request_bytes,
                        response_bytes=None,
                        error=err_msg,
                    )
                except Exception:
                    pass
                logger.warning(
                    "LLM endpoint %s failed (%s) — failing over to next endpoint",
                    ep.name,
                    err_msg,
                )
                continue

        # All endpoints exhausted
        if tried == 0 and privacy_on:
            # No local endpoints — privacy mode explicitly opted in to this.
            raise RuntimeError(
                "Privacy mode is ON but no local endpoint (LM Studio / Ollama / "
                "127.* / 10.* / 192.168.*) is configured. "
                "Either turn privacy mode OFF or add a local endpoint."
            )
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
                elif ep.provider == "google":
                    # Gemini SSE (?alt=sse on generateContent). Each event is
                    # `data: <json>` lines separated by blank lines.
                    # Schema: {"candidates":[{"content":{"parts":[{"text":"..."}]},
                    #          "finishReason":"STOP"|"MAX_TOKENS"|...}]}
                    #
                    # We collapse the multi-part array into the first text part
                    # (Gemini rarely splits a single chunk into multiple parts
                    # for text-only outputs). When `finishReason` arrives we
                    # emit `done` regardless of whether [DONE] sentinel showed up.
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data == "[DONE]":
                            yield {"type": "done"}
                            break
                        try:
                            chunk = json.loads(data)
                            cand = (chunk.get("candidates") or [{}])[0]
                            parts = cand.get("content", {}).get("parts", []) or []
                            for p in parts:
                                t = p.get("text") or ""
                                if t:
                                    yield {"type": "content", "data": t}
                            if cand.get("finishReason"):
                                yield {"type": "done"}
                                break
                        except Exception as e:
                            logger.warning(f"Gemini stream parse error: {e}")
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
    # Round S: AI 能力升级 — 四大新方法
    # -----------------------------------------------------------------------

    # S1: HyDE — 生成假设答案文档用于向量检索增强
    async def _expand_query_hyde(self, query: str) -> Optional[str]:
        """生成 HyDE (Hypothetical Document Embeddings) 假设答案文档。

        将用户问题扩展为一个"假设的理想答复"，使用该文档的 embedding 进行记忆向量检索。
        相比直接用问题 embedding，答案空间的向量与记忆中存储的知识语义更接近，
        可显著提升 recall（尤其对知识密集型问题）。
        失败时静默降级：返回 None，调用方回退到原始 query 检索。
        """
        if not self.hyde_enabled or not query.strip():
            return None
        try:
            result = await self._chat_completion(
                [{"role": "user", "content": (
                    f"请用1-3句话简洁回答以下问题，只给出事实性内容，不要解释或提问。\n"
                    f"问题：{query[:400]}"
                )}],
                max_tokens=self.hyde_max_tokens,
                temperature=0.1,
            )
            hyde_doc = result["choices"][0]["message"].get("content", "").strip()
            if hyde_doc:
                logger.debug("HyDE 文档生成: %s...", hyde_doc[:60])
            return hyde_doc if hyde_doc else None
        except Exception as e:
            logger.debug("HyDE 生成失败（非致命）: %s", e)
            return None

    # S2: 反思循环 — 对生成的答复自我评分并在质量低时修订
    async def _reflect_on_reply(self, user_input: str, reply: str) -> Optional[str]:
        """对答复进行自我批评，分数低于阈值时生成修订版本。

        评分维度：完整性、准确性、帮助性（1-5分）。
        仅在答复长度 > 100 字且反思功能启用时触发，最多修订 1 次。
        失败时静默降级：返回 None，调用方保留原始答复。
        """
        if not self.reflection_enabled or len(reply) < 100:
            return None
        try:
            critique_result = await self._chat_completion(
                [{"role": "user", "content": (
                    f"请评估以下 AI 答复对用户问题的质量，仅返回 JSON：\n"
                    f'用户问题：{user_input[:300]}\n'
                    f'AI 答复：{reply[:600]}\n\n'
                    f'返回格式（只有JSON，无其他内容）：{{"score": 1-5, "issues": "问题简述"}}\n'
                    f'评分标准：1-2=信息缺失/不准确，3=基本合格，4-5=完整准确'
                )}],
                max_tokens=100,
                temperature=0.0,
            )
            content = critique_result["choices"][0]["message"].get("content", "")
            m = re.search(r'\{[^}]+\}', content, re.DOTALL)
            if not m:
                return None
            critique = json.loads(m.group())
            score = int(critique.get("score", 5))
            issues = critique.get("issues", "")
            if score >= self.reflection_threshold:
                return None  # 质量达标，不修订
            logger.info("反思触发 (score=%d): %s", score, issues)
            revised = await self._chat_completion(
                [
                    {"role": "user", "content": user_input},
                    {"role": "assistant", "content": reply},
                    {"role": "user", "content": f"你之前的回答有些不足：{issues}。请提供更完整、准确的回答。"},
                ],
                max_tokens=2048,
            )
            return revised["choices"][0]["message"].get("content", reply)
        except Exception as e:
            logger.debug("反思循环失败（非致命）: %s", e)
            return None

    # S3: 工作记忆 — 异步提取会话关键事实
    async def _extract_working_memory(self, session_id: str, user_input: str, reply: str) -> None:
        """从当前对话轮次中提取关键事实，更新会话工作记忆。

        工作记忆是独立于 L1-L4 长期记忆的会话级短期缓存，用于防止
        长对话中早期重要信息丢失。每次对话结束后异步运行，不阻塞主流程。
        """
        if not self.working_memory_enabled:
            return
        try:
            result = await self._chat_completion(
                [{"role": "user", "content": (
                    f"从以下对话中提取 3-5 条当前任务最关键的事实或上下文信息。\n"
                    f"只返回 JSON 数组，每条不超过 20 字，不要解释：\n"
                    f"用户：{user_input[:400]}\n助手：{reply[:400]}"
                )}],
                max_tokens=150,
                temperature=0.0,
            )
            content = result["choices"][0]["message"].get("content", "")
            m = re.search(r'\[.*?\]', content, re.DOTALL)
            if m:
                facts: List[str] = json.loads(m.group())
                if isinstance(facts, list):
                    existing = self._working_memory.get(session_id, [])
                    combined = existing + [str(f).strip() for f in facts if f]
                    # 保留最新的 working_memory_max 条，旧的自然淘汰
                    self._working_memory[session_id] = combined[-self.working_memory_max:]
        except Exception as e:
            logger.debug("工作记忆提取失败（非致命）: %s", e)

    def _fire_working_memory_async(self, session_id: str, user_input: str, reply: str) -> None:
        """以 fire-and-forget 方式异步提取工作记忆（不阻塞响应）。"""
        task = asyncio.create_task(
            self._extract_working_memory(session_id, user_input, reply)
        )
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    def _get_working_memory_text(self, session_id: str) -> str:
        """格式化工作记忆用于系统提示注入。"""
        facts = self._working_memory.get(session_id, [])
        if not facts:
            return ""
        return "\n".join([f"- {f}" for f in facts])

    # S5: 上下文压缩 — 压缩长工具调用链中间历史
    async def _compress_messages(self, messages: List[Dict]) -> List[Dict]:
        """当 messages 超过阈值时，将中间工具调用往返历史压缩为摘要。

        保留结构:
          messages[0]         — 系统提示（不压缩）
          messages[1]         — 原始用户输入（不压缩）
          [摘要 placeholder]  — 压缩中间历史的文本摘要
          messages[-KEEP:]    — 最近 KEEP 条（保持连续性）

        降级策略: LLM 失败或摘要为空时返回原列表，主流程不受影响。
        """
        if not self.context_compress_enabled:
            return messages
        keep = self.context_compress_keep_recent
        # 长度不足 2 时无法正常索引 [0]/[1]，直接返回原列表（防御性检查）
        if len(messages) < 2 or len(messages) <= self.context_compress_threshold:
            return messages

        system_msg = messages[0]
        user_msg = messages[1]
        middle = messages[2:-keep] if len(messages) > 2 + keep else []
        recent = messages[-keep:]

        if not middle:
            return messages

        try:
            history_text = "\n".join(
                f"[{m.get('role', '?')}]: {str(m.get('content') or '')[:300]}"
                for m in middle
            )
            result = await self._chat_completion(
                [{"role": "user", "content": (
                    "请将以下工具调用历史压缩为不超过 200 字的简洁摘要，"
                    "保留关键工具名、重要返回结果和关键状态信息，去除重复和无关内容：\n\n"
                    f"{history_text}"
                )}],
                max_tokens=300,
                temperature=0.0,
            )
            summary = result["choices"][0]["message"].get("content", "").strip()
            if not summary:
                return messages
            # 注意：摘要以 system 角色注入，避免连续 user→user 引发部分模型的角色交替错误
            compressed = [
                system_msg,
                user_msg,
                {"role": "system", "content": f"[工具调用历史摘要]\n{summary}"},
            ] + recent
            logger.debug(
                "S5 上下文压缩: %d 条消息 → %d 条", len(messages), len(compressed)
            )
            return compressed
        except Exception as e:
            logger.debug("S5 上下文压缩失败（非致命）: %s", e)
            return messages

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

        # S4: 工具结果缓存 — 对只读工具按 (工具名+参数) 缓存结果，避免重复调用。
        # 只读工具：file_read（不修改状态）、http_request GET（幂等）。
        # 写入/执行类工具（shell, file_write, screenshot）不缓存。
        _READ_ONLY_TOOLS = {"file_read", "http_request"}
        cache_key: Optional[str] = None
        if sub_tool in _READ_ONLY_TOOLS:
            # http_request 只缓存 GET 方法
            if sub_tool == "http_request" and str(args.get("method", "GET")).upper() != "GET":
                pass  # 非 GET 不缓存
            else:
                raw = json.dumps({"t": sub_tool, "a": args}, sort_keys=True, ensure_ascii=False)
                cache_key = hashlib.sha256(raw.encode()).hexdigest()[:20]
                cached = self._tool_cache.get(cache_key)
                if cached:
                    cached_result, cached_at = cached
                    if time.time() - cached_at < self.tool_cache_ttl:
                        logger.debug("工具缓存命中: %s [%s]", sub_tool, cache_key[:8])
                        return cached_result

        try:
            result = await asyncio.wait_for(
                self.sub_brain.execute_tool(sub_tool, args),
                timeout=30.0,
            )
            result_str = json.dumps(result, ensure_ascii=False) if not isinstance(result, str) else result
            # 写入缓存（仅只读工具）
            if cache_key:
                self._tool_cache[cache_key] = (result_str, time.time())
            return result_str
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

        # S1: HyDE — 生成假设答案文档辅助向量检索。与 FTS 并发运行以节省延迟。
        hyde_doc = await self._expand_query_hyde(user_input)
        # Retrieve memories (使用 HyDE 文档增强向量检索，若未启用则降级到原始 query)
        relevant = await self.memory.query(
            {"query": user_input, "levels": ["L2", "L3"], "limit": 5},
            hyde_doc=hyde_doc,
        )
        # S13: L4 身份锚点 — 将最高 importance 的 L4 记忆前置追加（去重），
        # 确保用户核心身份事实始终进入上下文，无论当前 query 语义是否覆盖它们。
        l4_anchors = await self._get_l4_anchors()
        if l4_anchors:
            seen_ids = {m.get("id") for m in relevant if m.get("id")}
            new_l4 = [m for m in l4_anchors if m.get("id") not in seen_ids]
            relevant = new_l4 + relevant
        # S25: 记录本轮入口时间戳,供 cadence 计算用
        self._record_cadence_tick(session_id)
        # S26: 记录会话回合数(在 cadence tick 同一入口位置)
        self._record_turn(session_id)
        # S24: 给重复命中的 memory 加 hot 标记并累加 hit counter
        relevant = self._annotate_hot_memories(session_id, relevant)
        # S3: 工作记忆 — 将当前会话已积累的关键事实注入 memory_text
        # S12: 用分层格式替代扁平列表，区分已验证事实与近期对话片段
        working_mem_text = self._get_working_memory_text(session_id)
        tiered_text = self._format_tiered_memory_text(relevant)
        if working_mem_text:
            memory_parts = []
            if tiered_text:
                memory_parts.append(tiered_text)
            memory_parts.append(f"[会话上下文]\n{working_mem_text}")
            memory_text = "\n".join(memory_parts)
        else:
            memory_text = tiered_text or "无相关记忆"
        # S11: 记忆置信度标注 — 仅当 memory_text 有实际内容时追加元信号，
        # 避免在 "无相关记忆" 后追加置信度行产生逻辑矛盾（MEDIUM fix）。
        conf_line = self._compute_memory_confidence_line(relevant)
        if conf_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{conf_line}"
        # S15: 记忆时效信号 — 与 S11 置信度并列，反映记忆的时间新鲜度
        freshness_line = self._compute_memory_freshness_line(relevant)
        if freshness_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{freshness_line}"
        # S19: 记忆来源多样性信号 — 统计 L3/L4（已验证）vs L1/L2（近期片段）分布，
        # 给出条数拆解标签，与 S11 置信度聚合互补。
        diversity_line = self._compute_memory_source_diversity_line(relevant)
        if diversity_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{diversity_line}"
        # S16: 知识缺口检测 — 当记忆上下文严重不足时，注入行为指令引导 AI 主动澄清
        gap_hint = self._compute_knowledge_gap_hint(relevant)
        if gap_hint:
            if memory_text == "无相关记忆":
                memory_text = gap_hint
            else:
                memory_text = f"{memory_text}\n{gap_hint}"
        # S17: 记忆信号使用指南 — 在 memory block 顶部注入标签说明（仅当有实际记忆内容时）
        # 注意：S16 可能已将 sentinel "无相关记忆" 替换为纯 gap hint；
        # 此时 memory_text 以 "[知识缺口:" 开头，无实际记忆条目，不应注入 guide。
        signal_guide = self._get_memory_signal_guide_line()
        has_real_memory = (
            memory_text != "无相关记忆"
            and not memory_text.startswith("[知识缺口:")
        )
        if signal_guide and has_real_memory:
            memory_text = f"{signal_guide}\n{memory_text}"
        # S18: 查询意图感知 — 根据用户消息动态注入记忆使用策略提示（零 LLM 调用）
        intent = self._classify_query_intent(user_input)
        intent_hint = self._get_query_intent_hint(intent)
        if intent_hint:
            memory_text = f"{memory_text}\n{intent_hint}"
        # S20: 记忆充分性信号 — 基于 S18 意图 + validated 条数,给出意图特定的
        # 行为指令。位置紧邻 S18 之后(意图先行,充分性紧跟)。
        # 关键 guard: S16 gap_hint 触发时跳过 S20,避免与"知识缺口"指令矛盾。
        adequacy_line = self._compute_memory_adequacy_line(relevant, intent)
        if adequacy_line and not gap_hint:
            memory_text = f"{memory_text}\n{adequacy_line}"
        # S21: 实体关注度信号 — 列出本轮用户消息命中的 KG 实体
        entity_spotlight = self._compute_entity_spotlight_line(user_input)
        if entity_spotlight:
            memory_text = f"{memory_text}\n{entity_spotlight}"
        # S22: 主题分类 — 给出当前主题域的回答风格提示
        topic = self._classify_conversation_topic(user_input)
        topic_hint = self._get_topic_hint(topic)
        if topic_hint:
            memory_text = f"{memory_text}\n{topic_hint}"
        # S23: 对话连贯性 — embedder 比对本轮 vs 上轮 user message
        coherence_line = await self._compute_coherence_line(session_id, user_input)
        if coherence_line:
            memory_text = f"{memory_text}\n{coherence_line}"
        # S24: 高频引用记忆 — 总结本会话内重复命中的 memory 数量
        hot_memory_line = self._compute_hot_memory_line(relevant)
        if hot_memory_line:
            memory_text = f"{memory_text}\n{hot_memory_line}"
        # S25: 用户节律 — 基于消息时间戳推断快速/慢思考
        cadence_line = self._compute_cadence_line(session_id)
        if cadence_line:
            memory_text = f"{memory_text}\n{cadence_line}"
        # S26: 对话回合深度 — 多轮对话时提醒一致性
        turn_depth_line = self._compute_turn_depth_line(session_id)
        if turn_depth_line:
            memory_text = f"{memory_text}\n{turn_depth_line}"
        # S27: 记忆陈旧度告警
        staleness_line = self._compute_staleness_alert_line(relevant)
        if staleness_line:
            memory_text = f"{memory_text}\n{staleness_line}"
        # S28: 用户专业级别累积证据 + 推断
        self._record_expertise_signal(session_id, user_input)
        expertise_line = self._compute_expertise_line(session_id)
        if expertise_line:
            memory_text = f"{memory_text}\n{expertise_line}"
        # S29: 响应长度建议(综合 S22 主题 + S25 节律 + S26 深度)
        length_hint_line = self._compute_length_hint_line(session_id, topic)
        if length_hint_line:
            memory_text = f"{memory_text}\n{length_hint_line}"
        # S30: 工具调用频次提醒
        tool_freq_line = self._compute_tool_freq_line(session_id)
        if tool_freq_line:
            memory_text = f"{memory_text}\n{tool_freq_line}"
        # S31: 对话节奏切换检测 — 在 S32 历史更新之前先记录字数样本
        self._record_pace_sample(session_id, user_input)
        pace_switch_line = self._compute_pace_switch_line(session_id)
        if pace_switch_line:
            memory_text = f"{memory_text}\n{pace_switch_line}"
        # S32: 重复性问题检测 — 必须先 compute 再 record,避免自匹配
        repeat_q_line = self._compute_repeat_question_line(session_id, user_input)
        if repeat_q_line:
            memory_text = f"{memory_text}\n{repeat_q_line}"
        # S33: 时段感知行为信号
        time_of_day_line = self._compute_time_of_day_line()
        if time_of_day_line:
            memory_text = f"{memory_text}\n{time_of_day_line}"
        # S34: 短句上下文遗漏检测 — 依赖 S32 已经维护的历史长度
        context_drop_line = self._compute_context_drop_line(session_id, user_input)
        if context_drop_line:
            memory_text = f"{memory_text}\n{context_drop_line}"
        # S35: 失败反馈识别
        neg_feedback_line = self._compute_negative_feedback_line(user_input)
        if neg_feedback_line:
            memory_text = f"{memory_text}\n{neg_feedback_line}"
        # S38: 多语种切换检测 — 必须在 user_input 记入历史之前比较
        lang_switch_line = self._compute_lang_switch_line(session_id, user_input)
        if lang_switch_line:
            memory_text = f"{memory_text}\n{lang_switch_line}"
        # S32 (cont.): 最后把当前 user_input 记入历史(下轮用)
        self._record_user_message(session_id, user_input)
        # S36: 用户角色推断 — 累积信号 + 推断
        self._record_role_signal(session_id, user_input)
        role_line = self._compute_role_inference_line(session_id)
        if role_line:
            memory_text = f"{memory_text}\n{role_line}"
        # S37: 情绪倾向标注
        sentiment_line = self._compute_sentiment_line(user_input)
        if sentiment_line:
            memory_text = f"{memory_text}\n{sentiment_line}"
        # S39: 任务清单化触发
        task_listing_line = self._compute_task_listing_line(user_input)
        if task_listing_line:
            memory_text = f"{memory_text}\n{task_listing_line}"
        # S40: 输出格式偏好 — 累计 + 推断
        self._record_format_signal(session_id, user_input)
        format_line = self._compute_output_format_line(session_id)
        if format_line:
            memory_text = f"{memory_text}\n{format_line}"

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
        # S8: 持久化用户上下文
        user_profile_text = await self._load_user_profile()
        # S9: KG 实体上下文（同步，零延迟）
        kg_context_text = self._load_kg_context(user_input)
        # S10: 会话锚点（新会话首条消息时检索相关 L2 摘要，后续消息直接跳过）
        conv_anchor_text = await self._load_conversation_anchor(session_id, user_input)
        # S14: 时态上下文注入（当前日期/时间，零成本，每次对话刷新）
        temporal_context_line = self._get_temporal_context_line()
        system_prompt = await self._build_system_prompt(agent_id, memory_text, rag_text, plan_block, user_profile_text, kg_context_text, conv_anchor_text, temporal_context_line)
        messages: List[Dict] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ]

        tools_enabled = (context or {}).get("tools_enabled", True)
        available_tools = self._get_tools_for_agent(agent_id, agent_config) if tools_enabled else None
        # Round N1 — semantic narrowing of the tool list before LLM sees it.
        # O3: now async so embedder.encode runs in an executor and doesn't
        # block the event loop.
        if available_tools:
            available_tools = await self._filter_tools_by_query(available_tools, user_input)
        all_tool_calls: List[Dict] = []
        all_tool_results: List[Dict] = []

        iteration = 0
        while iteration < MAX_TOOL_ITERATIONS:
            iteration += 1

            # S5: 上下文压缩 — 第二轮起，若 messages 超过阈值则压缩中间历史
            if iteration > 1:
                messages = await self._compress_messages(messages)

            # LLM call
            result = await self._chat_completion(messages, tools=available_tools)
            msg = result["choices"][0]["message"]
            tool_calls = msg.get("tool_calls", [])

            if not tool_calls:
                reply = msg.get("content", "")

                # S2: 反思循环 — 非工具调用路径才触发（避免工具链中途中断）
                revised = await self._reflect_on_reply(user_input, reply)
                if revised:
                    reply = revised

                await self.memory.store({"level": "L1", "content": f"Assistant: {reply}", "session_id": session_id, "source": "assistant"})
                # Fire ActiveMemory extraction in the background. Must come
                # AFTER the L1 store so process_conversation sees a coherent
                # exchange when it queries memory, and BEFORE return so we
                # don't lose the reference if the caller never awaits again.
                self._fire_active_memory_async(session_id, user_input, reply)
                # Round M2 — also opportunistically summarize long sessions.
                # Both fire-and-forget tasks coexist (active_memory extracts
                # patterns, summarizer compresses history); they query
                # memory independently.
                self._fire_session_summarize_async(session_id)
                # S3: 工作记忆 — 异步提取当前轮次关键信息供下一轮使用
                self._fire_working_memory_async(session_id, user_input, reply)
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

        # S1: HyDE — 与 chat() 一致，用假设答案文档增强向量检索
        hyde_doc = await self._expand_query_hyde(user_input)
        relevant = await self.memory.query(
            {"query": user_input, "levels": ["L2", "L3"], "limit": 5},
            hyde_doc=hyde_doc,
        )
        # S13: L4 身份锚点 — 前置追加最高 importance 的 L4 记忆（去重）
        l4_anchors = await self._get_l4_anchors()
        if l4_anchors:
            seen_ids = {m.get("id") for m in relevant if m.get("id")}
            new_l4 = [m for m in l4_anchors if m.get("id") not in seen_ids]
            relevant = new_l4 + relevant
        # S3: 工作记忆注入
        # S12: 用分层格式替代扁平列表，区分已验证事实与近期对话片段
        working_mem_text = self._get_working_memory_text(session_id)
        tiered_text = self._format_tiered_memory_text(relevant)
        if working_mem_text:
            mem_parts = []
            if tiered_text:
                mem_parts.append(tiered_text)
            mem_parts.append(f"[会话上下文]\n{working_mem_text}")
            memory_text = "\n".join(mem_parts)
        else:
            memory_text = tiered_text or "无相关记忆"
        # S11: 记忆置信度标注 — 仅当 memory_text 有实际内容时追加元信号，
        # 避免在 "无相关记忆" 后追加置信度行产生逻辑矛盾（MEDIUM fix）。
        conf_line = self._compute_memory_confidence_line(relevant)
        if conf_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{conf_line}"
        # S15: 记忆时效信号 — 与 S11 置信度并列，反映记忆的时间新鲜度
        freshness_line = self._compute_memory_freshness_line(relevant)
        if freshness_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{freshness_line}"
        # S19: 记忆来源多样性信号 — 统计 L3/L4（已验证）vs L1/L2（近期片段）分布，
        # 给出条数拆解标签，与 S11 置信度聚合互补。
        diversity_line = self._compute_memory_source_diversity_line(relevant)
        if diversity_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{diversity_line}"
        # S16: 知识缺口检测 — 当记忆上下文严重不足时，注入行为指令引导 AI 主动澄清
        gap_hint = self._compute_knowledge_gap_hint(relevant)
        if gap_hint:
            if memory_text == "无相关记忆":
                memory_text = gap_hint
            else:
                memory_text = f"{memory_text}\n{gap_hint}"
        # S17: 记忆信号使用指南 — 在 memory block 顶部注入标签说明（仅当有实际记忆内容时）
        # 注意：S16 可能已将 sentinel "无相关记忆" 替换为纯 gap hint；
        # 此时 memory_text 以 "[知识缺口:" 开头，无实际记忆条目，不应注入 guide。
        signal_guide = self._get_memory_signal_guide_line()
        has_real_memory = (
            memory_text != "无相关记忆"
            and not memory_text.startswith("[知识缺口:")
        )
        if signal_guide and has_real_memory:
            memory_text = f"{signal_guide}\n{memory_text}"
        # S18: 查询意图感知 — 根据用户消息动态注入记忆使用策略提示（零 LLM 调用）
        intent = self._classify_query_intent(user_input)
        intent_hint = self._get_query_intent_hint(intent)
        if intent_hint:
            memory_text = f"{memory_text}\n{intent_hint}"
        # S20: 记忆充分性信号 — 基于 S18 意图 + validated 条数,给出意图特定的
        # 行为指令。位置紧邻 S18 之后(意图先行,充分性紧跟)。
        # 关键 guard: S16 gap_hint 触发时跳过 S20,避免与"知识缺口"指令矛盾。
        adequacy_line = self._compute_memory_adequacy_line(relevant, intent)
        if adequacy_line and not gap_hint:
            memory_text = f"{memory_text}\n{adequacy_line}"
        # S21: 实体关注度信号 — 列出本轮用户消息命中的 KG 实体
        entity_spotlight = self._compute_entity_spotlight_line(user_input)
        if entity_spotlight:
            memory_text = f"{memory_text}\n{entity_spotlight}"
        # S22: 主题分类 — 给出当前主题域的回答风格提示
        topic = self._classify_conversation_topic(user_input)
        topic_hint = self._get_topic_hint(topic)
        if topic_hint:
            memory_text = f"{memory_text}\n{topic_hint}"
        # S23: 对话连贯性 — embedder 比对本轮 vs 上轮 user message
        coherence_line = await self._compute_coherence_line(session_id, user_input)
        if coherence_line:
            memory_text = f"{memory_text}\n{coherence_line}"
        # S24: 高频引用记忆 — 总结本会话内重复命中的 memory 数量
        hot_memory_line = self._compute_hot_memory_line(relevant)
        if hot_memory_line:
            memory_text = f"{memory_text}\n{hot_memory_line}"
        # S25: 用户节律 — 基于消息时间戳推断快速/慢思考
        cadence_line = self._compute_cadence_line(session_id)
        if cadence_line:
            memory_text = f"{memory_text}\n{cadence_line}"
        # S26: 对话回合深度 — 多轮对话时提醒一致性
        turn_depth_line = self._compute_turn_depth_line(session_id)
        if turn_depth_line:
            memory_text = f"{memory_text}\n{turn_depth_line}"
        # S27: 记忆陈旧度告警
        staleness_line = self._compute_staleness_alert_line(relevant)
        if staleness_line:
            memory_text = f"{memory_text}\n{staleness_line}"
        # S28: 用户专业级别累积证据 + 推断
        self._record_expertise_signal(session_id, user_input)
        expertise_line = self._compute_expertise_line(session_id)
        if expertise_line:
            memory_text = f"{memory_text}\n{expertise_line}"
        # S29: 响应长度建议(综合 S22 主题 + S25 节律 + S26 深度)
        length_hint_line = self._compute_length_hint_line(session_id, topic)
        if length_hint_line:
            memory_text = f"{memory_text}\n{length_hint_line}"
        # S30: 工具调用频次提醒
        tool_freq_line = self._compute_tool_freq_line(session_id)
        if tool_freq_line:
            memory_text = f"{memory_text}\n{tool_freq_line}"
        # S31: 对话节奏切换检测
        self._record_pace_sample(session_id, user_input)
        pace_switch_line = self._compute_pace_switch_line(session_id)
        if pace_switch_line:
            memory_text = f"{memory_text}\n{pace_switch_line}"
        # S32: 重复性问题检测(compute 前于 record)
        repeat_q_line = self._compute_repeat_question_line(session_id, user_input)
        if repeat_q_line:
            memory_text = f"{memory_text}\n{repeat_q_line}"
        # S33: 时段感知
        time_of_day_line = self._compute_time_of_day_line()
        if time_of_day_line:
            memory_text = f"{memory_text}\n{time_of_day_line}"
        # S34: 短句上下文遗漏
        context_drop_line = self._compute_context_drop_line(session_id, user_input)
        if context_drop_line:
            memory_text = f"{memory_text}\n{context_drop_line}"
        # S35: 失败反馈识别
        neg_feedback_line = self._compute_negative_feedback_line(user_input)
        if neg_feedback_line:
            memory_text = f"{memory_text}\n{neg_feedback_line}"
        # S38: 多语种切换检测(在 record 之前)
        lang_switch_line = self._compute_lang_switch_line(session_id, user_input)
        if lang_switch_line:
            memory_text = f"{memory_text}\n{lang_switch_line}"
        # S32 (cont.): 记入历史
        self._record_user_message(session_id, user_input)
        # S36: 用户角色推断
        self._record_role_signal(session_id, user_input)
        role_line = self._compute_role_inference_line(session_id)
        if role_line:
            memory_text = f"{memory_text}\n{role_line}"
        # S37: 情绪倾向标注
        sentiment_line = self._compute_sentiment_line(user_input)
        if sentiment_line:
            memory_text = f"{memory_text}\n{sentiment_line}"
        # S39: 任务清单化触发
        task_listing_line = self._compute_task_listing_line(user_input)
        if task_listing_line:
            memory_text = f"{memory_text}\n{task_listing_line}"
        # S40: 输出格式偏好
        self._record_format_signal(session_id, user_input)
        format_line = self._compute_output_format_line(session_id)
        if format_line:
            memory_text = f"{memory_text}\n{format_line}"

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
        # S8: 持久化用户上下文
        user_profile_text = await self._load_user_profile()
        # S9: KG 实体上下文（同步，零延迟）
        kg_context_text = self._load_kg_context(user_input)
        # S10: 会话锚点（新会话首条消息时检索相关 L2 摘要，后续消息直接跳过）
        conv_anchor_text = await self._load_conversation_anchor(session_id, user_input)
        # S14: 时态上下文注入（当前日期/时间，零成本，每次对话刷新）
        temporal_context_line = self._get_temporal_context_line()
        system_prompt = await self._build_system_prompt(agent_id, memory_text, rag_text, plan_block, user_profile_text, kg_context_text, conv_anchor_text, temporal_context_line)
        messages: List[Dict] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ]

        tools_enabled = (context or {}).get("tools_enabled", True)
        available_tools = self._get_tools_for_agent(agent_id, agent_config) if tools_enabled else None
        # Round N1 — semantic narrowing of the tool list before LLM sees it.
        # O3: now async so embedder.encode runs in an executor and doesn't
        # block the event loop.
        if available_tools:
            available_tools = await self._filter_tools_by_query(available_tools, user_input)
        all_tool_calls: List[Dict] = []
        all_tool_results: List[Dict] = []

        iteration = 0
        while iteration < MAX_TOOL_ITERATIONS:
            iteration += 1

            # S5: 上下文压缩 — 第二轮起（流式路径在 iteration=1 流式输出，不压缩）
            if iteration > 1:
                messages = await self._compress_messages(messages)

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
                    self._fire_session_summarize_async(session_id)
                    # S3: 工作记忆异步提取
                    self._fire_working_memory_async(session_id, user_input, full_content)
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
                self._fire_session_summarize_async(session_id)
                # S3: 工作记忆异步提取
                self._fire_working_memory_async(session_id, user_input, reply)
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
