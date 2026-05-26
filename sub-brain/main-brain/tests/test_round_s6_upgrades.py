"""Round S (sixth batch): S11 Memory Confidence Grounding 单元测试"""

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
    # 仅关注 S11 测试，关闭其他功能
    e.hyde_enabled = False
    e.reflection_enabled = False
    e.working_memory_enabled = False
    e.context_compress_enabled = False
    e.user_profile_enabled = False
    e.kg_context_enabled = False
    e.conv_anchor_enabled = False
    e.mem_confidence_enabled = True
    e.mem_confidence_threshold = 0.7
    return e


# ---------------------------------------------------------------------------
# S11: 记忆置信度标注测试
# ---------------------------------------------------------------------------

class TestMemoryConfidenceGrounding:
    """_compute_memory_confidence_line 的全路径测试。"""

    def test_returns_empty_when_disabled(self, engine):
        """mem_confidence_enabled=False 时，任何输入都返回空字符串。"""
        engine.mem_confidence_enabled = False
        result = engine._compute_memory_confidence_line([
            {"content": "fact A", "importance": 0.9},
        ])
        assert result == ""

    def test_returns_empty_for_empty_list(self, engine):
        """relevant 为空列表时返回空字符串（无相关记忆，不需要标注）。"""
        result = engine._compute_memory_confidence_line([])
        assert result == ""

    def test_high_confidence_two_validated(self, engine):
        """validated ≥ 2 → 置信度: 高。"""
        relevant = [
            {"content": "A", "importance": 0.8},
            {"content": "B", "importance": 0.7},
            {"content": "C", "importance": 0.5},
        ]
        result = engine._compute_memory_confidence_line(relevant)
        assert "置信度: 高" in result
        assert "3 条相关" in result
        assert "2 条已验证事实" in result

    def test_medium_confidence_one_validated(self, engine):
        """validated == 1 → 置信度: 中。"""
        relevant = [
            {"content": "A", "importance": 0.7},
            {"content": "B", "importance": 0.3},
        ]
        result = engine._compute_memory_confidence_line(relevant)
        assert "置信度: 中" in result
        assert "2 条相关" in result
        assert "1 条已验证事实" in result

    def test_low_confidence_zero_validated(self, engine):
        """validated == 0（全为 L1/L2 片段）→ 置信度: 低。"""
        relevant = [
            {"content": "raw L1", "importance": 0.4},
            {"content": "raw L2", "importance": 0.6},
        ]
        result = engine._compute_memory_confidence_line(relevant)
        assert "置信度: 低" in result
        assert "2 条相关" in result
        assert "0 条已验证事实" in result

    def test_threshold_boundary_exact(self, engine):
        """importance 恰好等于阈值（0.7）时，算作已验证。"""
        relevant = [{"content": "boundary fact", "importance": 0.7}]
        result = engine._compute_memory_confidence_line(relevant)
        assert "1 条已验证事实" in result
        assert "置信度: 中" in result

    def test_threshold_just_below(self, engine):
        """importance 恰好低于阈值（0.699）时，不算已验证。"""
        relevant = [{"content": "below threshold", "importance": 0.699}]
        result = engine._compute_memory_confidence_line(relevant)
        assert "0 条已验证事实" in result
        assert "置信度: 低" in result

    def test_custom_threshold(self, engine):
        """可通过 mem_confidence_threshold 自定义阈值。"""
        engine.mem_confidence_threshold = 0.5
        relevant = [
            {"content": "A", "importance": 0.6},  # ≥ 0.5 → validated
            {"content": "B", "importance": 0.4},  # < 0.5 → not validated
        ]
        result = engine._compute_memory_confidence_line(relevant)
        assert "1 条已验证事实" in result

    def test_missing_importance_treated_as_zero(self, engine):
        """importance 字段缺失时视为 0.0（不算已验证）。"""
        relevant = [
            {"content": "no importance field"},
            {"content": "explicit None", "importance": None},
        ]
        result = engine._compute_memory_confidence_line(relevant)
        assert "0 条已验证事实" in result
        assert "2 条相关" in result
        assert "置信度: 低" in result

    def test_all_l4_high_confidence(self, engine):
        """全部为 L4 记忆（importance=0.9）→ 置信度: 高。"""
        relevant = [
            {"content": "L4 identity A", "importance": 0.9},
            {"content": "L4 identity B", "importance": 0.9},
            {"content": "L4 identity C", "importance": 0.9},
        ]
        result = engine._compute_memory_confidence_line(relevant)
        assert "3 条已验证事实" in result
        assert "置信度: 高" in result

    def test_confidence_line_appended_to_memory_text(self, engine):
        """confidence 行格式：以 '[记忆支撑:' 开头，包含 '置信度:' 字样。"""
        relevant = [{"content": "fact", "importance": 0.8}]
        result = engine._compute_memory_confidence_line(relevant)
        assert result.startswith("[记忆支撑:")
        assert "置信度:" in result

    def test_invalid_threshold_env_falls_back_to_default(self, mock_memory, mock_sub_brain):
        """MEDIUM fix: WEBRAIN_MEM_CONFIDENCE_THRESHOLD 非法值时启动不崩溃，使用默认 0.7。"""
        import os
        original = os.environ.get("WEBRAIN_MEM_CONFIDENCE_THRESHOLD")
        try:
            os.environ["WEBRAIN_MEM_CONFIDENCE_THRESHOLD"] = "not_a_float"
            e = ChatEngine(memory_manager=mock_memory, sub_brain_client=mock_sub_brain, llm_config={})
            # 不应抛出 ValueError，且阈值回退到默认值 0.7
            assert e.mem_confidence_threshold == 0.7
        finally:
            if original is None:
                os.environ.pop("WEBRAIN_MEM_CONFIDENCE_THRESHOLD", None)
            else:
                os.environ["WEBRAIN_MEM_CONFIDENCE_THRESHOLD"] = original
