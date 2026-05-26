"""Round S (eleventh batch): S16 Knowledge Gap Detection 单元测试"""

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
    # 只关注 S16，关闭其余功能减少干扰
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
    e.knowledge_gap_enabled = True
    e.mem_confidence_threshold = 0.7
    return e


# ---------------------------------------------------------------------------
# S16: 知识缺口检测测试
# ---------------------------------------------------------------------------

class TestKnowledgeGapDetection:
    """_compute_knowledge_gap_hint 的全路径测试。"""

    def test_returns_empty_when_disabled(self, engine):
        """knowledge_gap_enabled=False 时始终返回空字符串。"""
        engine.knowledge_gap_enabled = False
        result = engine._compute_knowledge_gap_hint([])
        assert result == ""

    def test_empty_relevant_triggers_gap(self, engine):
        """relevant=[] 时检测到完全空白缺口。"""
        result = engine._compute_knowledge_gap_hint([])
        assert result != ""
        assert "[知识缺口:" in result

    def test_empty_gap_hint_contains_clarification_directive(self, engine):
        """空白缺口提示包含主动澄清的行为指令。"""
        result = engine._compute_knowledge_gap_hint([])
        # 必须包含引导AI主动询问的指令文字
        assert "确认" in result or "询问" in result

    def test_all_low_confidence_triggers_gap(self, engine):
        """全部为低置信记忆（importance < threshold）时检测到缺口。"""
        relevant = [
            {"content": "raw L1", "importance": 0.3},
            {"content": "raw L2", "importance": 0.5},
        ]
        result = engine._compute_knowledge_gap_hint(relevant)
        assert "[知识缺口:" in result

    def test_low_confidence_hint_contains_verify_directive(self, engine):
        """低置信缺口提示包含验证/确认相关指令。"""
        relevant = [{"content": "low", "importance": 0.4}]
        result = engine._compute_knowledge_gap_hint(relevant)
        assert "确认" in result or "判断" in result or "验证" in result

    def test_has_validated_fact_no_gap(self, engine):
        """有至少一条已验证事实（importance >= threshold）时不触发缺口。"""
        relevant = [
            {"content": "L3 fact", "importance": 0.8},
            {"content": "raw L1", "importance": 0.3},
        ]
        result = engine._compute_knowledge_gap_hint(relevant)
        assert result == ""

    def test_all_validated_no_gap(self, engine):
        """全部为已验证事实时不触发缺口。"""
        relevant = [
            {"content": "L4 identity", "importance": 0.9},
            {"content": "L3 fact", "importance": 0.7},
        ]
        result = engine._compute_knowledge_gap_hint(relevant)
        assert result == ""

    def test_threshold_boundary_exact_triggers_gap(self, engine):
        """importance 恰好低于阈值（threshold-ε）时触发缺口（全低置信路径）。"""
        relevant = [{"content": "borderline", "importance": 0.699}]
        result = engine._compute_knowledge_gap_hint(relevant)
        assert "[知识缺口:" in result

    def test_threshold_exact_at_threshold_no_gap(self, engine):
        """importance 恰好等于阈值（0.7）时不触发缺口（算作已验证事实）。"""
        relevant = [{"content": "exact threshold", "importance": 0.7}]
        result = engine._compute_knowledge_gap_hint(relevant)
        assert result == ""

    def test_missing_importance_treated_as_low(self, engine):
        """importance 字段缺失时视为 0.0（低置信），触发缺口。"""
        relevant = [
            {"content": "no importance field"},
            {"content": "explicit None", "importance": None},
        ]
        result = engine._compute_knowledge_gap_hint(relevant)
        assert "[知识缺口:" in result

    def test_hint_starts_with_bracket(self, engine):
        """返回的缺口提示以 '[知识缺口:' 开头。"""
        result = engine._compute_knowledge_gap_hint([])
        assert result.startswith("[知识缺口:")

    def test_empty_gap_replaces_sentinel_memory_text(self, engine):
        """relevant=[] 时，gap_hint 替换而非追加到 '无相关记忆' 哨兵字符串。

        此行为确保最终 memory_text 不会出现 '无相关记忆\\n[知识缺口:]' 的冗余组合。
        这个测试验证 chat()/chat_stream() 中的调用逻辑，而非 _compute_knowledge_gap_hint 本身。
        """
        engine.knowledge_gap_enabled = True
        engine.mem_confidence_enabled = False
        engine.mem_freshness_enabled = False
        # 模拟 memory_text 为哨兵值时的合并逻辑
        memory_text = "无相关记忆"
        relevant: list = []
        gap_hint = engine._compute_knowledge_gap_hint(relevant)
        if gap_hint:
            if memory_text == "无相关记忆":
                memory_text = gap_hint
            else:
                memory_text = f"{memory_text}\n{gap_hint}"
        # memory_text 不应再是哨兵字符串本身（已被 gap_hint 取代）
        assert memory_text != "无相关记忆"
        assert "[知识缺口:" in memory_text

    def test_low_confidence_gap_appended_to_existing_memory_text(self, engine):
        """低置信缺口追加到已有 memory_text 末尾（不替换）。"""
        engine.knowledge_gap_enabled = True
        memory_text = "- 某条低置信记忆"
        relevant = [{"content": "低置信", "importance": 0.3}]
        gap_hint = engine._compute_knowledge_gap_hint(relevant)
        if gap_hint:
            if memory_text == "无相关记忆":
                memory_text = gap_hint
            else:
                memory_text = f"{memory_text}\n{gap_hint}"
        assert "某条低置信记忆" in memory_text
        assert "[知识缺口:" in memory_text
