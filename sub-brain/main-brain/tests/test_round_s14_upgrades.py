"""Round S (fourteenth batch): S19 Memory Source Diversity Signal 单元测试"""

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
    # 只关注 S19，关闭其余功能减少干扰
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
    e.mem_signal_guide_enabled = False
    e.query_intent_enabled = False
    e.mem_source_diversity_enabled = True
    e.mem_confidence_threshold = 0.7  # L3/L4 边界
    return e


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def _mem(importance: float, **extra) -> dict:
    """构造带有指定 importance 的记忆记录。"""
    return {"content": "test content", "importance": importance, **extra}


# ---------------------------------------------------------------------------
# S19: 基础行为测试
# ---------------------------------------------------------------------------

class TestMemorySourceDiversityBasic:
    """_compute_memory_source_diversity_line 的基础路径测试。"""

    def test_returns_empty_when_disabled(self, engine):
        """mem_source_diversity_enabled=False 时始终返回空字符串。"""
        engine.mem_source_diversity_enabled = False
        result = engine._compute_memory_source_diversity_line([_mem(0.9)])
        assert result == ""

    def test_returns_empty_for_empty_list(self, engine):
        """relevant 为空时返回空字符串（无记忆可分析）。"""
        result = engine._compute_memory_source_diversity_line([])
        assert result == ""

    def test_line_starts_with_bracket(self, engine):
        """返回行以 '[记忆来源:' 开头。"""
        result = engine._compute_memory_source_diversity_line([_mem(0.9)])
        assert result.startswith("[记忆来源:")

    def test_line_is_single_line(self, engine):
        """返回行不含换行符（紧凑单行格式）。"""
        for importance in [0.9, 0.5, 0.3]:
            result = engine._compute_memory_source_diversity_line([_mem(importance)])
            assert "\n" not in result, f"importance={importance} hint contains newline"

    def test_line_is_compact(self, engine):
        """所有情形下返回行长度 < 100 字符。"""
        cases = [
            [_mem(0.9), _mem(0.8)],                 # all validated
            [_mem(0.3), _mem(0.4)],                 # all raw
            [_mem(0.9), _mem(0.9), _mem(0.3)],     # mixed, validated majority
            [_mem(0.3), _mem(0.3), _mem(0.9)],     # mixed, raw majority
        ]
        for relevant in cases:
            result = engine._compute_memory_source_diversity_line(relevant)
            assert len(result) < 100, f"Line too long ({len(result)}): {result}"

    def test_single_memory_validated(self, engine):
        """单条已验证记忆 → 已验证事实主导路径。"""
        result = engine._compute_memory_source_diversity_line([_mem(0.8)])
        assert "已验证事实主导" in result

    def test_single_memory_raw(self, engine):
        """单条未验证记忆 → 近期片段主导路径。"""
        result = engine._compute_memory_source_diversity_line([_mem(0.5)])
        assert "近期片段主导" in result


# ---------------------------------------------------------------------------
# S19: 全验证场景（All-Validated）
# ---------------------------------------------------------------------------

class TestAllValidated:
    """所有记忆 importance >= threshold 时的行为。"""

    def test_all_validated_label(self, engine):
        """全部 >= 0.7 → '已验证事实主导' 标签。"""
        result = engine._compute_memory_source_diversity_line(
            [_mem(0.7), _mem(0.8), _mem(0.95)]
        )
        assert "已验证事实主导" in result

    def test_all_validated_count_format(self, engine):
        """全部验证时，输出包含正确的 N/N 条数格式。"""
        result = engine._compute_memory_source_diversity_line(
            [_mem(0.8), _mem(0.9), _mem(1.0)]
        )
        assert "3/3条" in result

    def test_all_validated_positive_advice(self, engine):
        """全部验证时，包含正面引用建议。"""
        result = engine._compute_memory_source_diversity_line([_mem(0.7), _mem(0.9)])
        assert "可直接引用" in result

    def test_threshold_boundary_exact(self, engine):
        """恰好等于 threshold（0.7）时，被视为已验证（>=）。"""
        result = engine._compute_memory_source_diversity_line([_mem(0.7)])
        assert "已验证事实主导" in result

    def test_just_above_threshold(self, engine):
        """略高于 threshold 时，视为已验证。"""
        result = engine._compute_memory_source_diversity_line([_mem(0.701)])
        assert "已验证事实主导" in result


