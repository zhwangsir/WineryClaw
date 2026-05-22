"""Round S21-S25 — Five new metadata signals on chat_engine.

S21: Entity Spotlight (KG entity highlight)
S22: Conversation Topic classifier (CODING/WRITING/LEARNING/WORK/LIFE/GENERAL)
S23: Conversation Coherence (embedding-based topic-shift detector)
S24: Hot Memory Highlight (session-level repeat-hit counter)
S25: User Cadence (fast/normal/slow inference from message timestamps)

All five are zero-LLM signals and fail-open (return "" / unchanged on error).
"""

import pytest
from unittest.mock import AsyncMock, MagicMock

from chat.chat_engine import ChatEngine


@pytest.fixture
def mock_memory():
    mm = MagicMock()
    mm.query = AsyncMock(return_value=[])
    mm.store = AsyncMock(return_value={"ok": True})
    mm.get_top_l4 = AsyncMock(return_value=[])
    return mm


@pytest.fixture
def engine(mock_memory):
    sb = MagicMock()
    sb.execute_tool = AsyncMock(return_value="tool-result")
    e = ChatEngine(
        memory_manager=mock_memory,
        sub_brain_client=sb,
        llm_config={},
    )
    # Disable other rounds so we only test S21-S25
    for attr in (
        "hyde_enabled",
        "reflection_enabled",
        "working_memory_enabled",
        "context_compress_enabled",
        "user_profile_enabled",
        "kg_context_enabled",
        "conv_anchor_enabled",
        "mem_confidence_enabled",
        "mem_tiered_enabled",
        "l4_anchor_enabled",
        "temporal_context_enabled",
        "mem_freshness_enabled",
        "knowledge_gap_enabled",
        "mem_signal_guide_enabled",
        "query_intent_enabled",
        "mem_source_diversity_enabled",
        "mem_adequacy_enabled",
    ):
        setattr(e, attr, False)
    return e


# ─────────────────────────── S21 Entity Spotlight ───────────────────────


class TestEntitySpotlight:
    def test_disabled_returns_empty(self, engine):
        engine.entity_spotlight_enabled = False
        assert engine._compute_entity_spotlight_line("讨论 Python 和 WeBrain") == ""

    def test_empty_message(self, engine):
        engine.entity_spotlight_enabled = True
        assert engine._compute_entity_spotlight_line("") == ""
        assert engine._compute_entity_spotlight_line("   ") == ""

    def test_no_kg(self, engine):
        engine.entity_spotlight_enabled = True
        engine.kg = None
        assert engine._compute_entity_spotlight_line("hello") == ""

    def test_kg_returns_hit(self, engine):
        engine.entity_spotlight_enabled = True
        kg = MagicMock()
        kg.search.return_value = [
            {"id": "1", "name": "Python"},
            {"id": "2", "name": "WeBrain"},
        ]
        engine.kg = kg
        out = engine._compute_entity_spotlight_line("聊聊 Python 和 WeBrain")
        assert "本轮关注实体:" in out
        assert "Python" in out
        assert "WeBrain" in out

    def test_kg_search_exception_fails_open(self, engine):
        engine.entity_spotlight_enabled = True
        kg = MagicMock()
        kg.search.side_effect = RuntimeError("kg broken")
        engine.kg = kg
        assert engine._compute_entity_spotlight_line("anything") == ""

    def test_top_k_limit(self, engine):
        engine.entity_spotlight_enabled = True
        engine.entity_spotlight_top_k = 2
        kg = MagicMock()
        kg.search.return_value = [
            {"id": str(i), "name": f"E{i}"} for i in range(5)
        ]
        engine.kg = kg
        out = engine._compute_entity_spotlight_line("test")
        # Top-k 2 → at most 2 names listed
        assert "E0" in out
        assert "E1" in out
        assert "E2" not in out


# ─────────────────────────── S22 Topic Classifier ───────────────────────


