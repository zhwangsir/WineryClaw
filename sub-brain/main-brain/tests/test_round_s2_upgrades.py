"""Round S (second batch): S5 Context Compression + S6 Proactive Intelligence + S7 Semantic Dedup 单元测试"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat.chat_engine import ChatEngine
from memory.dreaming_engine import DreamingEngine


# ---------------------------------------------------------------------------
# 通用 Fixture
# ---------------------------------------------------------------------------

def _make_llm_response(content: str) -> dict:
    return {"choices": [{"message": {"content": content, "tool_calls": []}}]}


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
    # 关闭无关的 Round S 功能，避免干扰
    e.hyde_enabled = False
    e.reflection_enabled = False
    e.working_memory_enabled = False
    e.context_compress_enabled = True
    e.context_compress_threshold = 6   # 低阈值方便测试
    e.context_compress_keep_recent = 2
    return e


@pytest.fixture
def dreaming_engine():
    mem = MagicMock()
    mem._connect = MagicMock()
    de = DreamingEngine(memory_manager=mem, llm_config={})
    return de


# ---------------------------------------------------------------------------
# S5: 上下文压缩测试
# ---------------------------------------------------------------------------

class TestContextCompression:
    """_compress_messages 的启用/禁用/触发/降级路径。"""

    @pytest.mark.asyncio
    async def test_no_compression_when_disabled(self, engine):
        """context_compress_enabled=False 时不压缩，原样返回。"""
        engine.context_compress_enabled = False
        engine._chat_completion = AsyncMock()
        messages = [{"role": "system", "content": "sys"}] + [
            {"role": "user", "content": f"msg{i}"} for i in range(10)
        ]
        result = await engine._compress_messages(messages)
        assert result is messages  # 同一对象，未复制
        engine._chat_completion.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_compression_below_threshold(self, engine):
        """消息数 <= threshold 时不触发压缩。"""
        engine._chat_completion = AsyncMock()
        messages = [{"role": "system", "content": "sys"},
                    {"role": "user", "content": "q"}]  # 2 条，低于 threshold=6
        result = await engine._compress_messages(messages)
        assert result == messages
        engine._chat_completion.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_compression_triggered_above_threshold(self, engine):
        """消息数 > threshold 时调用 LLM 压缩，并返回缩短后的列表。"""
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response("摘要：读取了文件A，写入了文件B。")
        )
        # 构造 8 条消息 (> threshold=6)
        messages = [
            {"role": "system", "content": "系统提示"},
            {"role": "user", "content": "用户问题"},
        ] + [
            {"role": "assistant" if i % 2 == 0 else "tool", "content": f"内容{i}"}
            for i in range(6)
        ]
        result = await engine._compress_messages(messages)
        # 结果应比原始更短
        assert len(result) < len(messages)
        # 必须保留 system 和 user 消息
        assert result[0]["role"] == "system"
        assert result[1]["role"] == "user"
        # 必须保留最近 KEEP_RECENT=2 条
        assert result[-2:] == messages[-2:]
        engine._chat_completion.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_llm_error(self, engine):
        """LLM 失败时返回原始 messages，不抛异常。"""
        engine._chat_completion = AsyncMock(side_effect=RuntimeError("网络断开"))
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q"},
        ] + [{"role": "assistant", "content": f"a{i}"} for i in range(6)]
        result = await engine._compress_messages(messages)
        assert result == messages  # 降级：原样返回

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_empty_summary(self, engine):
        """LLM 返回空摘要时原样返回 messages。"""
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response("")
        )
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q"},
        ] + [{"role": "assistant", "content": f"a{i}"} for i in range(6)]
        result = await engine._compress_messages(messages)
        assert result == messages

    @pytest.mark.asyncio
    async def test_structure_preserved_after_compression(self, engine):
        """压缩后的列表结构：[sys, user, system(summary), *recent]"""
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response("压缩摘要")
        )
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q"},
        ] + [{"role": "assistant", "content": f"a{i}"} for i in range(6)]
        result = await engine._compress_messages(messages)
        assert result[0]["role"] == "system"
        assert result[1]["role"] == "user"
        # 压缩摘要以 system 角色注入（避免 user→user 角色交替错误）
        assert result[2]["role"] == "system"
        assert "工具调用历史摘要" in result[2]["content"]


# ---------------------------------------------------------------------------
# S6: 主动洞察检测测试
# ---------------------------------------------------------------------------

class TestProactiveIntelligence:
    """DreamingEngine.detect_proactive_insights 的核心路径。"""

    @pytest.mark.asyncio
    async def test_no_insights_when_facts_below_minimum(self, dreaming_engine):
        """facts_created < MIN_FACTS_FOR_INSIGHT 时不调用 LLM，返回空列表。"""
        dreaming_engine._llm_call = AsyncMock()
        result = await dreaming_engine.detect_proactive_insights(
            facts_created=dreaming_engine.MIN_FACTS_FOR_INSIGHT - 1
        )
        assert result == []
        dreaming_engine._llm_call.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_insights_generated_and_buffered(self, dreaming_engine):
        """LLM 返回合法洞察时，写入 _insight_buffer 并返回列表。"""
        # 模拟数据库返回
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = [
            {"content": "[goal] 用户希望学习 Python"},
            {"content": "[preference] 用户喜欢简洁代码"},
            {"content": "[fact] 用户在开发 WeBrain 项目"},
        ]
        dreaming_engine.memory._connect.return_value = mock_conn

        dreaming_engine._llm_call = AsyncMock(
            return_value='[{"title": "Python 学习路径", "content": "您频繁提及 Python，建议系统制定学习计划。", "category": "goal"}]'
        )

        result = await dreaming_engine.detect_proactive_insights(
            facts_created=dreaming_engine.MIN_FACTS_FOR_INSIGHT
        )
        assert len(result) == 1
        assert result[0]["title"] == "Python 学习路径"
        assert result[0]["id"]  # uuid 不为空
        assert result[0]["read"] is False
        assert len(dreaming_engine._insight_buffer) == 1

    @pytest.mark.asyncio
    async def test_empty_llm_returns_no_insights(self, dreaming_engine):
        """LLM 返回空列表时，buffer 不变，返回空列表。"""
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = [
            {"content": "[fact] 事实A"},
            {"content": "[fact] 事实B"},
            {"content": "[fact] 事实C"},
        ]
        dreaming_engine.memory._connect.return_value = mock_conn
        dreaming_engine._llm_call = AsyncMock(return_value="[]")

        result = await dreaming_engine.detect_proactive_insights(
            facts_created=5
        )
        assert result == []
        assert len(dreaming_engine._insight_buffer) == 0

    @pytest.mark.asyncio
    async def test_malformed_json_returns_no_insights(self, dreaming_engine):
        """LLM 返回非法 JSON 时优雅降级，返回空列表。"""
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = [
            {"content": "[fact] 事实A"},
            {"content": "[fact] 事实B"},
            {"content": "[fact] 事实C"},
        ]
        dreaming_engine.memory._connect.return_value = mock_conn
        dreaming_engine._llm_call = AsyncMock(return_value="不是JSON")

        result = await dreaming_engine.detect_proactive_insights(
            facts_created=5
        )
        assert result == []

    @pytest.mark.asyncio
    async def test_buffer_max_cap_enforced(self, dreaming_engine):
        """超过 INSIGHT_BUFFER_MAX 时，最旧的洞察被 deque 自动淘汰。"""
        # 预填满 buffer
        for i in range(dreaming_engine.INSIGHT_BUFFER_MAX):
            dreaming_engine._insight_buffer.append({"id": f"old-{i}", "title": f"旧洞察{i}"})
        assert len(dreaming_engine._insight_buffer) == dreaming_engine.INSIGHT_BUFFER_MAX

        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = [
            {"content": "[fact] 新事实A"},
            {"content": "[fact] 新事实B"},
            {"content": "[fact] 新事实C"},
        ]
        dreaming_engine.memory._connect.return_value = mock_conn
        dreaming_engine._llm_call = AsyncMock(
            return_value='[{"title": "新洞察", "content": "新的洞察内容", "category": "info"}]'
        )

        await dreaming_engine.detect_proactive_insights(facts_created=5)
        # 容量不超过最大值
        assert len(dreaming_engine._insight_buffer) == dreaming_engine.INSIGHT_BUFFER_MAX
        # 最新洞察在末尾
        assert dreaming_engine._insight_buffer[-1]["title"] == "新洞察"
        # 最旧的被淘汰
        assert dreaming_engine._insight_buffer[0]["id"] == "old-1"

    @pytest.mark.asyncio
    async def test_no_insights_when_no_l3_rows(self, dreaming_engine):
        """数据库无 L3 行时直接返回空列表，不调用 LLM。"""
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = []
        dreaming_engine.memory._connect.return_value = mock_conn
        dreaming_engine._llm_call = AsyncMock()

        result = await dreaming_engine.detect_proactive_insights(facts_created=5)
        assert result == []
        dreaming_engine._llm_call.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_run_cycle_includes_insight_count(self, dreaming_engine):
        """run_cycle() 返回值应包含 proactive_insights 计数字段。"""
        dreaming_engine.consolidate_l1_to_l2 = AsyncMock(
            return_value={"consolidated": 1}
        )
        dreaming_engine.consolidate_l2_to_l3 = AsyncMock(
            return_value={"l2_processed": 1, "facts_created": 5, "facts_skipped_empty": 0}
        )
        dreaming_engine.promote_l3_to_l4 = AsyncMock(
            return_value={"promoted": 0, "evaluated": 0}
        )
        dreaming_engine.detect_proactive_insights = AsyncMock(return_value=[])

        result = await dreaming_engine.run_cycle()
        assert "proactive_insights" in result
        assert result["proactive_insights"] == 0
        dreaming_engine.detect_proactive_insights.assert_awaited_once_with(5)


# ---------------------------------------------------------------------------
# S7: 语义去重测试
# ---------------------------------------------------------------------------

def _make_db_conn_mock(l2_rows, l3_refs_rows=None):
    """返回可用作 `with self.memory._connect() as conn:` 的 mock。"""
    mock_conn = MagicMock()
    mock_conn.__enter__ = MagicMock(return_value=mock_conn)
    mock_conn.__exit__ = MagicMock(return_value=False)
    # fetchall 依次返回 l2_rows、l3_refs_rows（再多的调用返回空列表）
    mock_conn.execute.return_value.fetchall.side_effect = [
        l2_rows,
        l3_refs_rows if l3_refs_rows is not None else [],
    ]
    return mock_conn


class TestSemanticDeduplication:
    """_find_similar_l3 和 consolidate_l2_to_l3 去重路径的核心测试。"""

    # ---- _find_similar_l3 单元测试 ----

    @pytest.mark.asyncio
    async def test_returns_none_when_dedup_disabled(self, dreaming_engine):
        """dedup_enabled=False 时直接返回 None，不调用向量搜索。"""
        dreaming_engine.dedup_enabled = False
        dreaming_engine.memory._vector_search = AsyncMock()
        result = await dreaming_engine._find_similar_l3("用户喜欢简洁代码")
        assert result is None
        dreaming_engine.memory._vector_search.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_returns_none_when_no_candidates(self, dreaming_engine):
        """向量搜索返回空列表时返回 None。"""
        dreaming_engine.memory._vector_search = AsyncMock(return_value=[])
        result = await dreaming_engine._find_similar_l3("用户喜欢简洁代码")
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_when_below_threshold(self, dreaming_engine):
        """最高相似度低于阈值时返回 None（不触发去重）。"""
        dreaming_engine.dedup_threshold = 0.85
        dreaming_engine.memory._vector_search = AsyncMock(
            return_value=[{"id": "old-1", "content": "旧内容", "vector_score": 0.70}]
        )
        result = await dreaming_engine._find_similar_l3("新内容")
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_match_when_above_threshold(self, dreaming_engine):
        """最高相似度 >= 阈值时返回匹配行。"""
        similar = {
            "id": "old-1",
            "content": "[fact] 用户在开发WeBrain",
            "vector_score": 0.92,
            "importance": 0.7,
        }
        dreaming_engine.memory._vector_search = AsyncMock(return_value=[similar])
        result = await dreaming_engine._find_similar_l3("[fact] 用户正在做WeBrain项目")
        assert result is not None
        assert result["id"] == "old-1"

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_vector_error(self, dreaming_engine):
        """向量搜索抛异常时优雅降级，返回 None，不传播异常。"""
        dreaming_engine.memory._vector_search = AsyncMock(side_effect=RuntimeError("索引损坏"))
        result = await dreaming_engine._find_similar_l3("测试内容")
        assert result is None

    # ---- consolidate_l2_to_l3 去重集成测试 ----

    @pytest.mark.asyncio
    async def test_consolidate_deduplicates_and_increments_counter(self, dreaming_engine):
        """发现相似 L3 时：不调用 store，更新已有行，facts_deduplicated=1。"""
        similar = {
            "id": "existing-1",
            "content": "[fact] 旧内容",
            "vector_score": 0.90,
            "importance": 0.7,
        }
        dreaming_engine._find_similar_l3 = AsyncMock(return_value=similar)
        dreaming_engine._extract_l3_facts = AsyncMock(
            return_value=[{"kind": "fact", "statement": "新内容，比旧内容更详细"}]
        )
        dreaming_engine.memory.store = AsyncMock()
        dreaming_engine.memory._store_embedding = AsyncMock()
        mock_conn = _make_db_conn_mock(
            l2_rows=[{"id": "l2-1", "content": "会话内容", "session_id": "s1", "created_at": "2024-01-01"}],
        )
        dreaming_engine.memory._connect = MagicMock(return_value=mock_conn)

        result = await dreaming_engine.consolidate_l2_to_l3()

        assert result["facts_deduplicated"] == 1
        assert result["facts_created"] == 0
        dreaming_engine.memory.store.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_consolidate_creates_new_when_no_similar(self, dreaming_engine):
        """无相似 L3 时：正常调用 store，facts_created=1，facts_deduplicated=0。"""
        dreaming_engine._find_similar_l3 = AsyncMock(return_value=None)
        dreaming_engine._extract_l3_facts = AsyncMock(
            return_value=[{"kind": "goal", "statement": "用户希望学习 Python"}]
        )
        dreaming_engine.memory.store = AsyncMock(return_value={"id": "new-1"})
        mock_conn = _make_db_conn_mock(
            l2_rows=[{"id": "l2-1", "content": "会话内容", "session_id": "s1", "created_at": "2024-01-01"}],
        )
        dreaming_engine.memory._connect = MagicMock(return_value=mock_conn)

        result = await dreaming_engine.consolidate_l2_to_l3()

        assert result["facts_created"] == 1
        assert result["facts_deduplicated"] == 0
        dreaming_engine.memory.store.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_dedup_keeps_longer_content_new_fact(self, dreaming_engine):
        """新事实更长时，UPDATE 使用新事实内容，并重新嵌入。"""
        existing_content = "[fact] 旧"
        new_statement = "新内容比旧内容更加详细丰富，包含更多信息"
        new_content = f"[fact] {new_statement}"
        similar = {
            "id": "existing-1",
            "content": existing_content,
            "vector_score": 0.91,
            "importance": 0.7,
        }
        dreaming_engine._find_similar_l3 = AsyncMock(return_value=similar)
        dreaming_engine._extract_l3_facts = AsyncMock(
            return_value=[{"kind": "fact", "statement": new_statement}]
        )
        dreaming_engine.memory.store = AsyncMock()
        dreaming_engine.memory._store_embedding = AsyncMock()
        mock_conn = _make_db_conn_mock(
            l2_rows=[{"id": "l2-1", "content": "会话", "session_id": "s1", "created_at": "2024-01-01"}],
        )
        dreaming_engine.memory._connect = MagicMock(return_value=mock_conn)

        await dreaming_engine.consolidate_l2_to_l3()

        # 验证 UPDATE 使用新内容（更长）
        all_calls = mock_conn.execute.call_args_list
        update_call = next((c for c in all_calls if "UPDATE memories" in str(c)), None)
        assert update_call is not None
        update_args = update_call[0][1]  # positional args tuple: (content, importance, now, id)
        assert update_args[0] == new_content  # merged = 新事实
        # 内容变更 → 重新嵌入
        dreaming_engine.memory._store_embedding.assert_awaited_once_with("existing-1", new_content)

    @pytest.mark.asyncio
    async def test_dedup_keeps_existing_content_when_longer(self, dreaming_engine):
        """现有事实更长时，merged_content 取现有内容，不调用 _store_embedding。"""
        existing_content = "[fact] 现有内容非常详细，包含了很多有价值的背景信息和细节"
        new_statement = "简短新事实"
        similar = {
            "id": "existing-1",
            "content": existing_content,
            "vector_score": 0.91,
            "importance": 0.7,
        }
        dreaming_engine._find_similar_l3 = AsyncMock(return_value=similar)
        dreaming_engine._extract_l3_facts = AsyncMock(
            return_value=[{"kind": "fact", "statement": new_statement}]
        )
        dreaming_engine.memory.store = AsyncMock()
        dreaming_engine.memory._store_embedding = AsyncMock()
        mock_conn = _make_db_conn_mock(
            l2_rows=[{"id": "l2-1", "content": "会话", "session_id": "s1", "created_at": "2024-01-01"}],
        )
        dreaming_engine.memory._connect = MagicMock(return_value=mock_conn)

        await dreaming_engine.consolidate_l2_to_l3()

        all_calls = mock_conn.execute.call_args_list
        update_call = next((c for c in all_calls if "UPDATE memories" in str(c)), None)
        assert update_call is not None
        update_args = update_call[0][1]
        assert update_args[0] == existing_content  # merged = 现有内容
        # 内容未变 → 无需重新嵌入
        dreaming_engine.memory._store_embedding.assert_not_awaited()
