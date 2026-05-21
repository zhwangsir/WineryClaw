"""Round S (fourth batch): S9 Knowledge Graph Context Injection 单元测试"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from chat.chat_engine import ChatEngine


# ---------------------------------------------------------------------------
# 通用 Fixture
# ---------------------------------------------------------------------------

def _make_kg_entity(eid: str, name: str, etype: str = "person",
                    description: str = "", confidence: float = 0.9) -> dict:
    return {"id": eid, "name": name, "type": etype,
            "description": description, "confidence": confidence}


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
def mock_kg():
    """返回一个最小可用的 KG mock。"""
    kg = MagicMock()
    kg.search = MagicMock(return_value=[])
    kg.get_neighbors = MagicMock(return_value=[])
    return kg


@pytest.fixture
def engine(mock_memory, mock_sub_brain, mock_kg):
    e = ChatEngine(
        memory_manager=mock_memory,
        sub_brain_client=mock_sub_brain,
        llm_config={},
        kg=mock_kg,
    )
    # 仅关注 S9 测试，关闭其他功能
    e.hyde_enabled = False
    e.reflection_enabled = False
    e.working_memory_enabled = False
    e.context_compress_enabled = False
    e.user_profile_enabled = False
    e.kg_context_enabled = True
    e.kg_context_top_k = 3
    e.kg_context_max_rels = 2
    return e


# ---------------------------------------------------------------------------
# S9: KG 上下文注入测试
# ---------------------------------------------------------------------------

class TestKGContextLoading:
    """_load_kg_context 的全路径测试：启用/禁用/命中/无命中/关联展开/降级。"""

    def test_returns_empty_when_disabled(self, engine, mock_kg):
        """kg_context_enabled=False 时不调用 KG，返回空字符串。"""
        engine.kg_context_enabled = False
        result = engine._load_kg_context("WeBrain 是什么项目")
        assert result == ""
        mock_kg.search.assert_not_called()

    def test_returns_empty_when_kg_is_none(self, mock_memory, mock_sub_brain):
        """kg=None 时不报错，返回空字符串。"""
        e = ChatEngine(memory_manager=mock_memory, sub_brain_client=mock_sub_brain,
                       llm_config={}, kg=None)
        e.kg_context_enabled = True
        result = e._load_kg_context("WeBrain")
        assert result == ""

    def test_returns_empty_when_no_entities_found(self, engine, mock_kg):
        """KG.search 返回空列表时返回空字符串。"""
        mock_kg.search.return_value = []
        result = engine._load_kg_context("一个完全陌生的查询")
        assert result == ""

    def test_returns_entity_info_when_match_found(self, engine, mock_kg):
        """KG 命中实体时，返回实体名、类型和描述。"""
        mock_kg.search.return_value = [
            _make_kg_entity("e1", "WeBrain", "project", "AI 能力增强平台")
        ]
        mock_kg.get_neighbors.return_value = []
        result = engine._load_kg_context("介绍 WeBrain 项目")
        assert "WeBrain" in result
        assert "project" in result
        assert "AI 能力增强平台" in result

    def test_includes_outgoing_relations(self, engine, mock_kg):
        """实体有出向关系时，使用 → 展示。"""
        mock_kg.search.return_value = [
            _make_kg_entity("e1", "王震宇", "person")
        ]
        mock_kg.get_neighbors.return_value = [
            {"id": "e2", "name": "WeBrain", "type": "project",
             "relation": "开发", "direction": "out"}
        ]
        result = engine._load_kg_context("王震宇")
        assert "→ 开发: WeBrain" in result

    def test_includes_incoming_relations(self, engine, mock_kg):
        """实体有入向关系时，使用 ← 展示。"""
        mock_kg.search.return_value = [
            _make_kg_entity("e1", "WeBrain", "project")
        ]
        mock_kg.get_neighbors.return_value = [
            {"id": "e2", "name": "王震宇", "type": "person",
             "relation": "开发", "direction": "in"}
        ]
        result = engine._load_kg_context("WeBrain")
        assert "← 开发: 王震宇" in result

    def test_respects_max_rels_limit(self, engine, mock_kg):
        """kg_context_max_rels 限制每个实体展开的关系条数。"""
        engine.kg_context_max_rels = 1
        mock_kg.search.return_value = [
            _make_kg_entity("e1", "WeBrain", "project")
        ]
        mock_kg.get_neighbors.return_value = [
            {"id": "e2", "name": "关系A", "type": "x", "relation": "rel_a", "direction": "out"},
            {"id": "e3", "name": "关系B", "type": "x", "relation": "rel_b", "direction": "out"},
        ]
        result = engine._load_kg_context("WeBrain")
        # 只展开第一条关系
        assert "关系A" in result
        assert "关系B" not in result

    def test_graceful_degradation_on_search_error(self, engine, mock_kg):
        """KG.search 抛异常时返回空字符串，不传播异常。"""
        mock_kg.search.side_effect = RuntimeError("KG 索引损坏")
        result = engine._load_kg_context("WeBrain")
        assert result == ""

    @pytest.mark.asyncio
    async def test_kg_context_injected_into_system_prompt(self, engine):
        """_build_system_prompt 接收非空 kg_context_text 时，提示含 '相关知识图谱实体' 区块。"""
        kg_text = "**WeBrain** (project): AI 能力增强平台\n  → 开发: 王震宇"
        prompt = await engine._build_system_prompt(
            agent_id="test-agent",
            memory_text="无相关记忆",
            kg_context_text=kg_text,
        )
        assert "相关知识图谱实体" in prompt
        assert "WeBrain" in prompt

    @pytest.mark.asyncio
    async def test_no_kg_section_when_context_empty(self, engine):
        """kg_context_text 为空时，系统提示不含 '相关知识图谱实体' 字样。"""
        prompt = await engine._build_system_prompt(
            agent_id="test-agent",
            memory_text="无相关记忆",
            kg_context_text="",
        )
        assert "相关知识图谱实体" not in prompt
        # 也不含原始槽位占位符（防止泄漏）
        assert "{{kg_context}}" not in prompt
