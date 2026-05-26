"""Round S26-S30 — Five more zero-cost metadata signals on chat_engine.

S26: Turn Depth (会话深度: 首轮/中度/深对话)
S27: Memory Staleness Alert (单条最旧记忆 >N 天前 → 告警)
S28: User Expertise Inference (累积 expert vs novice 信号 → NOVICE/EXPERT)
S29: Response Length Hint (综合主题/节律/深度 → 精简/详尽)
S30: Tool Call Frequency (>= threshold → 提示收敛)
"""

import time
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


# ─────────────────────────── S26 Turn Depth ─────────────────────────────


class TestTurnDepth:
    def test_disabled_returns_empty(self, engine):
        engine.turn_depth_enabled = False
        engine._record_turn("s1")
        assert engine._compute_turn_depth_line("s1") == ""

    def test_first_turn_no_signal(self, engine):
        engine.turn_depth_enabled = True
        engine._record_turn("s1")
        assert engine._compute_turn_depth_line("s1") == ""

    def test_mid_depth_signal(self, engine):
        engine.turn_depth_enabled = True
        for _ in range(4):
            engine._record_turn("s1")
        out = engine._compute_turn_depth_line("s1")
        assert "中度" in out
        assert "第 4 轮" in out

    def test_deep_conversation_signal(self, engine):
        engine.turn_depth_enabled = True
        for _ in range(10):
            engine._record_turn("s1")
        out = engine._compute_turn_depth_line("s1")
        assert "深对话" in out
        assert "一致性" in out

    def test_session_isolation(self, engine):
        engine.turn_depth_enabled = True
        for _ in range(5):
            engine._record_turn("s1")
        # s2 没记录过任何 turn
        assert engine._compute_turn_depth_line("s2") == ""


# ─────────────────────────── S27 Staleness Alert ────────────────────────


class TestStalenessAlert:
    def test_disabled_returns_empty(self, engine):
        engine.staleness_alert_enabled = False
        old_mem = [{"id": "m1", "created_at": "2020-01-01T00:00:00Z"}]
        assert engine._compute_staleness_alert_line(old_mem) == ""

    def test_empty_relevant(self, engine):
        engine.staleness_alert_enabled = True
        assert engine._compute_staleness_alert_line([]) == ""

    def test_fresh_memory_no_alert(self, engine):
        engine.staleness_alert_enabled = True
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        mems = [{"id": "m1", "created_at": now}]
        assert engine._compute_staleness_alert_line(mems) == ""

    def test_stale_memory_alerts(self, engine):
        engine.staleness_alert_enabled = True
        engine.staleness_alert_days = 30
        # 100 天前
        old_iso = "2020-01-01T00:00:00Z"
        mems = [{"id": "m1", "created_at": old_iso}]
        out = engine._compute_staleness_alert_line(mems)
        assert "陈旧记忆告警:" in out
        assert "1 条" in out

    def test_multiple_old_count_correctly(self, engine):
        engine.staleness_alert_enabled = True
        engine.staleness_alert_days = 30
        mems = [
            {"id": "m1", "created_at": "2020-01-01T00:00:00Z"},
            {"id": "m2", "created_at": "2020-06-01T00:00:00Z"},
            {"id": "m3"},  # 无 created_at,跳过
        ]
        out = engine._compute_staleness_alert_line(mems)
        assert "2 条" in out

    def test_unix_timestamp_supported(self, engine):
        engine.staleness_alert_enabled = True
        engine.staleness_alert_days = 30
        # unix timestamp for 2020-01-01
        mems = [{"id": "m1", "created_at": 1577836800}]
        out = engine._compute_staleness_alert_line(mems)
        assert "陈旧记忆告警:" in out

    def test_malformed_timestamp_skipped(self, engine):
        engine.staleness_alert_enabled = True
        mems = [{"id": "m1", "created_at": "not-a-date"}]
        # 不崩,只是跳过
        assert engine._compute_staleness_alert_line(mems) == ""