class TestTopicClassifier:
    def test_disabled_returns_general(self, engine):
        engine.topic_classifier_enabled = False
        assert (
            engine._classify_conversation_topic("帮我写 Python 函数") == "GENERAL"
        )

    @pytest.mark.parametrize(
        "msg,expected",
        [
            ("帮我写一个 Python 函数", "CODING"),
            ("debug 一下这个 react 组件", "CODING"),
            ("帮我撰写一份周报", "WRITING"),
            ("润色这段文案", "WRITING"),
            ("解释什么是 RAG", "LEARNING"),
            ("为什么 GPT 会幻觉", "LEARNING"),
            ("安排明天的项目会议", "WORK"),
            ("周报怎么写", "WORK"),
            ("明天吃什么", "LIFE"),
            ("推荐一份食谱", "LIFE"),
            ("你好啊", "GENERAL"),
        ],
    )
    def test_topic_pattern_matching(self, engine, msg, expected):
        engine.topic_classifier_enabled = True
        assert engine._classify_conversation_topic(msg) == expected

    def test_get_topic_hint_general_returns_empty(self, engine):
        engine.topic_classifier_enabled = True
        assert engine._get_topic_hint("GENERAL") == ""

    def test_get_topic_hint_coding(self, engine):
        engine.topic_classifier_enabled = True
        h = engine._get_topic_hint("CODING")
        assert "[主题:" in h
        assert "编程" in h

    def test_get_topic_hint_disabled(self, engine):
        engine.topic_classifier_enabled = False
        assert engine._get_topic_hint("CODING") == ""


# ─────────────────────────── S23 Coherence ──────────────────────────────


@pytest.mark.asyncio
class TestCoherence:
    async def test_disabled_returns_empty(self, engine):
        engine.coherence_enabled = False
        out = await engine._compute_coherence_line("s1", "hello")
        assert out == ""

    async def test_empty_message_returns_empty(self, engine):
        engine.coherence_enabled = True
        out = await engine._compute_coherence_line("s1", "")
        assert out == ""

    async def test_no_embedder_fails_open(self, engine, mock_memory):
        engine.coherence_enabled = True
        # mock_memory doesn't have _get_embedder
        del mock_memory._get_embedder
        out = await engine._compute_coherence_line("s1", "anything")
        assert out == ""

    async def test_first_turn_no_prev_returns_empty(self, engine, mock_memory):
        engine.coherence_enabled = True
        mock_embedder = MagicMock()
        mock_embedder.encode.return_value = [[0.1, 0.2, 0.3]]
        mock_memory._get_embedder = MagicMock(return_value=mock_embedder)
        out = await engine._compute_coherence_line("s1", "hello")
        # First turn — no prev → no signal
        assert out == ""
        # But the embedding gets recorded for next turn
        assert "s1" in engine._last_user_embedding

    async def test_coherent_high_similarity(self, engine, mock_memory):
        engine.coherence_enabled = True
        # Identical vec → cosine=1.0 → coherent
        v = [1.0, 0.0, 0.0]
        mock_embedder = MagicMock()
        mock_embedder.encode.return_value = [v]
        mock_memory._get_embedder = MagicMock(return_value=mock_embedder)
        await engine._compute_coherence_line("s1", "msg1")  # seed
        out = await engine._compute_coherence_line("s1", "msg2")
        assert "[对话连贯:" in out

    async def test_topic_shift_low_similarity(self, engine, mock_memory):
        engine.coherence_enabled = True
        # Orthogonal vecs → cosine=0 → topic shift
        seq = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
        mock_embedder = MagicMock()
        mock_embedder.encode.side_effect = lambda x, **kw: [seq.pop(0)]
        mock_memory._get_embedder = MagicMock(return_value=mock_embedder)
        await engine._compute_coherence_line("s1", "msg1")
        out = await engine._compute_coherence_line("s1", "msg2")
        assert "[话题切换:" in out