# ---------------------------------------------------------------------------
# S19: 全未验证场景（All-Raw）
# ---------------------------------------------------------------------------

class TestAllRaw:
    """所有记忆 importance < threshold 时的行为。"""

    def test_all_raw_label(self, engine):
        """全部 < 0.7 → '近期片段主导' 标签。"""
        result = engine._compute_memory_source_diversity_line(
            [_mem(0.3), _mem(0.4), _mem(0.6)]
        )
        assert "近期片段主导" in result

    def test_all_raw_count_format(self, engine):
        """全部未验证时，输出包含 N/N条未验证 格式。"""
        result = engine._compute_memory_source_diversity_line(
            [_mem(0.3), _mem(0.5)]
        )
        assert "2/2条未验证" in result

    def test_all_raw_caution_advice(self, engine):
        """全部未验证时，包含谨慎引用建议。"""
        result = engine._compute_memory_source_diversity_line([_mem(0.3)])
        assert "置信度低" in result

    def test_just_below_threshold(self, engine):
        """略低于 threshold（0.699）时，被视为未验证。"""
        result = engine._compute_memory_source_diversity_line([_mem(0.699)])
        assert "近期片段主导" in result


# ---------------------------------------------------------------------------
# S19: 混合场景（Mixed）
# ---------------------------------------------------------------------------

class TestMixed:
    """混合场景：部分已验证、部分未验证。"""

    def test_mixed_label(self, engine):
        """部分已验证 → '混合来源' 标签。"""
        result = engine._compute_memory_source_diversity_line(
            [_mem(0.9), _mem(0.3)]
        )
        assert "混合来源" in result

    def test_mixed_shows_both_counts(self, engine):
        """混合时，同时展示已验证条数和近期片段条数。"""
        result = engine._compute_memory_source_diversity_line(
            [_mem(0.9), _mem(0.8), _mem(0.3)]
        )
        assert "已验证 2条" in result
        assert "近期片段 1条" in result

    def test_mixed_majority_validated_positive_advice(self, engine):
        """已验证 > 50%（2/3）时，给出优先引用建议。"""
        result = engine._compute_memory_source_diversity_line(
            [_mem(0.9), _mem(0.8), _mem(0.3)]
        )
        assert "优先引用已验证事实" in result

    def test_mixed_majority_raw_caution_advice(self, engine):
        """已验证 < 50%（1/3）时，给出谨慎提示。"""
        result = engine._compute_memory_source_diversity_line(
            [_mem(0.9), _mem(0.3), _mem(0.4)]
        )
        assert "已验证事实较少" in result

    def test_mixed_50_50_positive_advice(self, engine):
        """已验证恰好 50%（1/2）时，归入正面引导（>= 0.5）。"""
        result = engine._compute_memory_source_diversity_line(
            [_mem(0.9), _mem(0.3)]
        )
        assert "优先引用已验证事实" in result

    def test_mixed_counts_correct_3_validated_1_raw(self, engine):
        """3 已验证 + 1 未验证的条数准确。"""
        result = engine._compute_memory_source_diversity_line(
            [_mem(0.9), _mem(0.8), _mem(0.75), _mem(0.3)]
        )
        assert "已验证 3条" in result
        assert "近期片段 1条" in result


# ---------------------------------------------------------------------------
# S19: 自定义阈值
# ---------------------------------------------------------------------------

class TestCustomThreshold:
    """通过修改 mem_confidence_threshold 验证阈值可配置性。"""

    def test_custom_threshold_high(self, engine):
        """阈值设为 0.9 时，importance=0.8 被视为未验证（< 0.9）。"""
        engine.mem_confidence_threshold = 0.9
        result = engine._compute_memory_source_diversity_line([_mem(0.8)])
        assert "近期片段主导" in result

    def test_custom_threshold_low(self, engine):
        """阈值设为 0.3 时，importance=0.5 被视为已验证（>= 0.3）。"""
        engine.mem_confidence_threshold = 0.3
        result = engine._compute_memory_source_diversity_line([_mem(0.5)])
        assert "已验证事实主导" in result


# ---------------------------------------------------------------------------
# S19: 与其他 S 系列信号的集成测试
# ---------------------------------------------------------------------------

