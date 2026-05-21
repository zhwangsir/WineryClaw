"""Round S (thirteenth batch): S18 Query Intent Awareness 单元测试"""

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
    # 只关注 S18，关闭其余功能减少干扰
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
    e.query_intent_enabled = True
    return e


# ---------------------------------------------------------------------------
# S18: 查询意图分类测试
# ---------------------------------------------------------------------------

class TestQueryIntentClassification:
    """_classify_query_intent 的全路径测试。"""

    def test_returns_general_when_disabled(self, engine):
        """query_intent_enabled=False 时始终返回 GENERAL。"""
        engine.query_intent_enabled = False
        assert engine._classify_query_intent("我叫什么名字") == "GENERAL"

    def test_general_for_neutral_question(self, engine):
        """无匹配模式的普通问题分类为 GENERAL。"""
        result = engine._classify_query_intent("今天天气怎么样？")
        assert result == "GENERAL"

    # --- PERSONAL_RECALL ---

    def test_personal_recall_wo_jiao(self, engine):
        """'我叫' 触发 PERSONAL_RECALL。"""
        assert engine._classify_query_intent("你知道我叫什么吗？") == "PERSONAL_RECALL"

    def test_personal_recall_wo_de_xiguan(self, engine):
        """'我的习惯' 触发 PERSONAL_RECALL（必须精确包含该子串）。"""
        assert engine._classify_query_intent("我的习惯是什么？") == "PERSONAL_RECALL"

    def test_personal_recall_wo_gong_zuo(self, engine):
        """'我的工作' 触发 PERSONAL_RECALL。"""
        assert engine._classify_query_intent("你记得我的工作是什么吗？") == "PERSONAL_RECALL"

    def test_personal_recall_wo_mu_biao(self, engine):
        """'我的目标' 触发 PERSONAL_RECALL。"""
        assert engine._classify_query_intent("我的目标是什么？") == "PERSONAL_RECALL"

    # --- TEMPORAL_RECALL ---

    def test_temporal_recall_shang_ci(self, engine):
        """'上次' 触发 TEMPORAL_RECALL。"""
        assert engine._classify_query_intent("上次我们讨论了什么？") == "TEMPORAL_RECALL"

    def test_temporal_recall_zhi_qian(self, engine):
        """'之前' 触发 TEMPORAL_RECALL。"""
        assert engine._classify_query_intent("你之前说过什么？") == "TEMPORAL_RECALL"

    def test_temporal_recall_zuo_tian(self, engine):
        """'昨天' 触发 TEMPORAL_RECALL。"""
        assert engine._classify_query_intent("昨天我们讨论的那个问题") == "TEMPORAL_RECALL"

    def test_temporal_recall_li_shi(self, engine):
        """'历史' 触发 TEMPORAL_RECALL。"""
        assert engine._classify_query_intent("查看对话历史") == "TEMPORAL_RECALL"

    # --- TASK_ASSIST ---

    def test_task_assist_bang_wo_xie(self, engine):
        """'帮我写' 触发 TASK_ASSIST。"""
        assert engine._classify_query_intent("帮我写一段 Python 代码") == "TASK_ASSIST"

    def test_task_assist_dai_ma(self, engine):
        """'代码' 关键词触发 TASK_ASSIST。"""
        assert engine._classify_query_intent("这段代码怎么优化？") == "TASK_ASSIST"

    def test_task_assist_python_lowercase(self, engine):
        """英文小写 'python' 触发 TASK_ASSIST。"""
        assert engine._classify_query_intent("写一个 python 脚本") == "TASK_ASSIST"

    def test_task_assist_generate_english(self, engine):
        """英文 'generate' 触发 TASK_ASSIST。"""
        assert engine._classify_query_intent("generate a SQL query") == "TASK_ASSIST"

    def test_task_assist_bang_wo_fen_xi(self, engine):
        """'帮我分析' 触发 TASK_ASSIST。"""
        assert engine._classify_query_intent("帮我分析这段日志") == "TASK_ASSIST"

    # --- 优先级测试 ---

    def test_personal_takes_priority_over_task(self, engine):
        """PERSONAL_RECALL 优先于 TASK_ASSIST（精确包含 personal pattern）。"""
        # "帮我写" 是 TASK 模式，但 "我的偏好" 是 PERSONAL 模式，PERSONAL 优先检查
        result = engine._classify_query_intent("帮我写一段符合我的偏好的代码")
        assert result == "PERSONAL_RECALL"

    def test_personal_takes_priority_over_temporal(self, engine):
        """PERSONAL_RECALL 优先于 TEMPORAL_RECALL（精确包含 personal pattern）。"""
        # "我的偏好" 是 PERSONAL 模式，"上次" 是 TEMPORAL 模式，PERSONAL 优先检查
        result = engine._classify_query_intent("我的偏好上次有没有改变过？")
        assert result == "PERSONAL_RECALL"


