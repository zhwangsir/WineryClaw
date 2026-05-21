"""Round S (second batch): S5 Context Compression + S6 Proactive Intelligence 单元测试"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat.chat_engine import ChatEngine
from memory.dreaming_engine import DreamingEngine


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
    # 关闭无关的 Round S 功能，避免干扰
    e.hyde_enabled = False
    e.reflection_enabled = False
    e.working_memory_enabled = False
    e.context_compress_enabled = True
    e.context_compress_threshold = 6   # 低阈值方便测试
    e.context_compress_keep_recent = 2
    return e


@pytest.fixture
def dreaming_engine():
    mem = MagicMock()
    mem._connect = MagicMock()
    de = DreamingEngine(memory_manager=mem, llm_config={})
    return de


# ---------------------------------------------------------------------------
# S5: 上下文压缩测试
# ---------------------------------------------------------------------------

class TestContextCompression:
    """_compress_messages 的启用/禁用/触发/降级路径。"""

    @pytest.mark.asyncio
    async def test_no_compression_when_disabled(self, engine):
        """context_compress_enabled=False 时不压缩，原样返回。"""
        engine.context_compress_enabled = False
        engine._chat_completion = AsyncMock()
        messages = [{"role": "system", "content": "sys"}] + [
            {"role": "user", "content": f"msg{i}"} for i in range(10)
        ]
        result = await engine._compress_messages(messages)
        assert result is messages  # 同一对象，未复制
        engine._chat_completion.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_compression_below_threshold(self, engine):
        """消息数 <= threshold 时不触发压缩。"""
        engine._chat_completion = AsyncMock()
        messages = [{"role": "system", "content": "sys"},
                    {"role": "user", "content": "q"}]  # 2 条，低于 threshold=6
        result = await engine._compress_messages(messages)
        assert result == messages
        engine._chat_completion.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_compression_triggered_above_threshold(self, engine):
        """消息数 > threshold 时调用 LLM 压缩，并返回缩短后的列表。"""
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response("摘要：读取了文件A，写入了文件B。")
        )
        # 构造 8 条消息 (> threshold=6)
        messages = [
            {"role": "system", "content": "系统提示"},
            {"role": "user", "content": "用户问题"},
        ] + [
            {"role": "assistant" if i % 2 == 0 else "tool", "content": f"内容{i}"}
            for i in range(6)
        ]
        result = await engine._compress_messages(messages)
        # 结果应比原始更短
        assert len(result) < len(messages)
        # 必须保留 system 和 user 消息
        assert result[0]["role"] == "system"
        assert result[1]["role"] == "user"
        # 必须保留最近 KEEP_RECENT=2 条
        assert result[-2:] == messages[-2:]
        engine._chat_completion.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_llm_error(self, engine):
        """LLM 失败时返回原始 messages，不抛异常。"""
        engine._chat_completion = AsyncMock(side_effect=RuntimeError("网络断开"))
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q"},
        ] + [{"role": "assistant", "content": f"a{i}"} for i in range(6)]
        result = await engine._compress_messages(messages)
        assert result == messages  # 降级：原样返回

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_empty_summary(self, engine):
        """LLM 返回空摘要时原样返回 messages。"""
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response("")
        )
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q"},
        ] + [{"role": "assistant", "content": f"a{i}"} for i in range(6)]
        result = await engine._compress_messages(messages)
        assert result == messages

    @pytest.mark.asyncio
    async def test_structure_preserved_after_compression(self, engine):
        """压缩后的列表结构：[sys, user, system(summary), *recent]"""
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response("压缩摘要")
        )
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q"},
        ] + [{"role": "assistant", "content": f"a{i}"} for i in range(6)]
        result = await engine._compress_messages(messages)
        assert result[0]["role"] == "system"
        assert result[1]["role"] == "user"
        # 压缩摘要以 system 角色注入（避免 user→user 角色交替错误）
        assert result[2]["role"] == "system"
        assert "工具调用历史摘要" in result[2]["content"]


# ---------------------------------------------------------------------------
# S6: 主动洞察检测测试
# ---------------------------------------------------------------------------

class TestProactiveIntelligence:
    """DreamingEngine.detect_proactive_insights 的核心路径。"""

    @pytest.mark.asyncio
    async def test_no_insights_when_facts_below_minimum(self, dreaming_engine):
        """facts_created < MIN_FACTS_FOR_INSIGHT 时不调用 LLM，返回空列表。"""
        dreaming_engine._llm_call = AsyncMock()
        result = await dreaming_engine.detect_proactive_insights(
            facts_created=dreaming_engine.MIN_FACTS_FOR_INSIGHT - 1
        )
        assert result == []
        dreaming_engine._llm_call.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_insights_generated_and_buffered(self, dreaming_engine):
        """LLM 返回合法洞察时，写入 _insight_buffer 并返回列表。"""
        # 模拟数据库返回
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = [
            {"content": "[goal] 用户希望学习 Python"},
            {"content": "[preference] 用户喜欢简洁代码"},
            {"content": "[fact] 用户在开发 WeBrain 项目"},
        ]
        dreaming_engine.memory._connect.return_value = mock_conn

        dreaming_engine._llm_call = AsyncMock(
            return_value='[{"title": "Python 学习路径", "content": "您频繁提及 Python，建议系统制定学习计划。", "category": "goal"}]'
        )

        result = await dreaming_engine.detect_proactive_insights(
            facts_created=dreaming_engine.MIN_FACTS_FOR_INSIGHT
        )
        assert len(result) == 1
        assert result[0]["title"] == "Python 学习路径"
        assert result[0]["id"]  # uuid 不为空
        assert result[0]["read"] is False
        assert len(dreaming_engine._insight_buffer) == 1

    @pytest.mark.asyncio
    async def test_empty_llm_returns_no_insights(self, dreaming_engine):
        """LLM 返回空列表时，buffer 不变，返回空列表。"""
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = [
            {"content": "[fact] 事实A"},
            {"content": "[fact] 事实B"},
            {"content": "[fact] 事实C"},
        ]
        dreaming_engine.memory._connect.return_value = mock_conn
        dreaming_engine._llm_call = AsyncMock(return_value="[]")

        result = await dreaming_engine.detect_proactive_insights(
            facts_created=5
        )
        assert result == []
        assert len(dreaming_engine._insight_buffer) == 0

    @pytest.mark.asyncio
    async def test_malformed_json_returns_no_insights(self, dreaming_engine):
        """LLM 返回非法 JSON 时优雅降级，返回空列表。"""
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = [
            {"content": "[fact] 事实A"},
            {"content": "[fact] 事实B"},
            {"content": "[fact] 事实C"},
        ]
        dreaming_engine.memory._connect.return_value = mock_conn
        dreaming_engine._llm_call = AsyncMock(return_value="不是JSON")

        result = await dreaming_engine.detect_proactive_insights(
            facts_created=5
        )
        assert result == []

    @pytest.mark.asyncio
    async def test_buffer_max_cap_enforced(self, dreaming_engine):
        """超过 INSIGHT_BUFFER_MAX 时，最旧的洞察被 deque 自动淘汰。"""
        # 预填满 buffer
        for i in range(dreaming_engine.INSIGHT_BUFFER_MAX):
            dreaming_engine._insight_buffer.append({"id": f"old-{i}", "title": f"旧洞察{i}"})
        assert len(dreaming_engine._insight_buffer) == dreaming_engine.INSIGHT_BUFFER_MAX

        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = [
            {"content": "[fact] 新事实A"},
            {"content": "[fact] 新事实B"},
            {"content": "[fact] 新事实C"},
        ]
        dreaming_engine.memory._connect.return_value = mock_conn
        dreaming_engine._llm_call = AsyncMock(
            return_value='[{"title": "新洞察", "content": "新的洞察内容", "category": "info"}]'
        )

        await dreaming_engine.detect_proactive_insights(facts_created=5)
        # 容量不超过最大值
        assert len(dreaming_engine._insight_buffer) == dreaming_engine.INSIGHT_BUFFER_MAX
        # 最新洞察在末尾
        assert dreaming_engine._insight_buffer[-1]["title"] == "新洞察"
        # 最旧的被淘汰
        assert dreaming_engine._insight_buffer[0]["id"] == "old-1"

    @pytest.mark.asyncio
    async def test_no_insights_when_no_l3_rows(self, dreaming_engine):
        """数据库无 L3 行时直接返回空列表，不调用 LLM。"""
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = []
        dreaming_engine.memory._connect.return_value = mock_conn
        dreaming_engine._llm_call = AsyncMock()

        result = await dreaming_engine.detect_proactive_insights(facts_created=5)
        assert result == []
        dreaming_engine._llm_call.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_run_cycle_includes_insight_count(self, dreaming_engine):
        """run_cycle() 返回值应包含 proactive_insights 计数字段。"""
        dreaming_engine.consolidate_l1_to_l2 = AsyncMock(
            return_value={"consolidated": 1}
        )
        dreaming_engine.consolidate_l2_to_l3 = AsyncMock(
            return_value={"l2_processed": 1, "facts_created": 5, "facts_skipped_empty": 0}
        )
        dreaming_engine.promote_l3_to_l4 = AsyncMock(
            return_value={"promoted": 0, "evaluated": 0}
        )
        dreaming_engine.detect_proactive_insights = AsyncMock(return_value=[])

        result = await dreaming_engine.run_cycle()
        assert "proactive_insights" in result
        assert result["proactive_insights"] == 0
        dreaming_engine.detect_proactive_insights.assert_awaited_once_with(5)
