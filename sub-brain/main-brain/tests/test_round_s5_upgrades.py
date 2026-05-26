"""Round S (fifth batch): S10 Conversation Anchor 单元测试"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from chat.chat_engine import ChatEngine


# ---------------------------------------------------------------------------
# 通用 Fixture
# ---------------------------------------------------------------------------

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
    # 仅关注 S10 测试，关闭其他功能
    e.hyde_enabled = False
    e.reflection_enabled = False
    e.working_memory_enabled = False
    e.context_compress_enabled = False
    e.user_profile_enabled = False
    e.kg_context_enabled = False
    e.conv_anchor_enabled = True
    e.conv_anchor_top_k = 2
    e.conv_anchor_days = 7
    e._anchored_sessions = set()
    return e


# ---------------------------------------------------------------------------
# S10: 会话锚点测试
# ---------------------------------------------------------------------------

class TestConversationAnchor:
    """_load_conversation_anchor 的完整路径测试。"""

    @pytest.mark.asyncio
    async def test_returns_empty_when_disabled(self, engine):
        """conv_anchor_enabled=False 时不查 memory，返回空字符串。"""
        engine.conv_anchor_enabled = False
        result = await engine._load_conversation_anchor("sid-1", "WeBrain 项目进展")
        assert result == ""
        engine.memory.query.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_only_fires_on_first_message(self, engine):
        """同一 session_id 的第二次调用跳过 DB 查询（已在 _anchored_sessions）。"""
        engine.memory.query = AsyncMock(return_value=[])
        # 第一次：触发 DB 查询
        await engine._load_conversation_anchor("sid-1", "查询内容")
        assert engine.memory.query.await_count == 1

        # 第二次（同 session_id）：跳过
        await engine._load_conversation_anchor("sid-1", "另一个查询")
        assert engine.memory.query.await_count == 1  # 仍为 1

    @pytest.mark.asyncio
    async def test_different_sessions_each_query_db(self, engine):
        """不同 session_id 各自独立触发一次 DB 查询。"""
        engine.memory.query = AsyncMock(return_value=[])
        await engine._load_conversation_anchor("sid-A", "内容A")
        await engine._load_conversation_anchor("sid-B", "内容B")
        assert engine.memory.query.await_count == 2

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_l2_found(self, engine):
        """memory.query 返回空时返回空字符串。"""
        engine.memory.query = AsyncMock(return_value=[])
        result = await engine._load_conversation_anchor("sid-1", "新话题")
        assert result == ""

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_recent_l2(self, engine):
        """过滤掉超出 conv_anchor_days 的摘要后为空时返回空字符串。"""
        # 返回 2 年前的记录
        engine.memory.query = AsyncMock(return_value=[
            {"content": "很久以前的对话", "created_at": "2020-01-01T00:00:00+00:00"}
        ])
        result = await engine._load_conversation_anchor("sid-1", "WeBrain")
        assert result == ""

    @pytest.mark.asyncio
    async def test_includes_recent_l2_summaries(self, engine):
        """有效期内的 L2 摘要出现在返回结果中。"""
        from datetime import datetime, timezone
        recent_ts = datetime.now(timezone.utc).isoformat()
        engine.memory.query = AsyncMock(return_value=[
            {"content": "上次讨论了 WeBrain 的记忆模块设计", "created_at": recent_ts}
        ])
        result = await engine._load_conversation_anchor("sid-1", "WeBrain 记忆")
        assert "WeBrain 的记忆模块设计" in result
        assert "近期相关对话摘要" in result

    @pytest.mark.asyncio
    async def test_respects_top_k_limit(self, engine):
        """最多返回 conv_anchor_top_k 条摘要。"""
        from datetime import datetime, timezone
        recent_ts = datetime.now(timezone.utc).isoformat()
        engine.conv_anchor_top_k = 1
        engine.memory.query = AsyncMock(return_value=[
            {"content": "摘要A", "created_at": recent_ts},
            {"content": "摘要B", "created_at": recent_ts},
            {"content": "摘要C", "created_at": recent_ts},
        ])
        result = await engine._load_conversation_anchor("sid-1", "WeBrain")
        # 只包含第一条
        assert "摘要A" in result
        assert "摘要B" not in result

    @pytest.mark.asyncio
    async def test_truncates_long_content(self, engine):
        """超过 200 字符的摘要内容被截断。"""
        from datetime import datetime, timezone
        recent_ts = datetime.now(timezone.utc).isoformat()
        long_content = "X" * 300
        engine.memory.query = AsyncMock(return_value=[
            {"content": long_content, "created_at": recent_ts}
        ])
        result = await engine._load_conversation_anchor("sid-1", "测试")
        # 截断后不超过 200 个 X
        assert "X" * 201 not in result
        assert "X" * 200 in result

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_error(self, engine):
        """memory.query 抛异常时返回空字符串，不传播异常。"""
        engine.memory.query = AsyncMock(side_effect=RuntimeError("DB 断开"))
        result = await engine._load_conversation_anchor("sid-1", "WeBrain")
        assert result == ""

    @pytest.mark.asyncio
    async def test_anchor_injected_into_system_prompt(self, engine):
        """conv_anchor_text 非空时，系统提示包含 '相关历史对话' 区块。"""
        anchor_text = "[近期相关对话摘要]\n- (2026-05-21) 上次讨论了 WeBrain 记忆设计"
        prompt = await engine._build_system_prompt(
            agent_id="test-agent",
            memory_text="无相关记忆",
            conv_anchor_text=anchor_text,
        )
        assert "相关历史对话" in prompt
        assert "WeBrain 记忆设计" in prompt

    @pytest.mark.asyncio
    async def test_no_anchor_section_when_empty(self, engine):
        """conv_anchor_text 为空时系统提示不含 '相关历史对话' 字样。"""
        prompt = await engine._build_system_prompt(
            agent_id="test-agent",
            memory_text="无相关记忆",
            conv_anchor_text="",
        )
        assert "相关历史对话" not in prompt
        assert "{{conv_anchor}}" not in prompt
