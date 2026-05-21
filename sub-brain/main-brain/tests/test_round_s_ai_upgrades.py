"""Round S: AI 能力升级单元测试

覆盖四大新功能：
- S1: HyDE (Hypothetical Document Embeddings) 记忆检索增强
- S2: 反思循环 (Reflection Loop) 答复自评与修订
- S3: 工作记忆 (Working Memory) 会话级上下文
- S4: 工具结果缓存 (Tool Result Cache)
"""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat.chat_engine import ChatEngine


# ---------------------------------------------------------------------------
# 通用 Fixture
# ---------------------------------------------------------------------------

def _make_llm_response(content: str) -> dict:
    """构造标准 LLM 响应 dict（OpenAI 格式）。"""
    return {
        "choices": [{"message": {"content": content, "tool_calls": []}}]
    }


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
    """创建启用所有 Round S 功能的 ChatEngine 实例。"""
    e = ChatEngine(
        memory_manager=mock_memory,
        sub_brain_client=mock_sub_brain,
        llm_config={},
    )
    e.hyde_enabled = True
    e.reflection_enabled = True
    e.working_memory_enabled = True
    e.tool_cache_ttl = 300.0
    return e


# ---------------------------------------------------------------------------
# S1: HyDE 测试
# ---------------------------------------------------------------------------

class TestHyDE:
    """_expand_query_hyde 的正常路径、禁用路径和降级路径。"""

    @pytest.mark.asyncio
    async def test_returns_hyde_doc_when_enabled(self, engine):
        """启用时应返回 LLM 生成的假设答案。"""
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response("这是一个关于量子纠缠的假设答案文档。")
        )
        result = await engine._expand_query_hyde("什么是量子纠缠？")
        assert result is not None
        assert len(result) > 5
        engine._chat_completion.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_returns_none_when_disabled(self, engine):
        """hyde_enabled=False 时不调用 LLM，直接返回 None。"""
        engine.hyde_enabled = False
        engine._chat_completion = AsyncMock()
        result = await engine._expand_query_hyde("任意问题")
        assert result is None
        engine._chat_completion.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_returns_none_on_empty_query(self, engine):
        """空查询不触发 HyDE。"""
        engine._chat_completion = AsyncMock()
        result = await engine._expand_query_hyde("   ")
        assert result is None
        engine._chat_completion.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_graceful_degradation_on_llm_error(self, engine):
        """LLM 调用失败时静默降级，不抛异常。"""
        engine._chat_completion = AsyncMock(side_effect=RuntimeError("LLM 离线"))
        result = await engine._expand_query_hyde("这个问题会失败")
        assert result is None  # 优雅降级，不抛

    @pytest.mark.asyncio
    async def test_hyde_doc_passed_to_memory_query(self, engine, mock_memory):
        """chat() 应将 HyDE 文档传递给 memory.query()。"""
        engine._expand_query_hyde = AsyncMock(return_value="假设答案文档内容")
        engine._retrieve_rag_context = MagicMock(return_value=("", []))
        engine._make_plan = AsyncMock(return_value=None)
        engine._build_system_prompt = AsyncMock(return_value="system")
        engine._fetch_agent_config = AsyncMock(return_value={})
        engine._filter_tools_by_query = AsyncMock(return_value=None)
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response("答复内容")
        )
        await engine.chat("测试问题", "session-001")
        # memory.query 应被调用，且 hyde_doc 为假设文档
        mock_memory.query.assert_awaited()
        call_kwargs = mock_memory.query.call_args
        assert call_kwargs.kwargs.get("hyde_doc") == "假设答案文档内容"


# ---------------------------------------------------------------------------
# S2: 反思循环测试
# ---------------------------------------------------------------------------

