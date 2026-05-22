"""Round S31-S35 — Five more zero-cost metadata signals on chat_engine.

S31: Pace Switch (对话节奏切换: 快速 ↔ 深度)
S32: Repeat Question Detection (重复询问检测,Jaccard 3-gram 重合)
S33: Time-of-day Behavior (深夜/晚间时段语气提示)
S34: Context Drop on Short Message (短句缺指代且有历史 → 上下文不完整)
S35: Negative Feedback Detection (失败/不满意关键词)
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


# ─────────────────────────── S31 Pace Switch ────────────────────────────


class TestPaceSwitch:
    def test_disabled_returns_empty(self, engine):
        engine.pace_switch_enabled = False
        for n in (10, 20, 30, 100, 110, 120):
            engine._pace_history.setdefault("s1", []).append(n)
        assert engine._compute_pace_switch_line("s1") == ""

    def test_no_signal_below_window(self, engine):
        engine.pace_switch_enabled = True
        for n in (10, 20, 30):
            engine._record_pace_sample("s1", "x" * n)
        # 仅 3 条样本 — 不足 6 条窗口
        assert engine._compute_pace_switch_line("s1") == ""

    def test_no_signal_when_avg_too_low_to_be_deep(self, engine):
        engine.pace_switch_enabled = True
        # 6 条都很短: 不应触发深度切换(recent_avg < 60)
        for _ in range(6):
            engine._record_pace_sample("s1", "x" * 5)
        assert engine._compute_pace_switch_line("s1") == ""

    def test_deep_mode_switch(self, engine):
        engine.pace_switch_enabled = True
        # 前 3 条短,后 3 条很长
        for n in (10, 12, 11, 200, 220, 210):
            engine._record_pace_sample("s1", "x" * n)
        out = engine._compute_pace_switch_line("s1")
        assert "深度模式" in out
        assert "→" in out

    def test_quick_mode_switch(self, engine):
        engine.pace_switch_enabled = True
        # 前 3 条很长,后 3 条短
        for n in (200, 210, 220, 10, 12, 11):
            engine._record_pace_sample("s1", "x" * n)
        out = engine._compute_pace_switch_line("s1")
        assert "快速问答" in out

    def test_sliding_window_bounded_to_6(self, engine):
        engine.pace_switch_enabled = True
        for n in range(20):
            engine._record_pace_sample("s1", "x" * (n + 1))
        # 历史长度应该最多保留 6 条
        assert len(engine._pace_history["s1"]) == 6
        # 最末 6 条应该是 15..20
        assert engine._pace_history["s1"] == [15, 16, 17, 18, 19, 20]

    def test_record_disabled_doesnt_append(self, engine):
        engine.pace_switch_enabled = False
        engine._record_pace_sample("s1", "long" * 100)
        assert "s1" not in engine._pace_history

    def test_empty_message_skipped(self, engine):
        engine.pace_switch_enabled = True
        engine._record_pace_sample("s1", "")
        assert "s1" not in engine._pace_history


# ───────────────────── S32 Repeat Question Detection ────────────────────


class TestRepeatQuestion:
    def test_disabled_returns_empty(self, engine):
        engine.repeat_question_enabled = False
        engine._record_user_message("s1", "什么是Python")
        assert engine._compute_repeat_question_line("s1", "什么是Python") == ""

    def test_empty_history_no_signal(self, engine):
        engine.repeat_question_enabled = True
        # 没有历史时 compute 不应触发
        assert engine._compute_repeat_question_line("s1", "什么是Python") == ""

    def test_exact_match_triggers(self, engine):
        engine.repeat_question_enabled = True
        engine._record_user_message("s1", "怎么实现一个二叉搜索树")
        out = engine._compute_repeat_question_line("s1", "怎么实现一个二叉搜索树")
        assert "重复询问" in out
        assert "类似问题" in out

    def test_high_overlap_triggers(self, engine):
        engine.repeat_question_enabled = True
        engine.repeat_question_threshold = 0.5
        engine._record_user_message("s1", "请帮我解释 Python 的装饰器是什么")
        out = engine._compute_repeat_question_line(
            "s1", "请帮我解释 Python 装饰器到底是什么"
        )
        assert "重复询问" in out

    def test_low_overlap_no_signal(self, engine):
        engine.repeat_question_enabled = True
        engine.repeat_question_threshold = 0.6
        engine._record_user_message("s1", "什么是 Python 装饰器")
        out = engine._compute_repeat_question_line("s1", "C++ 内存管理怎么做")
        assert out == ""

    def test_sliding_window_bounded_to_5(self, engine):
        engine.repeat_question_enabled = True
        for i in range(10):
            engine._record_user_message("s1", f"问题{i}")
        assert len(engine._user_msg_history["s1"]) == 5

    def test_jaccard_trigrams_short_text(self, engine):
        # 极短文本 fallback 为字符集合
        tri = ChatEngine._char_trigrams("ab")
        assert tri == {"a", "b"}

    def test_jaccard_trigrams_normal_text(self, engine):
        tri = ChatEngine._char_trigrams("abcd")
        assert tri == {"abc", "bcd"}


# ─────────────────────── S33 Time-of-day Behavior ───────────────────────


class TestTimeOfDay:
    def test_disabled_returns_empty(self, engine, monkeypatch):
        engine.time_of_day_enabled = False
        assert engine._compute_time_of_day_line() == ""

    def test_late_night_returns_signal(self, engine, monkeypatch):
        engine.time_of_day_enabled = True

        class FakeDT:
            @classmethod
            def now(cls):
                m = MagicMock()
                m.hour = 2
                return m

        monkeypatch.setattr("chat.chat_engine.datetime", FakeDT, raising=False)
        # datetime 是在函数内 import 的;改用 monkeypatch on local import
        import datetime as dt_module

        monkeypatch.setattr(dt_module, "datetime", FakeDT, raising=False)
        out = engine._compute_time_of_day_line()
        assert "深夜" in out
        assert "简洁" in out

    def test_evening_returns_signal(self, engine, monkeypatch):
        engine.time_of_day_enabled = True

        class FakeDT:
            @classmethod
            def now(cls):
                m = MagicMock()
                m.hour = 22
                return m

        import datetime as dt_module

        monkeypatch.setattr(dt_module, "datetime", FakeDT, raising=False)
        out = engine._compute_time_of_day_line()
        assert "夜间" in out

    def test_daytime_no_signal(self, engine, monkeypatch):
        engine.time_of_day_enabled = True

        class FakeDT:
            @classmethod
            def now(cls):
                m = MagicMock()
                m.hour = 14
                return m

        import datetime as dt_module

        monkeypatch.setattr(dt_module, "datetime", FakeDT, raising=False)
        assert engine._compute_time_of_day_line() == ""


# ────────────────────── S34 Context Drop Detection ──────────────────────


class TestContextDrop:
    def test_disabled_returns_empty(self, engine):
        engine.context_drop_enabled = False
        engine._record_user_message("s1", "previous message")
        engine._record_user_message("s1", "another")
        assert engine._compute_context_drop_line("s1", "嗯") == ""

    def test_no_history_no_signal(self, engine):
        engine.context_drop_enabled = True
        assert engine._compute_context_drop_line("s1", "嗯") == ""

    def test_short_no_pronoun_triggers(self, engine):
        engine.context_drop_enabled = True
        engine._record_user_message("s1", "first message context")
        engine._record_user_message("s1", "second message context")
        out = engine._compute_context_drop_line("s1", "好")
        assert "上下文不完整" in out

    def test_short_with_pronoun_no_signal(self, engine):
        engine.context_drop_enabled = True
        engine._record_user_message("s1", "first message")
        engine._record_user_message("s1", "second message")
        out = engine._compute_context_drop_line("s1", "我懂")
        assert out == ""

    def test_long_message_no_signal(self, engine):
        engine.context_drop_enabled = True
        engine._record_user_message("s1", "first")
        engine._record_user_message("s1", "second")
        out = engine._compute_context_drop_line(
            "s1", "这是一条比较长的消息超过了10字符阈值"
        )
        assert out == ""

    def test_only_one_prior_no_signal(self, engine):
        engine.context_drop_enabled = True
        engine._record_user_message("s1", "first message")
        # 只有一条历史 — 不应触发(要求 >= 2 条)
        out = engine._compute_context_drop_line("s1", "好")
        assert out == ""

    def test_english_pronoun_no_signal(self, engine):
        engine.context_drop_enabled = True
        engine._record_user_message("s1", "first")
        engine._record_user_message("s1", "second")
        out = engine._compute_context_drop_line("s1", "you")
        assert out == ""

    def test_empty_message_no_signal(self, engine):
        engine.context_drop_enabled = True
        engine._record_user_message("s1", "first")
        engine._record_user_message("s1", "second")
        out = engine._compute_context_drop_line("s1", "")
        assert out == ""


# ───────────────────── S35 Negative Feedback Detection ──────────────────


class TestNegativeFeedback:
    def test_disabled_returns_empty(self, engine):
        engine.negative_feedback_enabled = False
        assert engine._compute_negative_feedback_line("不对,你弄错了") == ""

    def test_chinese_keyword_triggers(self, engine):
        engine.negative_feedback_enabled = True
        out = engine._compute_negative_feedback_line("不对,我说的不是这个")
        assert "反馈识别" in out
        assert "重新理解需求" in out

    def test_alternative_chinese_keyword(self, engine):
        engine.negative_feedback_enabled = True
        out = engine._compute_negative_feedback_line("你没明白我的意思")
        assert "反馈识别" in out

    def test_english_keyword_triggers(self, engine):
        engine.negative_feedback_enabled = True
        out = engine._compute_negative_feedback_line("That's wrong, try again")
        assert "反馈识别" in out

    def test_no_keyword_no_signal(self, engine):
        engine.negative_feedback_enabled = True
        out = engine._compute_negative_feedback_line("再写一份 Python 例子")
        assert out == ""

    def test_empty_message_no_signal(self, engine):
        engine.negative_feedback_enabled = True
        out = engine._compute_negative_feedback_line("")
        assert out == ""

    def test_case_insensitive(self, engine):
        engine.negative_feedback_enabled = True
        out = engine._compute_negative_feedback_line("WRONG answer")
        assert "反馈识别" in out


# ────────────────── Integration: env-var override paths ─────────────────


class TestEnvOverrides:
    def test_pace_switch_env_disable(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_PACE_SWITCH_ENABLED", "0")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.pace_switch_enabled is False

    def test_repeat_threshold_env(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_REPEAT_QUESTION_THRESHOLD", "0.42")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.repeat_question_threshold == 0.42

    def test_repeat_threshold_invalid_falls_back(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_REPEAT_QUESTION_THRESHOLD", "not-a-number")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.repeat_question_threshold == 0.6

    def test_context_drop_chars_env(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_CONTEXT_DROP_MAX_CHARS", "20")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.context_drop_max_chars == 20

    def test_context_drop_chars_invalid_falls_back(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_CONTEXT_DROP_MAX_CHARS", "weird")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.context_drop_max_chars == 10

    def test_negative_feedback_env_disable(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_NEGATIVE_FEEDBACK_ENABLED", "0")
        e = ChatEngine(
            memory_manager=MagicMock(),
            sub_brain_client=MagicMock(),
            llm_config={},
        )
        assert e.negative_feedback_enabled is False