# ─────────────────────────── S24 Hot Memory ─────────────────────────────


class TestHotMemory:
    def test_disabled_returns_unchanged(self, engine):
        engine.hot_memory_enabled = False
        mems = [{"id": "m1"}, {"id": "m2"}]
        assert engine._annotate_hot_memories("s1", mems) == mems

    def test_empty_returns_unchanged(self, engine):
        engine.hot_memory_enabled = True
        assert engine._annotate_hot_memories("s1", []) == []

    def test_below_threshold_no_hot_flag(self, engine):
        engine.hot_memory_enabled = True
        engine.hot_memory_threshold = 3
        mems = [{"id": "m1"}, {"id": "m2"}]
        out1 = engine._annotate_hot_memories("s1", mems)
        out2 = engine._annotate_hot_memories("s1", mems)
        # After 2 hits, threshold (3) not met
        assert all(not m.get("hot") for m in out2)

    def test_above_threshold_marks_hot(self, engine):
        engine.hot_memory_enabled = True
        engine.hot_memory_threshold = 2
        mems = [{"id": "m1"}]
        engine._annotate_hot_memories("s1", mems)
        out = engine._annotate_hot_memories("s1", mems)
        assert out[0]["hot"] is True

    def test_compute_hot_line_empty(self, engine):
        engine.hot_memory_enabled = True
        assert engine._compute_hot_memory_line([]) == ""

    def test_compute_hot_line_with_hot(self, engine):
        engine.hot_memory_enabled = True
        out = engine._compute_hot_memory_line(
            [{"id": "m1", "hot": True}, {"id": "m2"}, {"id": "m3", "hot": True}]
        )
        assert "高频引用:" in out
        assert "2" in out

    def test_session_isolation(self, engine):
        engine.hot_memory_enabled = True
        engine.hot_memory_threshold = 2
        mems = [{"id": "m1"}]
        engine._annotate_hot_memories("s1", mems)
        # Different session — counter should be separate
        out = engine._annotate_hot_memories("s2", mems)
        assert not out[0].get("hot")


# ─────────────────────────── S25 Cadence ────────────────────────────────


class TestCadence:
    def test_disabled_records_nothing(self, engine):
        engine.cadence_enabled = False
        engine._record_cadence_tick("s1")
        assert engine._cadence_timestamps == {}

    def test_record_appends_timestamps(self, engine):
        engine.cadence_enabled = True
        engine._record_cadence_tick("s1")
        engine._record_cadence_tick("s1")
        assert len(engine._cadence_timestamps["s1"]) == 2

    def test_buffer_caps_at_5(self, engine):
        engine.cadence_enabled = True
        for _ in range(10):
            engine._record_cadence_tick("s1")
        assert len(engine._cadence_timestamps["s1"]) == 5

    def test_compute_too_few_returns_empty(self, engine):
        engine.cadence_enabled = True
        engine._record_cadence_tick("s1")  # only 1 ts
        assert engine._compute_cadence_line("s1") == ""

    def test_compute_fast_cadence(self, engine):
        engine.cadence_enabled = True
        # Inject manual timestamps 1 sec apart → fast
        import time
        now = time.time()
        engine._cadence_timestamps["s1"] = [now, now + 1, now + 2]
        out = engine._compute_cadence_line("s1")
        assert "快速对话" in out

    def test_compute_slow_cadence(self, engine):
        engine.cadence_enabled = True
        import time
        now = time.time()
        engine._cadence_timestamps["s1"] = [now, now + 600, now + 1200]
        out = engine._compute_cadence_line("s1")
        assert "慢思考" in out

    def test_compute_normal_cadence_empty(self, engine):
        engine.cadence_enabled = True
        import time
        now = time.time()
        engine._cadence_timestamps["s1"] = [now, now + 120, now + 240]
        # Avg ~120s = normal → no signal
        assert engine._compute_cadence_line("s1") == ""