# ---------------------------------------------------------------------------
# S18: 意图提示生成测试
# ---------------------------------------------------------------------------

class TestQueryIntentHint:
    """_get_query_intent_hint 的全路径测试。"""

    def test_returns_empty_when_disabled(self, engine):
        """query_intent_enabled=False 时返回空字符串。"""
        engine.query_intent_enabled = False
        assert engine._get_query_intent_hint("PERSONAL_RECALL") == ""

    def test_returns_empty_for_general(self, engine):
        """GENERAL 意图返回空字符串（不注入任何提示）。"""
        assert engine._get_query_intent_hint("GENERAL") == ""

    def test_personal_recall_hint_nonempty(self, engine):
        """PERSONAL_RECALL 返回非空提示。"""
        result = engine._get_query_intent_hint("PERSONAL_RECALL")
        assert result != ""

    def test_temporal_recall_hint_nonempty(self, engine):
        """TEMPORAL_RECALL 返回非空提示。"""
        result = engine._get_query_intent_hint("TEMPORAL_RECALL")
        assert result != ""

    def test_task_assist_hint_nonempty(self, engine):
        """TASK_ASSIST 返回非空提示。"""
        result = engine._get_query_intent_hint("TASK_ASSIST")
        assert result != ""

    def test_personal_hint_starts_with_bracket(self, engine):
        """PERSONAL_RECALL 提示以 '[查询意图:' 开头。"""
        result = engine._get_query_intent_hint("PERSONAL_RECALL")
        assert result.startswith("[查询意图:")

    def test_temporal_hint_starts_with_bracket(self, engine):
        """TEMPORAL_RECALL 提示以 '[查询意图:' 开头。"""
        result = engine._get_query_intent_hint("TEMPORAL_RECALL")
        assert result.startswith("[查询意图:")

    def test_task_hint_starts_with_bracket(self, engine):
        """TASK_ASSIST 提示以 '[查询意图:' 开头。"""
        result = engine._get_query_intent_hint("TASK_ASSIST")
        assert result.startswith("[查询意图:")

    def test_personal_hint_mentions_verified_facts(self, engine):
        """PERSONAL_RECALL 提示强调已验证事实。"""
        result = engine._get_query_intent_hint("PERSONAL_RECALL")
        assert "已验证事实" in result or "L3" in result or "L4" in result

    def test_temporal_hint_mentions_temporal_context(self, engine):
        """TEMPORAL_RECALL 提示强调时序或摘要。"""
        result = engine._get_query_intent_hint("TEMPORAL_RECALL")
        assert "时序" in result or "摘要" in result or "历史" in result

    def test_task_hint_mentions_task_focus(self, engine):
        """TASK_ASSIST 提示强调聚焦执行。"""
        result = engine._get_query_intent_hint("TASK_ASSIST")
        assert "任务" in result or "执行" in result or "聚焦" in result

    def test_all_hints_are_single_line(self, engine):
        """所有意图提示均为单行（不含换行符）。"""
        for intent in ["PERSONAL_RECALL", "TEMPORAL_RECALL", "TASK_ASSIST"]:
            result = engine._get_query_intent_hint(intent)
            assert "\n" not in result, f"{intent} hint contains newline"

    def test_all_hints_are_compact(self, engine):
        """所有意图提示长度 < 100 字符。"""
        for intent in ["PERSONAL_RECALL", "TEMPORAL_RECALL", "TASK_ASSIST"]:
            result = engine._get_query_intent_hint(intent)
            assert len(result) < 100, f"{intent} hint too long: {len(result)}"