# ─────────────────────────── S28 Expertise ──────────────────────────────


class TestExpertise:
    def test_disabled(self, engine):
        engine.expertise_enabled = False
        engine._record_expertise_signal("s1", "async await async await")
        assert engine._compute_expertise_line("s1") == ""

    def test_insufficient_evidence(self, engine):
        engine.expertise_enabled = True
        engine._record_expertise_signal("s1", "什么是函数")  # 1 novice
        # 只有 1 个证据 — 不够
        assert engine._compute_expertise_line("s1") == ""

    def test_expert_signal(self, engine):
        engine.expertise_enabled = True
        # 4 个 expert terms,0 个 novice
        for msg in ["async generator", "p95 deadlock", "throughput o(n)"]:
            engine._record_expertise_signal("s1", msg)
        out = engine._compute_expertise_line("s1")
        assert "EXPERT" in out

    def test_novice_signal(self, engine):
        engine.expertise_enabled = True
        for msg in ["小白入门", "什么是 RAG", "教我从零开始"]:
            engine._record_expertise_signal("s1", msg)
        out = engine._compute_expertise_line("s1")
        assert "NOVICE" in out

    def test_mixed_intermediate_no_signal(self, engine):
        engine.expertise_enabled = True
        engine._record_expertise_signal("s1", "什么是 async generator")  # 1+1
        engine._record_expertise_signal("s1", "怎么写 await")  # 1+1
        # expert=2 novice=2 — 不达 2x 比例
        assert engine._compute_expertise_line("s1") == ""


# ─────────────────────────── S29 Length Hint ────────────────────────────


class TestLengthHint:
    def test_disabled(self, engine):
        engine.length_hint_enabled = False
        assert engine._compute_length_hint_line("s1", "LEARNING") == ""

    def test_no_signal_when_normal(self, engine):
        engine.length_hint_enabled = True
        # 没节律记录,深度 0
        assert engine._compute_length_hint_line("s1", "GENERAL") == ""

    def test_fast_cadence_triggers_concise(self, engine):
        engine.length_hint_enabled = True
        now = time.time()
        engine._cadence_timestamps["s1"] = [now, now + 5, now + 10]
        out = engine._compute_length_hint_line("s1", "CODING")
        assert "精简" in out
        assert "快速对话" in out

    def test_deep_turn_triggers_concise(self, engine):
        engine.length_hint_enabled = True
        for _ in range(9):
            engine._record_turn("s1")
        out = engine._compute_length_hint_line("s1", "WORK")
        assert "精简" in out
        assert "深对话" in out

    def test_learning_slow_triggers_verbose(self, engine):
        engine.length_hint_enabled = True
        now = time.time()
        engine._cadence_timestamps["s1"] = [now, now + 500, now + 1000]
        out = engine._compute_length_hint_line("s1", "LEARNING")
        assert "详尽" in out


# ─────────────────────────── S30 Tool Freq ──────────────────────────────


class TestToolFreq:
    def test_disabled(self, engine):
        engine.tool_freq_enabled = False
        for _ in range(10):
            engine._record_tool_call("s1")
        assert engine._compute_tool_freq_line("s1") == ""

    def test_below_threshold(self, engine):
        engine.tool_freq_enabled = True
        engine.tool_freq_threshold = 5
        for _ in range(3):
            engine._record_tool_call("s1")
        assert engine._compute_tool_freq_line("s1") == ""

    def test_above_threshold_triggers(self, engine):
        engine.tool_freq_enabled = True
        engine.tool_freq_threshold = 3
        for _ in range(4):
            engine._record_tool_call("s1")
        out = engine._compute_tool_freq_line("s1")
        assert "工具调用提醒:" in out
        assert "4" in out

    def test_session_isolation(self, engine):
        engine.tool_freq_enabled = True
        engine.tool_freq_threshold = 2
        for _ in range(5):
            engine._record_tool_call("s1")
        assert engine._compute_tool_freq_line("s2") == ""