class TestReflectionLoop:
    """_reflect_on_reply 的触发条件和修订逻辑。"""

    @pytest.mark.asyncio
    async def test_no_reflection_when_disabled(self, engine):
        """reflection_enabled=False 时不触发。"""
        engine.reflection_enabled = False
        engine._chat_completion = AsyncMock()
        result = await engine._reflect_on_reply("问题", "一个足够长的答复内容，超过100个字符" * 3)
        assert result is None
        engine._chat_completion.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_reflection_for_short_reply(self, engine):
        """答复 < 100 字时不触发反思（短答案通常质量无问题）。"""
        engine._chat_completion = AsyncMock()
        result = await engine._reflect_on_reply("问题", "短答案")
        assert result is None
        engine._chat_completion.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_revision_when_score_high(self, engine):
        """评分 >= 阈值时返回 None（无需修订）。"""
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response('{"score": 4, "issues": "无"}')
        )
        long_reply = "这是一个很好的答复" * 20
        result = await engine._reflect_on_reply("问题", long_reply)
        assert result is None

    @pytest.mark.asyncio
    async def test_revision_triggered_when_score_low(self, engine):
        """评分低于阈值时触发修订，返回修订后的答复。"""
        # 第一次调用 = 评分；第二次调用 = 修订
        engine._chat_completion = AsyncMock(side_effect=[
            _make_llm_response('{"score": 1, "issues": "回答完全错误"}'),
            _make_llm_response("这是修订后的、更好的答复内容"),
        ])
        long_reply = "这是一个很差的答复" * 20
        result = await engine._reflect_on_reply("重要问题", long_reply)
        assert result == "这是修订后的、更好的答复内容"
        assert engine._chat_completion.await_count == 2

    @pytest.mark.asyncio
    async def test_graceful_on_malformed_json(self, engine):
        """评分 JSON 解析失败时静默降级。"""
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response("这不是有效的 JSON")
        )
        long_reply = "答复内容" * 30
        result = await engine._reflect_on_reply("问题", long_reply)
        assert result is None


# ---------------------------------------------------------------------------
# S3: 工作记忆测试
# ---------------------------------------------------------------------------

class TestWorkingMemory:
    """工作记忆提取、存储和注入的正确性。"""

    @pytest.mark.asyncio
    async def test_extract_and_store_facts(self, engine):
        """成功提取时，事实应存储到 _working_memory[session_id]。"""
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response('["用户叫张伟", "目标是写 Python 爬虫", "需要处理反爬措施"]')
        )
        await engine._extract_working_memory("session-x", "我叫张伟，帮我写个爬虫", "好的...")
        assert "session-x" in engine._working_memory
        facts = engine._working_memory["session-x"]
        assert len(facts) == 3
        assert "用户叫张伟" in facts

    @pytest.mark.asyncio
    async def test_accumulate_across_turns(self, engine):
        """多轮对话的事实应累积（不超过 max 条）。"""
        engine.working_memory_max = 5
        engine._chat_completion = AsyncMock(side_effect=[
            _make_llm_response('["事实A", "事实B"]'),
            _make_llm_response('["事实C", "事实D"]'),
        ])
        await engine._extract_working_memory("s1", "第一轮", "答复1")
        await engine._extract_working_memory("s1", "第二轮", "答复2")
        facts = engine._working_memory["s1"]
        assert len(facts) == 4
        assert "事实A" in facts and "事实D" in facts

    @pytest.mark.asyncio
    async def test_max_cap_enforced(self, engine):
        """超过 max 条时，最旧的事实被淘汰。"""
        engine.working_memory_max = 3
        engine._working_memory["s2"] = ["旧A", "旧B", "旧C"]
        engine._chat_completion = AsyncMock(
            return_value=_make_llm_response('["新X", "新Y"]')
        )
        await engine._extract_working_memory("s2", "问题", "答复")
        facts = engine._working_memory["s2"]
        assert len(facts) == 3
        # 最旧的 "旧A" 应被淘汰
        assert "旧A" not in facts
        assert "新X" in facts and "新Y" in facts

    def test_working_memory_text_empty_session(self, engine):
        """无工作记忆的会话应返回空字符串。"""
        text = engine._get_working_memory_text("no-such-session")
        assert text == ""

    def test_working_memory_text_formatted(self, engine):
        """有工作记忆时应格式化为带 '- ' 前缀的列表。"""
        engine._working_memory["s3"] = ["事实1", "事实2"]
        text = engine._get_working_memory_text("s3")
        assert "- 事实1" in text
        assert "- 事实2" in text

    @pytest.mark.asyncio
    async def test_no_crash_when_disabled(self, engine):
        """禁用时不调用 LLM，也不写入 _working_memory。"""
        engine.working_memory_enabled = False
        engine._chat_completion = AsyncMock()
        await engine._extract_working_memory("s4", "问题", "答复")
        engine._chat_completion.assert_not_awaited()
        assert "s4" not in engine._working_memory

    @pytest.mark.asyncio
    async def test_graceful_on_llm_error(self, engine):
        """LLM 失败时静默跳过，不污染工作记忆。"""
        engine._chat_completion = AsyncMock(side_effect=RuntimeError("网络断开"))
        await engine._extract_working_memory("s5", "问题", "答复")
        assert "s5" not in engine._working_memory  # 没有写入任何东西


