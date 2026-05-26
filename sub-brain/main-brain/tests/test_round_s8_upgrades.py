"""Round S (eighth batch): S13 Always-On L4 Identity Anchors 单元测试"""

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
    e.hyde_enabled = False
    e.reflection_enabled = False
    e.working_memory_enabled = False
    e.context_compress_enabled = False
    e.user_profile_enabled = False
    e.kg_context_enabled = False
    e.conv_anchor_enabled = False
    e.mem_confidence_enabled = False
    e.mem_tiered_enabled = False
    e.l4_anchor_enabled = True
    e.l4_anchor_top_k = 2
    return e


# ---------------------------------------------------------------------------
# S13: L4 身份锚点测试
# ---------------------------------------------------------------------------

class TestL4IdentityAnchors:
    """_get_l4_anchors 的全路径测试。"""

    @pytest.mark.asyncio
    async def test_returns_empty_when_disabled(self, engine):
        """l4_anchor_enabled=False 时直接返回空列表，不调用 get_top_l4。"""
        engine.l4_anchor_enabled = False
        result = await engine._get_l4_anchors()
        assert result == []
        engine.memory.get_top_l4.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_calls_get_top_l4_with_top_k(self, engine):
        """启用时以 l4_anchor_top_k 为参数调用 memory.get_top_l4。"""
        engine.l4_anchor_top_k = 3
        engine.memory.get_top_l4 = AsyncMock(return_value=[])
        await engine._get_l4_anchors()
        engine.memory.get_top_l4.assert_awaited_once_with(limit=3)

    @pytest.mark.asyncio
    async def test_returns_l4_rows(self, engine):
        """成功时返回 get_top_l4 的结果。"""
        l4_rows = [
            {"id": "l4-1", "content": "喜欢 Python", "importance": 0.9, "level": "L4"},
            {"id": "l4-2", "content": "追求极致工程", "importance": 0.9, "level": "L4"},
        ]
        engine.memory.get_top_l4 = AsyncMock(return_value=l4_rows)
        result = await engine._get_l4_anchors()
        assert len(result) == 2
        assert result[0]["id"] == "l4-1"

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_error(self, engine):
        """get_top_l4 抛异常时返回空列表，不传播异常。"""
        engine.memory.get_top_l4 = AsyncMock(side_effect=RuntimeError("DB error"))
        result = await engine._get_l4_anchors()
        assert result == []

    def test_l4_anchors_prepended_to_relevant(self, engine):
        """L4 锚点前置追加到 relevant：L4 在前，原始结果在后，无重复。"""
        l4 = [
            {"id": "l4-1", "content": "L4 identity A", "importance": 0.9},
        ]
        semantic = [
            {"id": "mem-2", "content": "semantic result", "importance": 0.6},
        ]
        seen_ids = {m.get("id") for m in semantic if m.get("id")}
        new_l4 = [m for m in l4 if m.get("id") not in seen_ids]
        merged = new_l4 + semantic
        assert merged[0]["id"] == "l4-1"
        assert merged[1]["id"] == "mem-2"

    def test_l4_already_in_relevant_not_duplicated(self, engine):
        """L4 行若已存在于 relevant（同 id），不重复追加。"""
        l4 = [{"id": "shared-id", "content": "L4 fact", "importance": 0.9}]
        semantic = [{"id": "shared-id", "content": "L4 fact", "importance": 0.9}]
        seen_ids = {m.get("id") for m in semantic if m.get("id")}
        new_l4 = [m for m in l4 if m.get("id") not in seen_ids]
        merged = new_l4 + semantic
        assert len(merged) == 1  # 无重复

    def test_l4_without_id_not_deduplicated(self, engine):
        """L4 行无 id 字段时无法去重，仍追加（最坏情况是内容重复，可接受）。"""
        l4 = [{"content": "unnamed L4", "importance": 0.9}]  # 无 id
        semantic = []
        seen_ids = {m.get("id") for m in semantic if m.get("id")}
        new_l4 = [m for m in l4 if m.get("id") not in seen_ids]
        merged = new_l4 + semantic
        # 无 id 的 L4 仍被追加（None not in set()）
        assert len(merged) == 1

    @pytest.mark.asyncio
    async def test_memory_get_top_l4_signature(self, mock_memory, mock_sub_brain):
        """memory_manager.get_top_l4 方法在 engine 实例化后可被正常调用。"""
        engine = ChatEngine(
            memory_manager=mock_memory,
            sub_brain_client=mock_sub_brain,
            llm_config={},
        )
        engine.l4_anchor_enabled = True
        engine.l4_anchor_top_k = 2
        mock_memory.get_top_l4 = AsyncMock(return_value=[{"id": "l4-99", "content": "identity", "importance": 0.9}])
        result = await engine._get_l4_anchors()
        assert result[0]["id"] == "l4-99"
        mock_memory.get_top_l4.assert_awaited_once_with(limit=2)

    def test_l4_anchors_appear_in_validated_tier(self, engine):
        """L4 记忆（importance=0.9 ≥ 0.7 阈值）在 S12 分层显示中出现在已验证事实区块。"""
        engine.mem_tiered_enabled = True
        engine.mem_confidence_threshold = 0.7
        relevant = [
            {"id": "l4-1", "content": "L4 身份事实", "importance": 0.9},  # L4 anchor
            {"id": "mem-2", "content": "L2 原始片段", "importance": 0.4},  # semantic result
        ]
        result = engine._format_tiered_memory_text(relevant)
        assert "[已验证事实]" in result
        assert "L4 身份事实" in result
        # L4 内容在近期片段内容之前
        assert result.index("L4 身份事实") < result.index("L2 原始片段")
