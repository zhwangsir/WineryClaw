"""Round S (third batch): S8 Persistent User Context 单元测试"""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat.chat_engine import ChatEngine


# ---------------------------------------------------------------------------
# 通用 Fixture
# ---------------------------------------------------------------------------

def _make_llm_response(content: str) -> dict:
    return {"choices": [{"message": {"content": content, "tool_calls": []}}]}


@pytest.fixture
def mock_memory():
    mem = MagicMock()
    mem.store = AsyncMock(return_value={"ok": True})
    mem.query = AsyncMock(return_value=[])
    return mem


@pytest.fixture
def mock_sub_brain():
    sb = MagicMock()
    sb.execute_tool = AsyncMock(return_value="tool-result")
    return sb


@pytest.fixture
def engine(mock_memory, mock_sub_brain):
    e = ChatEngine(
        memory_manager=mock_memory,
        sub_brain_client=mock_sub_brain,
        llm_config={},
    )
    # 关闭无关功能，专注 S8 测试
    e.hyde_enabled = False
    e.reflection_enabled = False
    e.working_memory_enabled = False
    e.context_compress_enabled = False
    e.user_profile_enabled = True
    e.user_profile_ttl = 60.0
    e.user_profile_top_k = 5
    # 清空缓存状态
    e._user_profile_cache = None
    e._user_profile_cached_at = 0.0
    return e


# ---------------------------------------------------------------------------
# S8: 持久化用户上下文测试
# ---------------------------------------------------------------------------

class TestUserProfileLoading:
    """_load_user_profile 的启用/禁用/缓存/过滤/降级路径。"""

    @pytest.mark.asyncio
    async def test_returns_empty_when_disabled(self, engine):
        """user_profile_enabled=False 时不查 memory，返回空字符串。"""
        engine.user_profile_enabled = False
        result = await engine._load_user_profile()
        assert result == ""
        engine.memory.query.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_relevant_facts(self, engine):
        """memory.query 返回无 [preference]/[goal] 的行时返回空字符串。"""
        engine.memory.query = AsyncMock(return_value=[
            {"content": "[fact] 用户在开发WeBrain"},
        ])
        result = await engine._load_user_profile()
        assert result == ""

    @pytest.mark.asyncio
    async def test_filters_only_preference_and_goal(self, engine):
        """只保留 [preference] 和 [goal] 标签的 L3 事实。"""
        engine.memory.query = AsyncMock(return_value=[
            {"content": "[preference] 用户喜欢简洁代码"},
            {"content": "[goal] 用户希望学习 Python"},
            {"content": "[fact] 用户在开发WeBrain"},
            {"content": "[decision] 使用 FastAPI"},
        ])
        result = await engine._load_user_profile()
        assert "[preference] 用户喜欢简洁代码" in result
        assert "[goal] 用户希望学习 Python" in result
        assert "[fact]" not in result
        assert "[decision]" not in result

    @pytest.mark.asyncio
    async def test_result_cached_within_ttl(self, engine):
        """TTL 内第二次调用直接返回缓存，不再查 DB。"""
        engine.memory.query = AsyncMock(return_value=[
            {"content": "[preference] 用户喜欢简洁代码"},
        ])
        # 首次加载
        first = await engine._load_user_profile()
        assert first != ""
        assert engine.memory.query.await_count == 1

        # TTL 内再次调用：不应再查 DB
        second = await engine._load_user_profile()
        assert second == first
        assert engine.memory.query.await_count == 1  # 仍为 1

    @pytest.mark.asyncio
    async def test_cache_expires_after_ttl(self, engine):
        """TTL 过期后再次调用会重新查 DB。"""
        engine.user_profile_ttl = 0.01  # 10ms TTL，几乎立刻过期
        engine.memory.query = AsyncMock(return_value=[
            {"content": "[preference] 用户喜欢简洁代码"},
        ])
        await engine._load_user_profile()
        assert engine.memory.query.await_count == 1

        # 等待 TTL 过期
        await asyncio.sleep(0.02)

        await engine._load_user_profile()
        assert engine.memory.query.await_count == 2  # 重新查

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_query_error(self, engine):
        """memory.query 抛异常时返回空字符串，不传播异常。"""
        engine.memory.query = AsyncMock(side_effect=RuntimeError("DB 连接断开"))
        result = await engine._load_user_profile()
        assert result == ""

    @pytest.mark.asyncio
    async def test_error_path_suppresses_retry_storm(self, engine):
        """错误路径将空结果写入缓存，TTL 内下次调用不再重试 DB。

        修复前：error 时不更新缓存，每次对话都会重试失败的 DB 查询，
        使 P95 延迟随并发数线性增长（retry storm）。
        修复后：失败结果也进缓存，TTL 内只失败一次，其余命中缓存。
        """
        engine.user_profile_ttl = 60.0  # 足够长，确保缓存有效
        engine.memory.query = AsyncMock(side_effect=RuntimeError("DB 不可用"))

        # 第一次调用：出错，写入空缓存
        first = await engine._load_user_profile()
        assert first == ""
        assert engine.memory.query.await_count == 1

        # TTL 内第二次调用：应命中缓存，不再查 DB
        second = await engine._load_user_profile()
        assert second == ""
        assert engine.memory.query.await_count == 1  # 仍为 1，未重试

    @pytest.mark.asyncio
    async def test_concurrent_requests_query_db_only_once(self, engine):
        """高并发下多个协程同时发现缓存过期，只应查一次 DB（惊群防护）。"""
        # 故意用 asyncio.sleep 模拟慢 DB，让并发协程都阻塞在 query 上
        query_call_count = 0

        async def slow_query(*args, **kwargs):
            nonlocal query_call_count
            query_call_count += 1
            await asyncio.sleep(0.01)  # 模拟 10ms DB 延迟
            return [{"content": "[preference] 用户喜欢简洁代码"}]

        engine.memory.query = slow_query
        engine._user_profile_cache = None
        engine._user_profile_cached_at = 0.0

        # 同时发起 5 个并发请求
        results = await asyncio.gather(*[engine._load_user_profile() for _ in range(5)])

        # 所有请求都应返回同一结果
        assert all(r == results[0] for r in results)
        # DB 只应被查一次（锁保护）
        assert query_call_count == 1

    @pytest.mark.asyncio
    async def test_profile_injected_into_system_prompt(self, engine):
        """user_profile_text 非空时，系统提示包含 '用户偏好与目标' 区块。"""
        profile_text = "- [preference] 用户喜欢简洁代码"
        # 直接调用 _build_system_prompt，不需要运行完整 chat() 路径
        prompt = await engine._build_system_prompt(
            agent_id="test-agent",
            memory_text="无相关记忆",
            user_profile_text=profile_text,
        )
        assert "用户偏好与目标" in prompt
        assert "[preference] 用户喜欢简洁代码" in prompt

    @pytest.mark.asyncio
    async def test_no_profile_section_when_profile_empty(self, engine):
        """user_profile_text 为空时，系统提示不含 '用户偏好与目标' 字样。"""
        prompt = await engine._build_system_prompt(
            agent_id="test-agent",
            memory_text="无相关记忆",
            user_profile_text="",
        )
        assert "用户偏好与目标" not in prompt
