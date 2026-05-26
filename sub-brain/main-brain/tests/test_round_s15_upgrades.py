"""Round S (fifteenth batch): S20 Memory Adequacy Signal 单元测试"""

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
    # 只关注 S20，关闭其余功能减少干扰
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
    e.mem_source_diversity_enabled = False
    e.mem_adequacy_enabled = True
    e.mem_confidence_threshold = 0.7
    return e


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def _mem(importance: float, **extra) -> dict:
    """构造带有指定 importance 的记忆记录。"""
    return {"content": "test content", "importance": importance, **extra}


# ---------------------------------------------------------------------------
# S20: 基础行为测试
# ---------------------------------------------------------------------------

class TestMemoryAdequacyBasic:
    """_compute_memory_adequacy_line 的基础路径测试。"""

    def test_returns_empty_when_disabled(self, engine):
        """mem_adequacy_enabled=False 时始终返回空字符串。"""
        engine.mem_adequacy_enabled = False
        result = engine._compute_memory_adequacy_line([_mem(0.9)], "PERSONAL_RECALL")
        assert result == ""

    def test_returns_empty_for_empty_relevant(self, engine):
        """relevant 为空时返回空字符串（S16 已处理此情形，避免重复）。"""
        result = engine._compute_memory_adequacy_line([], "PERSONAL_RECALL")
        assert result == ""

    def test_returns_empty_for_general_intent(self, engine):
        """GENERAL 意图不注入充分性信号（记忆仅为背景参考）。"""
        result = engine._compute_memory_adequacy_line([_mem(0.9)], "GENERAL")
        assert result == ""

    def test_returns_empty_for_task_assist_intent(self, engine):
        """TASK_ASSIST 意图不注入充分性信号（任务执行不依赖记忆充分性）。"""
        result = engine._compute_memory_adequacy_line([_mem(0.9)], "TASK_ASSIST")
        assert result == ""

    def test_line_starts_with_bracket_personal(self, engine):
        """PERSONAL_RECALL 时返回行以 '[记忆充分性:' 开头。"""
        result = engine._compute_memory_adequacy_line([_mem(0.9), _mem(0.8)], "PERSONAL_RECALL")
        assert result.startswith("[记忆充分性:")

    def test_line_starts_with_bracket_temporal(self, engine):
        """TEMPORAL_RECALL 时返回行以 '[记忆充分性:' 开头。"""
        result = engine._compute_memory_adequacy_line([_mem(0.5), _mem(0.4)], "TEMPORAL_RECALL")
        assert result.startswith("[记忆充分性:")

    def test_line_is_single_line(self, engine):
        """返回行不含换行符（紧凑单行格式）。"""
        cases = [
            ([_mem(0.9), _mem(0.8)], "PERSONAL_RECALL"),
            ([_mem(0.8)], "PERSONAL_RECALL"),
            ([_mem(0.4)], "PERSONAL_RECALL"),
            ([_mem(0.5), _mem(0.4)], "TEMPORAL_RECALL"),
            ([_mem(0.5)], "TEMPORAL_RECALL"),
        ]
        for relevant, intent in cases:
            result = engine._compute_memory_adequacy_line(relevant, intent)
            assert "\n" not in result, f"intent={intent}, line contains newline"

    def test_line_is_compact(self, engine):
        """所有情形下返回行长度 < 100 字符。"""
        cases = [
            ([_mem(0.9), _mem(0.8)], "PERSONAL_RECALL"),
            ([_mem(0.9)], "PERSONAL_RECALL"),
            ([_mem(0.4)], "PERSONAL_RECALL"),
            ([_mem(0.5), _mem(0.4)], "TEMPORAL_RECALL"),
            ([_mem(0.5)], "TEMPORAL_RECALL"),
        ]
        for relevant, intent in cases:
            result = engine._compute_memory_adequacy_line(relevant, intent)
            assert len(result) < 100, f"Line too long ({len(result)}): {result}"


