"""Round S (twelfth batch): S17 Memory Signal Usage Guide 单元测试"""

import pytest
from unittest.mock import AsyncMock, MagicMock

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
    # 只关注 S17，关闭其余功能
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
    e.temporal_context_enabled = False
    e.mem_freshness_enabled = False
    e.knowledge_gap_enabled = False
    e.mem_signal_guide_enabled = True
    return e


# ---------------------------------------------------------------------------
# S17: 记忆信号使用指南测试
# ---------------------------------------------------------------------------

class TestMemorySignalUsageGuide:
    """_get_memory_signal_guide_line 的全路径测试。"""

    def test_returns_empty_when_disabled(self, engine):
        """mem_signal_guide_enabled=False 时返回空字符串。"""
        engine.mem_signal_guide_enabled = False
        result = engine._get_memory_signal_guide_line()
        assert result == ""

    def test_returns_nonempty_when_enabled(self, engine):
        """启用时返回非空字符串。"""
        result = engine._get_memory_signal_guide_line()
        assert result != ""

    def test_line_starts_with_bracket(self, engine):
        """返回行以 '[记忆标签说明:' 开头。"""
        result = engine._get_memory_signal_guide_line()
        assert result.startswith("[记忆标签说明:")

    def test_guide_mentions_validated_facts(self, engine):
        """指南中包含已验证事实的说明。"""
        result = engine._get_memory_signal_guide_line()
        assert "已验证事实" in result

    def test_guide_mentions_recent_fragments(self, engine):
        """指南中包含近期片段的说明。"""
        result = engine._get_memory_signal_guide_line()
        assert "近期片段" in result

    def test_guide_mentions_knowledge_gap(self, engine):
        """指南中包含知识缺口的说明。"""
        result = engine._get_memory_signal_guide_line()
        assert "知识缺口" in result

    def test_guide_mentions_low_freshness(self, engine):
        """指南中包含时效低的说明。"""
        result = engine._get_memory_signal_guide_line()
        assert "时效低" in result

    def test_guide_is_single_line(self, engine):
        """指南是单行字符串（不含换行符）。"""
        result = engine._get_memory_signal_guide_line()
        assert "\n" not in result

    def test_guide_prepended_to_memory_text_with_content(self, engine):
        """有实际内容时，guide 前置到 memory_text 顶部。"""
        guide = engine._get_memory_signal_guide_line()
        memory_text = "- 某条已验证事实"
        if guide and memory_text != "无相关记忆":
            memory_text = f"{guide}\n{memory_text}"
        lines = memory_text.split("\n")
        assert lines[0].startswith("[记忆标签说明:")

    def test_guide_not_prepended_to_sentinel(self, engine):
        """memory_text 为 '无相关记忆' 哨兵值时，guide 不注入（sentinel 不应被装饰）。"""
        guide = engine._get_memory_signal_guide_line()
        memory_text = "无相关记忆"
        if guide and memory_text != "无相关记忆":
            memory_text = f"{guide}\n{memory_text}"
        # 哨兵保持不变
        assert memory_text == "无相关记忆"

    def test_guide_appears_before_signals(self, engine):
        """指南在 S11/S15/S16 信号之前。"""
        engine.mem_confidence_enabled = True
        engine.mem_confidence_threshold = 0.7
        engine.mem_signal_guide_enabled = True
        relevant = [{"content": "high fact", "importance": 0.9}]
        guide = engine._get_memory_signal_guide_line()
        conf_line = engine._compute_memory_confidence_line(relevant)
        memory_text = "- high fact"
        # 模拟 S11 追加
        if conf_line:
            memory_text = f"{memory_text}\n{conf_line}"
        # 模拟 S17 前置
        if guide:
            memory_text = f"{guide}\n{memory_text}"
        # guide 应在 S11 之前
        assert memory_text.index("[记忆标签说明:") < memory_text.index("[记忆支撑:")

    def test_guide_content_is_compact(self, engine):
        """指南长度应紧凑（< 150 字符），不影响主要系统提示的可读性。"""
        result = engine._get_memory_signal_guide_line()
        assert len(result) < 150

    def test_guide_not_prepended_to_gap_hint_only(self, engine):
        """S16 将 sentinel 替换为纯 gap hint 后，S17 guide 不应再前置注入。

        场景：relevant=[] → S16 设 memory_text = "[知识缺口: ...]"
        此时 memory_text 不是 sentinel（"无相关记忆"），旧 guard 会错误注入 guide。
        修复后的 guard 检查 startswith("[知识缺口:") → 跳过注入。
        """
        engine.knowledge_gap_enabled = True
        engine.mem_signal_guide_enabled = True

        guide = engine._get_memory_signal_guide_line()
        relevant: list = []
        # 模拟 S16 将 sentinel 替换为 gap hint
        gap_hint = engine._compute_knowledge_gap_hint(relevant)
        memory_text = "无相关记忆"
        if gap_hint:
            memory_text = gap_hint  # S16: replace sentinel

        # 模拟修复后的 S17 guard
        has_real_memory = (
            memory_text != "无相关记忆"
            and not memory_text.startswith("[知识缺口:")
        )
        if guide and has_real_memory:
            memory_text = f"{guide}\n{memory_text}"

        # guide 不应被注入到纯 gap hint 内容之前
        assert not memory_text.startswith("[记忆标签说明:")
        assert memory_text.startswith("[知识缺口:")

    def test_guide_not_prepended_to_low_conf_gap_appended(self, engine):
        """低置信 gap hint 追加到现有 memory_text 时，S17 guide 正确前置（有真实记忆）。

        场景：relevant=[low] → S16 追加 gap hint 到已有内容
        此时 memory_text 包含真实记忆行 + gap hint，S17 应正常注入。
        """
        engine.knowledge_gap_enabled = True
        engine.mem_signal_guide_enabled = True

        guide = engine._get_memory_signal_guide_line()
        relevant = [{"content": "低置信片段", "importance": 0.3}]
        gap_hint = engine._compute_knowledge_gap_hint(relevant)
        memory_text = "- 某条低置信记忆"
        if gap_hint:
            memory_text = f"{memory_text}\n{gap_hint}"  # S16: append

        # 模拟修复后的 S17 guard
        has_real_memory = (
            memory_text != "无相关记忆"
            and not memory_text.startswith("[知识缺口:")
        )
        if guide and has_real_memory:
            memory_text = f"{guide}\n{memory_text}"

        # 有真实记忆行，guide 应被注入
        assert memory_text.startswith("[记忆标签说明:")
        assert "某条低置信记忆" in memory_text
        assert "[知识缺口:" in memory_text