# ---------------------------------------------------------------------------
# S18: 与其他 S 系列信号的集成测试
# ---------------------------------------------------------------------------

class TestQueryIntentIntegration:
    """S18 与 memory_text 组装流水线的集成测试。"""

    def test_intent_hint_appended_to_real_memory(self, engine):
        """有真实记忆时，意图提示追加在 memory_text 末尾。"""
        memory_text = "- 用户是软件工程师"
        intent = engine._classify_query_intent("我叫什么名字？")
        intent_hint = engine._get_query_intent_hint(intent)
        if intent_hint:
            memory_text = f"{memory_text}\n{intent_hint}"
        assert "用户是软件工程师" in memory_text
        assert "[查询意图:" in memory_text

    def test_intent_hint_appended_to_gap_hint(self, engine):
        """无记忆（gap hint）时，意图提示仍追加（gap+intent 组合）。"""
        engine.knowledge_gap_enabled = True
        relevant: list = []
        memory_text = "无相关记忆"
        # 模拟 S16 替换
        gap_hint = engine._compute_knowledge_gap_hint(relevant)
        if gap_hint:
            memory_text = gap_hint
        # 模拟 S18 追加
        intent = engine._classify_query_intent("我叫什么名字？")
        intent_hint = engine._get_query_intent_hint(intent)
        if intent_hint:
            memory_text = f"{memory_text}\n{intent_hint}"
        assert "[知识缺口:" in memory_text
        assert "[查询意图:" in memory_text

    def test_no_hint_for_general_intent(self, engine):
        """GENERAL 意图不改变 memory_text。"""
        original = "- 某条记忆"
        memory_text = original
        intent = engine._classify_query_intent("今天天气怎么样？")
        intent_hint = engine._get_query_intent_hint(intent)
        if intent_hint:
            memory_text = f"{memory_text}\n{intent_hint}"
        assert memory_text == original

    def test_intent_hint_appears_after_s17_guide(self, engine):
        """S18 意图提示在 S17 guide 之后（memory_text 末尾），guard 顺序正确。"""
        engine.mem_signal_guide_enabled = True
        guide = engine._get_memory_signal_guide_line()
        memory_text = "- high fact"
        # 模拟 S17 前置
        has_real_memory = memory_text != "无相关记忆" and not memory_text.startswith("[知识缺口:")
        if guide and has_real_memory:
            memory_text = f"{guide}\n{memory_text}"
        # 模拟 S18 追加
        intent = engine._classify_query_intent("帮我写代码")
        intent_hint = engine._get_query_intent_hint(intent)
        if intent_hint:
            memory_text = f"{memory_text}\n{intent_hint}"
        # S17 guide 在最顶部，S18 intent 在最底部
        assert memory_text.index("[记忆标签说明:") < memory_text.index("[查询意图:")

    def test_task_assist_intent_neutral_to_sentinel(self, engine):
        """TASK_ASSIST 意图对 '无相关记忆' sentinel 追加（不干扰 S16 逻辑）。"""
        memory_text = "无相关记忆"
        intent = engine._classify_query_intent("帮我写 Python 代码")
        intent_hint = engine._get_query_intent_hint(intent)
        if intent_hint:
            memory_text = f"{memory_text}\n{intent_hint}"
        # sentinel + intent hint 并存（无记忆，但有意图提示）
        assert "无相关记忆" in memory_text
        assert "[查询意图:" in memory_text