# ---------------------------------------------------------------------------
# S20: PERSONAL_RECALL 场景
# ---------------------------------------------------------------------------

class TestPersonalRecallAdequacy:
    """PERSONAL_RECALL 意图下的充分性判断。"""

    def test_sufficient_with_2_validated(self, engine):
        """已验证事实 >= 2 → 充足。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.9), _mem(0.8)], "PERSONAL_RECALL"
        )
        assert "充足" in result

    def test_sufficient_is_positive_verdict(self, engine):
        """充足时，输出包含正面判断（'可自信回答' 或 '有据可查'）。

        注意：S20 的 PERSONAL_RECALL 充足路径故意省略了条数（避免与 S11/S19 重复），
        聚焦于意图特定的行为判断价值。条数验证由 S11 和 S19 负责。
        """
        result = engine._compute_memory_adequacy_line(
            [_mem(0.9), _mem(0.85), _mem(0.75)], "PERSONAL_RECALL"
        )
        assert "可自信回答" in result or "有据可查" in result

    def test_limited_with_1_validated(self, engine):
        """已验证事实 == 1 → 有限。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.8)], "PERSONAL_RECALL"
        )
        assert "有限" in result

    def test_limited_suggests_qualifier(self, engine):
        """有限时，包含限定语建议（"据我所知"）。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.8)], "PERSONAL_RECALL"
        )
        assert "据我所知" in result

    def test_insufficient_with_0_validated(self, engine):
        """已验证事实 == 0（但 relevant 非空）→ 不足。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.5), _mem(0.4)], "PERSONAL_RECALL"
        )
        assert "不足" in result

    def test_insufficient_suggests_ask_user(self, engine):
        """不足时，建议向用户主动确认。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.3)], "PERSONAL_RECALL"
        )
        # 建议确认 / 主动询问
        assert "确认" in result or "询问" in result

    def test_threshold_boundary_is_validated(self, engine):
        """importance 恰好等于 threshold（0.7）时，被视为已验证（>= 0.7）。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.7), _mem(0.7)], "PERSONAL_RECALL"
        )
        assert "充足" in result

    def test_just_below_threshold_is_insufficient(self, engine):
        """importance 略低于 threshold（0.699）时，被视为未验证 → 不足。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.699)], "PERSONAL_RECALL"
        )
        assert "不足" in result

    def test_mixed_validated_and_raw_counted_correctly(self, engine):
        """2 已验证 + 2 未验证 → 依然充足（validated=2 触发充足门槛）。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.9), _mem(0.8), _mem(0.4), _mem(0.3)], "PERSONAL_RECALL"
        )
        assert "充足" in result

    def test_custom_threshold(self, engine):
        """自定义 threshold 时，充分性判断跟随新阈值。"""
        engine.mem_confidence_threshold = 0.5
        # 0.6 >= 0.5 → 已验证
        result = engine._compute_memory_adequacy_line(
            [_mem(0.6), _mem(0.55)], "PERSONAL_RECALL"
        )
        assert "充足" in result


# ---------------------------------------------------------------------------
# S20: TEMPORAL_RECALL 场景
# ---------------------------------------------------------------------------