# ---------------------------------------------------------------------------
# S4: 工具结果缓存测试
# ---------------------------------------------------------------------------

class TestToolResultCache:
    """工具缓存的命中、未命中和过期逻辑。"""

    @pytest.fixture
    def tool_engine(self, mock_memory, mock_sub_brain):
        """独立 engine 实例，避免跨测试的缓存污染。"""
        e = ChatEngine(
            memory_manager=mock_memory,
            sub_brain_client=mock_sub_brain,
            llm_config={},
        )
        e.tool_cache_ttl = 300.0
        return e

    @pytest.mark.asyncio
    async def test_cache_miss_calls_sub_brain(self, tool_engine, mock_sub_brain):
        """缓存未命中时正常调用 sub_brain。"""
        mock_sub_brain.execute_tool = AsyncMock(return_value="文件内容abc")
        tc = {"function": {"name": "read_file", "arguments": '{"path": "/tmp/a.txt"}'}}
        result = await tool_engine._execute_tool(tc)
        assert "文件内容abc" in result
        mock_sub_brain.execute_tool.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_cache_hit_skips_sub_brain(self, tool_engine, mock_sub_brain):
        """相同只读工具 + 相同参数第二次调用应命中缓存。"""
        mock_sub_brain.execute_tool = AsyncMock(return_value="文件内容xyz")
        tc = {"function": {"name": "read_file", "arguments": '{"path": "/tmp/b.txt"}'}}
        # 首次调用 — miss
        await tool_engine._execute_tool(tc)
        # 第二次调用 — should hit cache
        result2 = await tool_engine._execute_tool(tc)
        assert "文件内容xyz" in result2
        # sub_brain 只被调用了 1 次
        assert mock_sub_brain.execute_tool.await_count == 1

    @pytest.mark.asyncio
    async def test_cache_expired_calls_sub_brain_again(self, tool_engine, mock_sub_brain):
        """缓存过期后应重新调用 sub_brain。"""
        mock_sub_brain.execute_tool = AsyncMock(return_value="新内容")
        tc = {"function": {"name": "read_file", "arguments": '{"path": "/tmp/c.txt"}'}}
        # 首次调用
        await tool_engine._execute_tool(tc)
        # 手动将缓存时间戳设为过期
        for k in tool_engine._tool_cache:
            tool_engine._tool_cache[k] = (tool_engine._tool_cache[k][0], time.time() - 9999)
        # 再次调用 — 应 miss
        await tool_engine._execute_tool(tc)
        assert mock_sub_brain.execute_tool.await_count == 2

    @pytest.mark.asyncio
    async def test_write_tool_not_cached(self, tool_engine, mock_sub_brain):
        """写入类工具（write_file/shell）的结果不应被缓存。"""
        mock_sub_brain.execute_tool = AsyncMock(return_value="写入成功")
        tc = {"function": {"name": "write_file", "arguments": '{"path": "/tmp/out.txt", "content": "test"}'}}
        await tool_engine._execute_tool(tc)
        await tool_engine._execute_tool(tc)
        # write_file 不缓存 → 两次都应调用
        assert mock_sub_brain.execute_tool.await_count == 2

    @pytest.mark.asyncio
    async def test_shell_not_cached(self, tool_engine, mock_sub_brain):
        """shell 执行不缓存（副作用工具）。"""
        mock_sub_brain.execute_tool = AsyncMock(return_value="命令输出")
        tc = {"function": {"name": "execute_shell", "arguments": '{"command": "ls"}'}}
        await tool_engine._execute_tool(tc)
        await tool_engine._execute_tool(tc)
        assert mock_sub_brain.execute_tool.await_count == 2

    @pytest.mark.asyncio
    async def test_http_post_not_cached(self, tool_engine, mock_sub_brain):
        """HTTP POST 不缓存（非幂等）。"""
        mock_sub_brain.execute_tool = AsyncMock(return_value='{"result": "ok"}')
        tc = {
            "function": {
                "name": "http_request",
                "arguments": '{"url": "http://example.com/api", "method": "POST", "body": "data"}'
            }
        }
        await tool_engine._execute_tool(tc)
        await tool_engine._execute_tool(tc)
        assert mock_sub_brain.execute_tool.await_count == 2