class TestSourceDiversityIntegration:
    """S19 与 memory_text 组装流水线的集成测试。"""

    def test_not_appended_to_sentinel(self, engine):
        """'无相关记忆' sentinel 时，diversity_line 不追加（与 S11/S15 保持一致）。"""
        diversity_line = engine._compute_memory_source_diversity_line([_mem(0.9)])
        memory_text = "无相关记忆"
        # 模拟 pipeline 中的 guard
        if diversity_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{diversity_line}"
        assert memory_text == "无相关记忆"

    def test_appended_to_real_memory(self, engine):
        """有真实记忆时，diversity_line 追加到 memory_text 末尾。"""
        diversity_line = engine._compute_memory_source_diversity_line([_mem(0.9)])
        memory_text = "- 用户是软件工程师"
        if diversity_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{diversity_line}"
        assert "用户是软件工程师" in memory_text
        assert "[记忆来源:" in memory_text

    def test_appears_after_s15_before_s16(self, engine):
        """S19 出现在 S15 时效信号之后、S16 知识缺口之前。"""
        from datetime import datetime, timezone, timedelta
        engine.mem_freshness_enabled = True
        engine.knowledge_gap_enabled = True
        engine.mem_source_diversity_enabled = True

        now = datetime.now(timezone.utc)
        relevant = [
            {
                "content": "recent validated fact",
                "importance": 0.9,
                "created_at": (now - timedelta(days=2)).isoformat(),
            }
        ]
        freshness_line = engine._compute_memory_freshness_line(relevant)
        diversity_line = engine._compute_memory_source_diversity_line(relevant)
        gap_hint = engine._compute_knowledge_gap_hint(relevant)

        memory_text = "- high fact"
        if freshness_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{freshness_line}"
        if diversity_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{diversity_line}"
        if gap_hint:
            if memory_text == "无相关记忆":
                memory_text = gap_hint
            else:
                memory_text = f"{memory_text}\n{gap_hint}"

        # S15 在 S19 之前
        if freshness_line and diversity_line:
            assert memory_text.index("[记忆时效:") < memory_text.index("[记忆来源:")

    def test_s11_and_s19_both_present(self, engine):
        """S11 置信度和 S19 来源多样性可同时出现在 memory_text 中。"""
        engine.mem_confidence_enabled = True
        engine.mem_source_diversity_enabled = True
        relevant = [_mem(0.9)]
        conf_line = engine._compute_memory_confidence_line(relevant)
        diversity_line = engine._compute_memory_source_diversity_line(relevant)
        # 两者均非空
        assert conf_line != ""
        assert diversity_line != ""
        # 内容不同（互补而非重复）
        assert conf_line != diversity_line
        # 两行格式前缀不同
        assert conf_line.startswith("[记忆支撑:")
        assert diversity_line.startswith("[记忆来源:")

    def test_no_output_for_empty_relevant(self, engine):
        """relevant=[] 时，diversity_line 为空，memory_text 保持不变。"""
        memory_text = "无相关记忆"
        diversity_line = engine._compute_memory_source_diversity_line([])
        if diversity_line and memory_text != "无相关记忆":
            memory_text = f"{memory_text}\n{diversity_line}"
        assert memory_text == "无相关记忆"
        assert diversity_line == ""

    def test_importance_none_treated_as_zero(self, engine):
        """importance 为 None 的记忆（如旧数据）按 0.0 处理 → 视为未验证。"""
        relevant = [{"content": "old record"}]  # 无 importance 字段
        result = engine._compute_memory_source_diversity_line(relevant)
        # 0.0 < 0.7 → 近期片段主导
        assert "近期片段主导" in result


# ---------------------------------------------------------------------------
# S19: 端到端集成测试 — 验证 diversity_line 确实出现在 chat() 的 system prompt 中
# ---------------------------------------------------------------------------

