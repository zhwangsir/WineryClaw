"""Round S (ninth batch): S14 Temporal Context Injection 单元测试"""

import re
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

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
    mem.get_top_l4 = AsyncMock(return_value=[])
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
    # 只关注 S14，关闭其余功能减少干扰
    e.hyde_enabled = False
    e.reflection_enabled = False
    e.working_memory_enabled = False
    e.context_compress_enabled = False
    e.user_profile_enabled = False
    e.kg_context_enabled = False
    e.conv_anchor_enabled = False
    e.mem_confidence_enabled = False
    e.mem_tiered_enabled = False
    e.l4_anchor_enabled = False
    e.temporal_context_enabled = True
    return e


# ---------------------------------------------------------------------------
# S14: 时态上下文注入测试
# ---------------------------------------------------------------------------

class TestTemporalContextInjection:
    """_get_temporal_context_line 的全路径测试。"""

    def test_returns_empty_when_disabled(self, engine):
        """temporal_context_enabled=False 时返回空字符串。"""
        engine.temporal_context_enabled = False
        result = engine._get_temporal_context_line()
        assert result == ""

    def test_returns_nonempty_when_enabled(self, engine):
        """启用时返回非空字符串。"""
        result = engine._get_temporal_context_line()
        assert result != ""

    def test_line_format_starts_with_bracket(self, engine):
        """返回行以 '[当前时间:' 开头。"""
        result = engine._get_temporal_context_line()
        assert result.startswith("[当前时间:")

    def test_line_contains_date(self, engine):
        """返回行包含 YYYY-MM-DD 格式日期。"""
        result = engine._get_temporal_context_line()
        assert re.search(r"\d{4}-\d{2}-\d{2}", result)

    def test_line_contains_time(self, engine):
        """返回行包含 HH:MM 格式时间。"""
        result = engine._get_temporal_context_line()
        assert re.search(r"\d{2}:\d{2}", result)

    def test_line_contains_chinese_weekday(self, engine):
        """返回行包含中文星期（周一 ~ 周日）。"""
        result = engine._get_temporal_context_line()
        assert any(wd in result for wd in ["周一", "周二", "周三", "周四", "周五", "周六", "周日"])

    def test_weekday_matches_actual_date(self, engine):
        """返回的中文星期与 datetime.now().weekday() 实际对应。"""
        weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
        now = datetime.now()
        expected_wd = weekdays[now.weekday()]
        result = engine._get_temporal_context_line()
        assert expected_wd in result

    def test_date_matches_actual_date(self, engine):
        """返回的日期字符串与 datetime.now().strftime('%Y-%m-%d') 一致。"""
        now = datetime.now()
        expected_date = now.strftime("%Y-%m-%d")
        result = engine._get_temporal_context_line()
        assert expected_date in result

    @pytest.mark.asyncio
    async def test_injected_as_prefix_in_build_system_prompt(self, engine):
        """_build_system_prompt 启用时，temporal_context_line 前置到提示开头。"""
        engine.temporal_context_enabled = True
        temporal_line = engine._get_temporal_context_line()
        prompt = await engine._build_system_prompt(
            agent_id="test-agent",
            memory_text="无相关记忆",
            temporal_context_line=temporal_line,
        )
        assert prompt.startswith(temporal_line)

    @pytest.mark.asyncio
    async def test_not_injected_when_empty(self, engine):
        """temporal_context_line="" 时，系统提示不含 [当前时间: 字样。"""
        prompt = await engine._build_system_prompt(
            agent_id="test-agent",
            memory_text="无相关记忆",
            temporal_context_line="",
        )
        assert "[当前时间:" not in prompt

    @pytest.mark.asyncio
    async def test_slot_substitution_when_present(self, engine):
        """系统提示模板含 {{current_time}} 槽位时，执行槽位替换而非前置。"""
        engine.temporal_context_enabled = True
        # 直接 mock _fetch_agent_config 返回含槽位的 system prompt
        engine._fetch_agent_config = AsyncMock(return_value={
            "name": "TestAgent",
            "role": "assistant",
            "systemPrompt": "你好。{{current_time}}\n\n记忆：{{memory}}",
            "tools": [],
        })
        temporal_line = "[当前时间: 2026-05-22 周五 10:00]"
        prompt = await engine._build_system_prompt(
            agent_id="test-agent",
            memory_text="无",
            temporal_context_line=temporal_line,
        )
        assert temporal_line in prompt
        assert "{{current_time}}" not in prompt
        # 槽位替换时不应额外前置一次
        assert prompt.count(temporal_line) == 1

    @pytest.mark.asyncio
    async def test_current_time_slot_cleaned_when_disabled(self, engine):
        """temporal_context_enabled=False 时，{{current_time}} 槽位被清空而非残留。"""
        engine.temporal_context_enabled = False
        engine._fetch_agent_config = AsyncMock(return_value={
            "name": "TestAgent",
            "role": "assistant",
            "systemPrompt": "你好。{{current_time}}\n\n记忆：{{memory}}",
            "tools": [],
        })
        prompt = await engine._build_system_prompt(
            agent_id="test-agent",
            memory_text="无",
            temporal_context_line="",   # disabled → empty string
        )
        assert "{{current_time}}" not in prompt
        assert "[当前时间:" not in prompt
