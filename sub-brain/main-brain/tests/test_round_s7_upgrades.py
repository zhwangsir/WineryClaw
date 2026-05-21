"""Round S (seventh batch): S12 Importance-Tiered Memory Display 单元测试"""

import pytest
from unittest.mock import MagicMock, AsyncMock

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
    e.hyde_enabled = False
    e.reflection_enabled = False
    e.working_memory_enabled = False
    e.context_compress_enabled = False
    e.user_profile_enabled = False
    e.kg_context_enabled = False
    e.conv_anchor_enabled = False
    e.mem_confidence_enabled = True
    e.mem_tiered_enabled = True
    e.mem_confidence_threshold = 0.7
    return e


# ---------------------------------------------------------------------------
# S12: 分层记忆展示测试
# ---------------------------------------------------------------------------

class TestTieredMemoryDisplay:
    """_format_tiered_memory_text 的全路径测试。"""

    def test_returns_empty_for_empty_list(self, engine):
        """relevant 为空时返回空字符串。"""
        result = engine._format_tiered_memory_text([])
        assert result == ""

    def test_flat_fallback_when_disabled(self, engine):
        """mem_tiered_enabled=False 时降级为扁平格式，无分层标题。"""
        engine.mem_tiered_enabled = False
        relevant = [
            {"content": "A", "importance": 0.9},
            {"content": "B", "importance": 0.3},
        ]
        result = engine._format_tiered_memory_text(relevant)
        assert "- A" in result
        assert "- B" in result
        assert "[已验证事实]" not in result
        assert "[近期对话片段]" not in result

    def test_validated_section_for_high_importance(self, engine):
        """importance ≥ 0.7 的记忆出现在 [已验证事实] 区块。"""
        relevant = [
            {"content": "L3 fact", "importance": 0.8},
        ]
        result = engine._format_tiered_memory_text(relevant)
        assert "[已验证事实]" in result
        assert "L3 fact" in result
        assert "[近期对话片段]" not in result  # 只有一类时不出现另一标题

    def test_raw_section_for_low_importance(self, engine):
        """importance < 0.7 的记忆出现在 [近期对话片段] 区块。"""
        relevant = [
            {"content": "raw L1 snippet", "importance": 0.4},
        ]
        result = engine._format_tiered_memory_text(relevant)
        assert "[近期对话片段]" in result
        assert "raw L1 snippet" in result
        assert "[已验证事实]" not in result

    def test_both_sections_appear_when_mixed(self, engine):
        """混合 importance 时两个区块都出现，已验证区块在前。"""
        relevant = [
            {"content": "validated", "importance": 0.9},
            {"content": "raw", "importance": 0.4},
        ]
        result = engine._format_tiered_memory_text(relevant)
        assert "[已验证事实]" in result
        assert "[近期对话片段]" in result
        # 已验证在前
        assert result.index("[已验证事实]") < result.index("[近期对话片段]")

    def test_validated_content_before_raw_content(self, engine):
        """已验证事实的内容排列在近期片段内容之前。"""
        relevant = [
            {"content": "raw fragment", "importance": 0.3},
            {"content": "solid fact", "importance": 0.8},
        ]
        result = engine._format_tiered_memory_text(relevant)
        assert result.index("solid fact") < result.index("raw fragment")

    def test_missing_content_skipped(self, engine):
        """content 为空或缺失的条目不出现在结果中。"""
        relevant = [
            {"content": "", "importance": 0.9},
            {"importance": 0.8},  # 无 content 键
            {"content": "real fact", "importance": 0.9},
        ]
        result = engine._format_tiered_memory_text(relevant)
        assert "real fact" in result
        # 空内容不应留下空行 "- "
        lines = [l for l in result.split("\n") if l.strip() == "-"]
        assert len(lines) == 0

    def test_no_orphan_header_when_all_content_empty(self, engine):
        """HIGH fix: 同组所有条目 content 为空时，该组的区块标题不应出现。"""
        relevant = [
            {"content": "", "importance": 0.9},   # validated, but empty
            {"content": "有内容的片段", "importance": 0.3},  # raw, has content
        ]
        result = engine._format_tiered_memory_text(relevant)
        # 已验证组无实际内容，不应出现其标题
        assert "[已验证事实]" not in result
        # 近期片段组有内容，应出现
        assert "[近期对话片段]" in result
        assert "有内容的片段" in result

    def test_missing_importance_treated_as_raw(self, engine):
        """importance 字段缺失时视为 0.0，归入近期对话片段区块。"""
        relevant = [{"content": "no importance"}]
        result = engine._format_tiered_memory_text(relevant)
        assert "[近期对话片段]" in result
        assert "no importance" in result

    def test_threshold_boundary_in_validated(self, engine):
        """importance == 0.7（恰好等于阈值）进入已验证事实区块。"""
        relevant = [{"content": "boundary", "importance": 0.7}]
        result = engine._format_tiered_memory_text(relevant)
        assert "[已验证事实]" in result

    def test_custom_threshold_respected(self, engine):
        """自定义阈值（0.5）时重新划分两组。"""
        engine.mem_confidence_threshold = 0.5
        relevant = [
            {"content": "above", "importance": 0.6},  # >= 0.5 → validated
            {"content": "below", "importance": 0.4},  # < 0.5 → raw
        ]
        result = engine._format_tiered_memory_text(relevant)
        assert result.index("[已验证事实]") < result.index("[近期对话片段]")
        assert result.index("above") < result.index("below")

    def test_s11_confidence_line_combined_with_s12_tiered(self, engine):
        """S11 置信度行与 S12 分层格式协同：置信度行在最后。"""
        relevant = [
            {"content": "fact A", "importance": 0.9},
            {"content": "raw B", "importance": 0.5},
        ]
        tiered = engine._format_tiered_memory_text(relevant)
        conf = engine._compute_memory_confidence_line(relevant)
        combined = f"{tiered}\n{conf}" if conf else tiered
        # 已验证区块最先，近期片段居中，置信度行最后
        assert combined.index("[已验证事实]") < combined.index("[近期对话片段]")
        assert combined.index("[近期对话片段]") < combined.index("[记忆支撑:")