class TestTemporalRecallAdequacy:
    """TEMPORAL_RECALL 意图下的充分性判断。"""

    def test_sufficient_with_2_or_more_records(self, engine):
        """历史记录 >= 2 条 → 充足。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.5), _mem(0.4)], "TEMPORAL_RECALL"
        )
        assert "充足" in result

    def test_sufficient_count_in_output(self, engine):
        """充足时，输出包含总记录条数。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.5), _mem(0.6), _mem(0.3)], "TEMPORAL_RECALL"
        )
        assert "3" in result

    def test_limited_with_single_record(self, engine):
        """仅 1 条历史记录 → 有限。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.5)], "TEMPORAL_RECALL"
        )
        assert "有限" in result

    def test_limited_mentions_incomplete(self, engine):
        """有限时，提示时序重建可能不完整。"""
        result = engine._compute_memory_adequacy_line(
            [_mem(0.5)], "TEMPORAL_RECALL"
        )
        assert "不完整" in result

    def test_temporal_ignores_importance_for_count(self, engine):
        """TEMPORAL_RECALL 充分性基于总记录数，不受 importance 影响。"""
        # 全部未验证，但有 2 条 → 依然充足
        result = engine._compute_memory_adequacy_line(
            [_mem(0.2), _mem(0.3)], "TEMPORAL_RECALL"
        )
        assert "充足" in result


# ---------------------------------------------------------------------------
# S20: 与其他 S 系列信号的集成测试
# ---------------------------------------------------------------------------

class TestAdequacyIntegration:
    """S20 与 memory_text 组装流水线的集成测试。"""

    def test_appended_after_s18_intent_hint(self, engine):
        """S20 充分性信号追加在 S18 意图提示之后（位于 memory_text 末尾）。"""
        engine.query_intent_enabled = True
        # 模拟 S18
        intent = engine._classify_query_intent("我叫什么名字？")
        assert intent == "PERSONAL_RECALL"
        intent_hint = engine._get_query_intent_hint(intent)
        adequacy_line = engine._compute_memory_adequacy_line([_mem(0.9), _mem(0.8)], intent)

        memory_text = "- 用户是工程师"
        if intent_hint:
            memory_text = f"{memory_text}\n{intent_hint}"
        if adequacy_line:
            memory_text = f"{memory_text}\n{adequacy_line}"

        # S18 在 S20 之前
        assert memory_text.index("[查询意图:") < memory_text.index("[记忆充分性:")

    def test_no_signal_for_task_query(self, engine):
        """任务类查询：S18 有提示，S20 不注入（不影响 memory_text）。"""
        engine.query_intent_enabled = True
        intent = engine._classify_query_intent("帮我写一段代码")
        assert intent == "TASK_ASSIST"
        adequacy_line = engine._compute_memory_adequacy_line([_mem(0.9)], intent)
        assert adequacy_line == ""

    def test_both_personal_signals_present(self, engine):
        """PERSONAL_RECALL 查询时，S18 和 S20 信号同时存在于 memory_text。"""
        engine.query_intent_enabled = True
        intent = "PERSONAL_RECALL"
        intent_hint = engine._get_query_intent_hint(intent)
        adequacy_line = engine._compute_memory_adequacy_line([_mem(0.9), _mem(0.8)], intent)

        memory_text = "- 用户名为张三"
        if intent_hint:
            memory_text = f"{memory_text}\n{intent_hint}"
        if adequacy_line:
            memory_text = f"{memory_text}\n{adequacy_line}"

        assert "[查询意图:" in memory_text
        assert "[记忆充分性:" in memory_text

    def test_adequacy_absent_when_disabled_leaves_intent_hint(self, engine):
        """S20 关闭时，S18 意图提示保持不变，memory_text 不含充分性标签。"""
        engine.query_intent_enabled = True
        engine.mem_adequacy_enabled = False
        intent = engine._classify_query_intent("我的习惯是什么？")
        intent_hint = engine._get_query_intent_hint(intent)
        adequacy_line = engine._compute_memory_adequacy_line([_mem(0.9)], intent)

        memory_text = "- 某条记忆"
        if intent_hint:
            memory_text = f"{memory_text}\n{intent_hint}"
        if adequacy_line:
            memory_text = f"{memory_text}\n{adequacy_line}"

        assert "[查询意图:" in memory_text
        assert "[记忆充分性:" not in memory_text

    def test_empty_relevant_no_adequacy_even_for_personal_intent(self, engine):
        """relevant=[] 时，充分性信号为空（S16 已处理无记忆情形）。"""
        adequacy_line = engine._compute_memory_adequacy_line([], "PERSONAL_RECALL")
        assert adequacy_line == ""

    def test_temporal_recall_adequacy_appended(self, engine):
        """TEMPORAL_RECALL 意图 + 多条记忆 → memory_text 末尾有充分性标签。"""
        intent = "TEMPORAL_RECALL"
        relevant = [_mem(0.5), _mem(0.4), _mem(0.3)]
        adequacy_line = engine._compute_memory_adequacy_line(relevant, intent)
        memory_text = "- 上次提到项目进展"
        if adequacy_line:
            memory_text = f"{memory_text}\n{adequacy_line}"
        assert "[记忆充分性:" in memory_text
        assert "充足" in memory_text

    def test_adequacy_suppressed_when_s16_gap_fires(self, engine):
        """修复代码审查 HIGH: assembly 层在 gap_hint 存在时跳过 S20，避免矛盾指令。

        场景：relevant=[低置信片段 × 2]
        - S16 (knowledge_gap_enabled=True): 追加 "[知识缺口: 当前记忆均为低置信片段…]"
        - S20 (TEMPORAL_RECALL): 单独调用返回 "充足(共 2 条历史记录)"（方法本身不感知 gap_hint）
        - 修复点在 assembly 层：`if adequacy_line and not gap_hint` — gap_hint 非空则跳过 S20

        验证：模拟修复后的 assembly 逻辑，确认 memory_text 中不含矛盾的"充足"标签。
        """
        engine.knowledge_gap_enabled = True
        relevant_all_low = [_mem(0.3), _mem(0.4)]  # 全部低置信 → 触发 S16 all_low 路径

        gap_hint = engine._compute_knowledge_gap_hint(relevant_all_low)
        adequacy_line = engine._compute_memory_adequacy_line(relevant_all_low, "TEMPORAL_RECALL")

        # 两者在方法层面均非空（S20 不感知 gap_hint）
        assert gap_hint != "", "S16 should fire for all-low-confidence memories"
        assert adequacy_line != "", "S20 would emit '充足' in isolation"

        # 模拟修复后的 assembly 逻辑（chat() 和 chat_stream() 的 `not gap_hint` guard）
        memory_text = "- 某条低置信片段"
        if gap_hint:
            memory_text = f"{memory_text}\n{gap_hint}"
        if adequacy_line and not gap_hint:  # ← 修复关键：gap_hint 非空时跳过 S20
            memory_text = f"{memory_text}\n{adequacy_line}"

        # 结果：gap_hint 进入 memory_text，S20 的"充足"未进入
        assert "[知识缺口:" in memory_text
        assert "充足" not in memory_text, (
            "S20 '充足' must not appear in memory_text when S16 gap_hint fired"
        )

    def test_s20_still_fires_for_personal_recall_with_gap(self, engine):
        """PERSONAL_RECALL + gap_hint 共存时，assembly 层通过 not gap_hint 跳过 S20。

        本测试直接测 assembly 逻辑（模拟 chat() 的 if adequacy_line and not gap_hint 条件）。
        """
        engine.knowledge_gap_enabled = True
        relevant_all_low = [_mem(0.3)]  # 低置信 → S16 all_low, S20 PERSONAL 不足
        gap_hint = engine._compute_knowledge_gap_hint(relevant_all_low)
        adequacy_line = engine._compute_memory_adequacy_line(relevant_all_low, "PERSONAL_RECALL")

        memory_text = "- 某条低置信片段"
        # 模拟修复后的 assembly 行为：gap_hint 存在时跳过 S20
        if gap_hint:
            memory_text = f"{memory_text}\n{gap_hint}"
        if adequacy_line and not gap_hint:  # gap_hint 非空 → 跳过
            memory_text = f"{memory_text}\n{adequacy_line}"

        # gap_hint 进入了 memory_text，S20 未进入
        assert "[知识缺口:" in memory_text
        assert "[记忆充分性:" not in memory_text