class TestSourceDiversityEndToEnd:
    """验证 S19 diversity_line 通过 chat() 真实路径注入 LLM system prompt。

    解决代码审查 HIGH 问题：之前的集成测试均手动模拟 pipeline，
    本类通过 patch _chat_completion 捕获实际传入 LLM 的 messages 来验证集成。
    """

    @pytest.mark.asyncio
    async def test_diversity_line_reaches_system_prompt_all_validated(
        self, mock_memory, mock_sub_brain
    ):
        """全部已验证记忆时，system prompt 中包含 '[记忆来源: 已验证事实主导'。"""
        from unittest.mock import patch, AsyncMock

        # 构造 engine，关闭所有非 S19 功能以最小化干扰
        from chat.chat_engine import ChatEngine
        engine = ChatEngine(
            memory_manager=mock_memory,
            sub_brain_client=mock_sub_brain,
            llm_config={},
        )
        engine.hyde_enabled = False
        engine.reflection_enabled = False
        engine.working_memory_enabled = False
        engine.context_compress_enabled = False
        engine.user_profile_enabled = False
        engine.kg_context_enabled = False
        engine.conv_anchor_enabled = False
        engine.mem_confidence_enabled = False
        engine.mem_tiered_enabled = False
        engine.l4_anchor_enabled = False
        engine.temporal_context_enabled = False
        engine.mem_freshness_enabled = False
        engine.knowledge_gap_enabled = False
        engine.mem_signal_guide_enabled = False
        engine.query_intent_enabled = False
        engine.mem_source_diversity_enabled = True
        engine.planner_enabled = False

        # mock: 返回已验证记忆（importance >= 0.7）
        mock_memory.query = AsyncMock(return_value=[
            {"id": "m1", "content": "用户是软件工程师", "importance": 0.9},
            {"id": "m2", "content": "用户偏好 Python", "importance": 0.8},
        ])

        # 捕获传入 _chat_completion 的 messages
        captured_messages: list = []

        async def mock_chat_completion(messages, **kwargs):
            captured_messages.extend(messages)
            return {
                "choices": [{"message": {"content": "测试回复", "tool_calls": []}}]
            }

        with patch.object(engine, "_chat_completion", side_effect=mock_chat_completion):
            with patch.object(engine, "_retrieve_rag_context", return_value=("", [])):
                await engine.chat("你好", session_id="test-session")

        # 系统提示是 messages[0]（role=system）
        assert len(captured_messages) >= 1
        system_msg = next(
            (m for m in captured_messages if m.get("role") == "system"), None
        )
        assert system_msg is not None, "system prompt not found in captured messages"
        system_content = system_msg["content"]
        assert "[记忆来源:" in system_content, (
            f"S19 diversity_line missing from system prompt.\n"
            f"system prompt excerpt:\n{system_content[:500]}"
        )
        assert "已验证事实主导" in system_content

    @pytest.mark.asyncio
    async def test_diversity_line_absent_when_disabled(
        self, mock_memory, mock_sub_brain
    ):
        """mem_source_diversity_enabled=False 时，system prompt 中不含 '[记忆来源:'。"""
        from unittest.mock import patch, AsyncMock
        from chat.chat_engine import ChatEngine

        engine = ChatEngine(
            memory_manager=mock_memory,
            sub_brain_client=mock_sub_brain,
            llm_config={},
        )
        engine.hyde_enabled = False
        engine.reflection_enabled = False
        engine.working_memory_enabled = False
        engine.context_compress_enabled = False
        engine.user_profile_enabled = False
        engine.kg_context_enabled = False
        engine.conv_anchor_enabled = False
        engine.mem_confidence_enabled = False
        engine.mem_tiered_enabled = False
        engine.l4_anchor_enabled = False
        engine.temporal_context_enabled = False
        engine.mem_freshness_enabled = False
        engine.knowledge_gap_enabled = False
        engine.mem_signal_guide_enabled = False
        engine.query_intent_enabled = False
        engine.mem_source_diversity_enabled = False  # 关闭 S19
        engine.planner_enabled = False

        mock_memory.query = AsyncMock(return_value=[
            {"id": "m1", "content": "用户是工程师", "importance": 0.9},
        ])

        captured_messages: list = []

        async def mock_chat_completion(messages, **kwargs):
            captured_messages.extend(messages)
            return {
                "choices": [{"message": {"content": "测试回复", "tool_calls": []}}]
            }

        with patch.object(engine, "_chat_completion", side_effect=mock_chat_completion):
            with patch.object(engine, "_retrieve_rag_context", return_value=("", [])):
                await engine.chat("你好", session_id="test-session")

        system_msg = next(
            (m for m in captured_messages if m.get("role") == "system"), None
        )
        assert system_msg is not None
        assert "[记忆来源:" not in system_msg["content"]
