"""Round S36-S40 — Five more zero-cost metadata signals (40/40 Axis 1 milestone).

S36: User Role Inference (DEVELOPER / MANAGER / STUDENT / CREATOR / GENERAL)
S37: Sentiment Tracking (ANXIOUS / CONFUSED / POSITIVE)
S38: Multi-language Switch Detection (zh ↔ en)
S39: Task Listing Trigger (列出/总结/清单 → bullet list 提示)
S40: Output Format Preference (累计 code/table/list/markdown/json 偏好)
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from chat.chat_engine import ChatEngine


@pytest.fixture
def engine():
    mm = MagicMock()
    mm.query = AsyncMock(return_value=[])
    mm.store = AsyncMock(return_value={"ok": True})
    mm.get_top_l4 = AsyncMock(return_value=[])
    sb = MagicMock()
    sb.execute_tool = AsyncMock(return_value="tool-result")
    e = ChatEngine(
        memory_manager=mm,
        sub_brain_client=sb,
        llm_config={},
    )
    return e


# ───────────────────── S36 User Role Inference ──────────────────────────


class TestRoleInference:
    def test_disabled_returns_empty(self, engine):
        engine.role_inference_enabled = False
        engine._record_role_signal("s1", "代码 API 函数")
        assert engine._compute_role_inference_line("s1") == ""

    def test_no_history_returns_empty(self, engine):
        engine.role_inference_enabled = True
        assert engine._compute_role_inference_line("s1") == ""

    def test_below_min_signals_no_emit(self, engine):
        engine.role_inference_enabled = True
        engine.role_inference_min_signals = 3
        engine._record_role_signal("s1", "写一段代码")
        # 仅 1 个信号 — 不应触发
        assert engine._compute_role_inference_line("s1") == ""

    def test_developer_role_inferred(self, engine):
        engine.role_inference_enabled = True
        engine.role_inference_min_signals = 3
        engine._record_role_signal("s1", "代码")
        engine._record_role_signal("s1", "API 接口")
        engine._record_role_signal("s1", "函数 类 调试")
        engine._record_role_signal("s1", "数据库 SQL")
        out = engine._compute_role_inference_line("s1")
        assert "DEVELOPER" in out
        assert "代码块" in out

    def test_manager_role_inferred(self, engine):
        engine.role_inference_enabled = True
        engine.role_inference_min_signals = 2
        engine._record_role_signal("s1", "团队进度")
        engine._record_role_signal("s1", "优先级 计划")
        engine._record_role_signal("s1", "OKR 战略")
        out = engine._compute_role_inference_line("s1")
        assert "MANAGER" in out

    def test_student_role_inferred(self, engine):
        engine.role_inference_enabled = True
        engine.role_inference_min_signals = 2
        engine._record_role_signal("s1", "我有作业不懂")
        engine._record_role_signal("s1", "怎么做这道题")
        engine._record_role_signal("s1", "考试复习")
        out = engine._compute_role_inference_line("s1")
        assert "STUDENT" in out

    def test_creator_role_inferred(self, engine):
        engine.role_inference_enabled = True
        engine.role_inference_min_signals = 2
        engine._record_role_signal("s1", "设计文案")
        engine._record_role_signal("s1", "灵感与构思")
        engine._record_role_signal("s1", "审美与排版")
        out = engine._compute_role_inference_line("s1")
        assert "CREATOR" in out

    def test_ambiguous_no_emit(self, engine):
        engine.role_inference_enabled = True
        engine.role_inference_min_signals = 2
        # 两类信号都达到阈值,但比例接近,不满足 2x 优势
        engine._record_role_signal("s1", "代码")
        engine._record_role_signal("s1", "API")
        engine._record_role_signal("s1", "团队")
        engine._record_role_signal("s1", "优先级")
        out = engine._compute_role_inference_line("s1")
        # DEVELOPER=2, MANAGER=2 — 没有 2x 优势,不应触发
        assert out == ""


# ───────────────────── S37 Sentiment Tracking ───────────────────────────


class TestSentiment:
    def test_disabled_returns_empty(self, engine):
        engine.sentiment_enabled = False
        assert engine._compute_sentiment_line("我急死了") == ""

    def test_anxious_trigger(self, engine):
        engine.sentiment_enabled = True
        out = engine._compute_sentiment_line("我赶时间,快点回答")
        assert "ANXIOUS" in out
        assert "直接给关键答案" in out

    def test_confused_trigger(self, engine):
        engine.sentiment_enabled = True
        out = engine._compute_sentiment_line("我不懂,这是什么?")
        assert "CONFUSED" in out

    def test_positive_trigger(self, engine):
        engine.sentiment_enabled = True
        out = engine._compute_sentiment_line("好棒,谢谢你的回答")
        assert "POSITIVE" in out

    def test_neutral_no_signal(self, engine):
        engine.sentiment_enabled = True
        out = engine._compute_sentiment_line("帮我写一段 Python 代码")
        assert out == ""

    def test_anxious_priority_over_confused(self, engine):
        engine.sentiment_enabled = True
        out = engine._compute_sentiment_line("我急,但是不懂")
        # 焦虑优先级最高
        assert "ANXIOUS" in out

    def test_english_keyword_trigger(self, engine):
        engine.sentiment_enabled = True
        out = engine._compute_sentiment_line("ASAP, urgent please")
        assert "ANXIOUS" in out


# ───────────────────── S38 Multi-language Switch ────────────────────────


class TestLangSwitch:
    def test_disabled_returns_empty(self, engine):
        engine.lang_switch_enabled = False
        engine._user_msg_history["s1"] = ["Hello there"]
        assert engine._compute_lang_switch_line("s1", "你好") == ""

    def test_no_history_no_signal(self, engine):
        engine.lang_switch_enabled = True
        assert engine._compute_lang_switch_line("s1", "你好") == ""

    def test_en_to_zh_switch(self, engine):
        engine.lang_switch_enabled = True
        engine._user_msg_history["s1"] = ["Hello, how are you today?"]
        out = engine._compute_lang_switch_line("s1", "你好,请用中文回复")
        assert "中文" in out

    def test_zh_to_en_switch(self, engine):
        engine.lang_switch_enabled = True
        engine._user_msg_history["s1"] = ["你好,请帮我写代码"]
        out = engine._compute_lang_switch_line("s1", "Please write Python code")
        assert "英文" in out

    def test_same_language_no_signal(self, engine):
        engine.lang_switch_enabled = True
        engine._user_msg_history["s1"] = ["请帮我写一段示例代码"]
        out = engine._compute_lang_switch_line("s1", "再加一些注释说明")
        # 都是中文为主 — 不应触发
        assert out == ""

    def test_same_english_no_signal(self, engine):
        engine.lang_switch_enabled = True
        engine._user_msg_history["s1"] = ["please write a function"]
        out = engine._compute_lang_switch_line(
            "s1", "add some comments to it"
        )
        assert out == ""

    def test_zh_ratio_helper_pure_zh(self):
        assert ChatEngine._zh_char_ratio("你好世界") == 1.0

    def test_zh_ratio_helper_pure_en(self):
        assert ChatEngine._zh_char_ratio("hello world") == 0.0

    def test_zh_ratio_helper_mixed(self):
        # "Hi你好" → 2 zh / 4 total = 0.5
        assert ChatEngine._zh_char_ratio("Hi你好") == 0.5

    def test_zh_ratio_empty(self):
        assert ChatEngine._zh_char_ratio("") == 0.0
        assert ChatEngine._zh_char_ratio("   ") == 0.0


# ───────────────────── S39 Task Listing Trigger ─────────────────────────


class TestTaskListing:
    def test_disabled_returns_empty(self, engine):
        engine.task_listing_enabled = False
        assert engine._compute_task_listing_line("帮我列出 Python 优势") == ""

    def test_列出_keyword(self, engine):
        engine.task_listing_enabled = True
        out = engine._compute_task_listing_line("帮我列出 Python 的优势")
        assert "结构化输出" in out
        assert "bullet" in out

    def test_总结_keyword(self, engine):
        engine.task_listing_enabled = True
        out = engine._compute_task_listing_line("总结一下你之前说的内容")
        assert "结构化输出" in out

    def test_清单_keyword(self, engine):
        engine.task_listing_enabled = True
        out = engine._compute_task_listing_line("给我个清单")
        assert "结构化输出" in out

    def test_english_summarize(self, engine):
        engine.task_listing_enabled = True
        out = engine._compute_task_listing_line("summarize this for me")
        assert "结构化输出" in out

    def test_no_keyword(self, engine):
        engine.task_listing_enabled = True
        out = engine._compute_task_listing_line("写一段 Python 代码")
        assert out == ""


# ──────────────────── S40 Output Format Preference ──────────────────────


class TestOutputFormatPreference:
    def test_disabled_returns_empty(self, engine):
        engine.output_format_enabled = False
        engine._record_format_signal("s1", "用代码 code block 输出")
        engine._record_format_signal("s1", "代码 snippet 给我")
        assert engine._compute_output_format_line("s1") == ""

    def test_no_history_no_signal(self, engine):
        engine.output_format_enabled = True
        assert engine._compute_output_format_line("s1") == ""

    def test_below_threshold_no_signal(self, engine):
        engine.output_format_enabled = True
        engine._record_format_signal("s1", "用代码回答")
        # 只有 1 次 — 不应触发(需要 >= 2 次)
        assert engine._compute_output_format_line("s1") == ""

    def test_code_preference_inferred(self, engine):
        engine.output_format_enabled = True
        engine._record_format_signal("s1", "用代码写")
        engine._record_format_signal("s1", "再来一段 code block")
        engine._record_format_signal("s1", "function snippet 怎么写")
        out = engine._compute_output_format_line("s1")
        assert "代码块" in out

    def test_table_preference_inferred(self, engine):
        engine.output_format_enabled = True
        engine._record_format_signal("s1", "用表格对比")
        engine._record_format_signal("s1", "再来个 table")
        out = engine._compute_output_format_line("s1")
        assert "表格" in out

    def test_list_preference_inferred(self, engine):
        engine.output_format_enabled = True
        engine._record_format_signal("s1", "用列表回答")
        engine._record_format_signal("s1", "再用 bullet")
        out = engine._compute_output_format_line("s1")
        assert "列表" in out

    def test_each_format_at_most_one_per_message(self, engine):
        engine.output_format_enabled = True
        # 同一条消息里同时出现 "代码" 和 "code" — 应只累一次
        engine._record_format_signal("s1", "用代码 code 输出 snippet")
        assert engine._format_counters["s1"]["code"] == 1


# ──────────────────── Integration: env override paths ───────────────────


class TestEnvOverrides:
    def test_role_inference_env_disable(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_ROLE_INFERENCE_ENABLED", "0")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.role_inference_enabled is False

    def test_role_min_signals_env(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_ROLE_INFERENCE_MIN", "5")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.role_inference_min_signals == 5

    def test_role_min_signals_invalid_falls_back(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_ROLE_INFERENCE_MIN", "weird")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.role_inference_min_signals == 3

    def test_sentiment_env_disable(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_SENTIMENT_ENABLED", "0")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.sentiment_enabled is False

    def test_lang_switch_env_disable(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_LANG_SWITCH_ENABLED", "0")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.lang_switch_enabled is False

    def test_task_listing_env_disable(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_TASK_LISTING_ENABLED", "0")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.task_listing_enabled is False

    def test_output_format_env_disable(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_OUTPUT_FORMAT_ENABLED", "0")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.output_format_enabled is False
