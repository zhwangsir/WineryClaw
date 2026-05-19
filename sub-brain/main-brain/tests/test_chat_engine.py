"""Tests for ChatEngine."""

from dataclasses import dataclass
from typing import List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat.chat_engine import ChatEngine


@dataclass
class _FakeChunk:
    doc_path: str
    chunk_idx: int
    text: str
    score: float


class _FakeRAG:
    """Stand-in retriever used by chat-engine RAG tests."""

    def __init__(self, chunks: List[_FakeChunk]):
        self.chunks = chunks
        self.calls: List[tuple] = []

    def retrieve(self, query: str, k: int = 5) -> List[_FakeChunk]:
        self.calls.append((query, k))
        return list(self.chunks[:k])


class _ExplodingRAG:
    """Retriever that raises — chat must fail open."""

    def retrieve(self, query: str, k: int = 5):  # noqa: ARG002
        raise RuntimeError("embedder offline")


class _FakePlanner:
    """Stand-in Planner that returns a canned plan or None."""

    def __init__(self, plan=None):
        self._plan = plan
        self.calls = []

    async def plan(self, user_input, context=None):  # noqa: ARG002
        self.calls.append(user_input)
        return self._plan


class _ExplodingPlanner:
    async def plan(self, user_input, context=None):  # noqa: ARG002
        raise RuntimeError("planner crashed")


class TestChatEngine:
    """Unit tests for ChatEngine."""

    @pytest.fixture
    def mock_memory(self):
        mm = MagicMock()
        mm.query = AsyncMock(return_value=[])
        mm.store = AsyncMock(return_value={"id": "m1"})
        return mm

    @pytest.fixture
    def mock_subbrain(self):
        sb = MagicMock()
        sb.execute_tool = AsyncMock(return_value="tool result")
        return sb

    @pytest.fixture
    def chat(self, mock_memory, mock_subbrain, mock_llm_config):
        return ChatEngine(
            memory_manager=mock_memory,
            sub_brain_client=mock_subbrain,
            llm_config=mock_llm_config,
        )

    @pytest.mark.asyncio
    async def test_chat_no_tools(self, chat, mock_llm_response):
        """Simple chat without tool calls."""
        resp = {
            "choices": [{
                "message": {"role": "assistant", "content": "Hello!"},
                "finish_reason": "stop",
            }]
        }

        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value.raise_for_status = MagicMock()
            mock_post.return_value.json = MagicMock(return_value=resp)
            result = await chat.chat("Hi", "sess-1")

        assert result["reply"] == "Hello!"
        assert result["iterations"] == 1

    @pytest.mark.asyncio
    async def test_chat_with_tool_call(self, chat):
        """Chat with a single tool call."""
        tool_resp = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "test_tool", "arguments": "{}"},
                    }],
                },
                "finish_reason": "tool_calls",
            }]
        }
        final_resp = {
            "choices": [{
                "message": {"role": "assistant", "content": "Done!"},
                "finish_reason": "stop",
            }]
        }

        call_count = [0]
        async def mock_post(*args, **kwargs):
            call_count[0] += 1
            class MockResp:
                def raise_for_status(self): pass
                def json(self):
                    return tool_resp if call_count[0] == 1 else final_resp
            return MockResp()

        with patch("httpx.AsyncClient.post", mock_post):
            result = await chat.chat("Do something", "sess-1")

        assert result["reply"] == "Done!"
        assert result["iterations"] == 2
        assert len(result["tool_calls"]) == 1

    @pytest.mark.asyncio
    async def test_chat_max_iterations(self, chat):
        """Should stop after MAX_TOOL_ITERATIONS."""
        # Always return tool_calls
        tool_resp = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "test_tool", "arguments": "{}"},
                    }],
                },
                "finish_reason": "tool_calls",
            }]
        }

        async def mock_post(*args, **kwargs):
            class MockResp:
                def raise_for_status(self): pass
                def json(self): return tool_resp
            return MockResp()

        with patch("httpx.AsyncClient.post", mock_post):
            result = await chat.chat("Infinite loop test", "sess-1")

        assert result["iterations"] == 10  # MAX_TOOL_ITERATIONS
        assert "过多" in result["reply"] or "simplify" in result["reply"].lower()

    @pytest.mark.asyncio
    async def test_chat_stream(self, chat):
        """Streaming should yield content chunks."""
        chunks = []
        # Mock stream response
        async def mock_stream(*args, **kwargs):
            yield {"type": "content", "data": "Hello"}
            yield {"type": "content", "data": " world"}
            yield {"type": "done"}

        with patch.object(chat, "_chat_completion_stream", mock_stream):
            async for chunk in chat.chat_stream("Hi", "sess-1"):
                chunks.append(chunk)

        assert len(chunks) == 3
        assert chunks[0]["data"] == "Hello"
        assert chunks[1]["data"] == " world"


class TestChatEngineRAG:
    """RAG retrieval wiring tests for ChatEngine (_retrieve_rag_context + chat/stream injection)."""

    @pytest.fixture
    def mock_memory(self):
        mm = MagicMock()
        mm.query = AsyncMock(return_value=[])
        mm.store = AsyncMock(return_value={"id": "m1"})
        return mm

    @pytest.fixture
    def mock_subbrain(self):
        sb = MagicMock()
        sb.execute_tool = AsyncMock(return_value="tool result")
        return sb

    def _make_engine(self, mock_memory, mock_subbrain, mock_llm_config, rag):
        return ChatEngine(
            memory_manager=mock_memory,
            sub_brain_client=mock_subbrain,
            llm_config=mock_llm_config,
            rag_retriever=rag,
        )

    def test_retrieve_returns_empty_when_rag_is_none(
        self, mock_memory, mock_subbrain, mock_llm_config
    ):
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, rag=None)
        rendered, sources = engine._retrieve_rag_context("anything")
        assert rendered == ""
        assert sources == []

    def test_retrieve_returns_empty_for_blank_query(
        self, mock_memory, mock_subbrain, mock_llm_config
    ):
        rag = _FakeRAG([_FakeChunk("/n/a.md", 0, "x", 0.9)])
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, rag)
        rendered, sources = engine._retrieve_rag_context("   ")
        assert rendered == ""
        assert sources == []
        assert rag.calls == []  # short-circuit before hitting retriever

    def test_retrieve_filters_by_min_score(
        self, mock_memory, mock_subbrain, mock_llm_config, monkeypatch
    ):
        monkeypatch.setenv("WEBRAIN_RAG_MIN_SCORE", "0.5")
        rag = _FakeRAG([
            _FakeChunk("/notes/keep.md", 0, "high relevance", 0.9),
            _FakeChunk("/notes/drop.md", 0, "low relevance", 0.2),
        ])
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, rag)
        rendered, sources = engine._retrieve_rag_context("what is X?")
        assert len(sources) == 1
        assert sources[0]["doc_path"] == "/notes/keep.md"
        assert "keep.md" in rendered
        assert "drop.md" not in rendered

    def test_retrieve_formats_chunks_with_filename_and_score(
        self, mock_memory, mock_subbrain, mock_llm_config
    ):
        rag = _FakeRAG([_FakeChunk("/Users/x/notes/topic.md", 3, "the answer is 42", 0.87)])
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, rag)
        rendered, sources = engine._retrieve_rag_context("question")
        assert "topic.md" in rendered
        assert "chunk #3" in rendered
        assert "0.87" in rendered
        assert "the answer is 42" in rendered
        assert sources == [{"doc_path": "/Users/x/notes/topic.md", "chunk_idx": 3, "score": 0.87}]

    def test_retrieve_fails_open_when_retriever_raises(
        self, mock_memory, mock_subbrain, mock_llm_config
    ):
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, _ExplodingRAG())
        # Must not raise — chat flow keeps working even if RAG is broken
        rendered, sources = engine._retrieve_rag_context("hello")
        assert rendered == ""
        assert sources == []

    def test_retrieve_honors_top_k_env(
        self, mock_memory, mock_subbrain, mock_llm_config, monkeypatch
    ):
        monkeypatch.setenv("WEBRAIN_RAG_TOP_K", "2")
        rag = _FakeRAG([
            _FakeChunk("/a.md", 0, "a", 0.9),
            _FakeChunk("/b.md", 0, "b", 0.8),
            _FakeChunk("/c.md", 0, "c", 0.7),
        ])
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, rag)
        _, sources = engine._retrieve_rag_context("q")
        # _FakeRAG slices on `k` — confirm engine passed 2
        assert rag.calls == [("q", 2)]
        assert len(sources) == 2

    @pytest.mark.asyncio
    async def test_chat_threads_rag_sources_into_response(
        self, mock_memory, mock_subbrain, mock_llm_config
    ):
        rag = _FakeRAG([_FakeChunk("/notes/cat.md", 1, "cats sleep 16h/day", 0.81)])
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, rag)

        plain_resp = {
            "choices": [{
                "message": {"role": "assistant", "content": "Per your notes: 16h/day."},
                "finish_reason": "stop",
            }]
        }
        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value.raise_for_status = MagicMock()
            mock_post.return_value.json = MagicMock(return_value=plain_resp)
            result = await engine.chat("How long do cats sleep?", "sess-rag")

        assert result["reply"] == "Per your notes: 16h/day."
        assert result["rag_sources"] == [
            {"doc_path": "/notes/cat.md", "chunk_idx": 1, "score": 0.81}
        ]
        # And the retriever was actually called
        assert rag.calls and rag.calls[0][0] == "How long do cats sleep?"

    @pytest.mark.asyncio
    async def test_chat_stream_emits_rag_sources_event(
        self, mock_memory, mock_subbrain, mock_llm_config
    ):
        rag = _FakeRAG([_FakeChunk("/notes/dog.md", 0, "dogs bark", 0.77)])
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, rag)

        async def mock_stream(*args, **kwargs):
            yield {"type": "content", "data": "Dogs "}
            yield {"type": "content", "data": "bark."}
            yield {"type": "done"}

        events = []
        with patch.object(engine, "_chat_completion_stream", mock_stream):
            async for ev in engine.chat_stream("about dogs?", "sess-rag-stream"):
                events.append(ev)

        # rag_sources must come before any content chunks
        rag_events = [e for e in events if e["type"] == "rag_sources"]
        assert len(rag_events) == 1
        assert rag_events[0]["data"][0]["doc_path"] == "/notes/dog.md"
        rag_idx = events.index(rag_events[0])
        first_content_idx = next(i for i, e in enumerate(events) if e["type"] == "content")
        assert rag_idx < first_content_idx

    @pytest.mark.asyncio
    async def test_chat_stream_skips_rag_event_when_no_sources(
        self, mock_memory, mock_subbrain, mock_llm_config
    ):
        # Empty retriever → no event yielded so the wire doesn't churn for nothing
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, _FakeRAG([]))

        async def mock_stream(*args, **kwargs):
            yield {"type": "content", "data": "Hi"}
            yield {"type": "done"}

        events = []
        with patch.object(engine, "_chat_completion_stream", mock_stream):
            async for ev in engine.chat_stream("hello", "sess-no-rag"):
                events.append(ev)

        assert not any(e["type"] == "rag_sources" for e in events)


class TestChatEnginePlanner:
    """Planner wiring tests (M2 — task decomposition surfaced through chat)."""

    @pytest.fixture
    def mock_memory(self):
        mm = MagicMock()
        mm.query = AsyncMock(return_value=[])
        mm.store = AsyncMock(return_value={"id": "m1"})
        return mm

    @pytest.fixture
    def mock_subbrain(self):
        sb = MagicMock()
        sb.execute_tool = AsyncMock(return_value="tool result")
        return sb

    @pytest.fixture
    def canned_plan(self):
        return {
            "plan_id": "plan-abc",
            "user_input": "复杂多步请求",
            "tasks": [
                {
                    "id": "task-1",
                    "description": "读取文件",
                    "requires_tool": True,
                    "tool_hint": "read_file",
                    "expected_output": "内容",
                },
                {
                    "id": "task-2",
                    "description": "总结要点",
                    "requires_tool": False,
                    "tool_hint": "",
                    "expected_output": "3 点",
                },
            ],
            "confidence": 0.8,
            "reasoning": "两步",
        }

    def _make_engine(self, mock_memory, mock_subbrain, mock_llm_config, planner):
        return ChatEngine(
            memory_manager=mock_memory,
            sub_brain_client=mock_subbrain,
            llm_config=mock_llm_config,
            planner=planner,
        )

    @pytest.mark.asyncio
    async def test_make_plan_returns_none_when_disabled_via_env(
        self, mock_memory, mock_subbrain, mock_llm_config, canned_plan, monkeypatch
    ):
        monkeypatch.setenv("WEBRAIN_PLANNER_ENABLED", "0")
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, _FakePlanner(canned_plan))
        result = await engine._make_plan("anything")
        assert result is None

    @pytest.mark.asyncio
    async def test_make_plan_returns_none_when_no_planner_wired(
        self, mock_memory, mock_subbrain, mock_llm_config
    ):
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, planner=None)
        assert await engine._make_plan("anything") is None

    @pytest.mark.asyncio
    async def test_make_plan_fails_open_when_planner_raises(
        self, mock_memory, mock_subbrain, mock_llm_config
    ):
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, _ExplodingPlanner())
        assert await engine._make_plan("anything") is None

    @pytest.mark.asyncio
    async def test_make_plan_returns_dict_when_planner_yields_plan(
        self, mock_memory, mock_subbrain, mock_llm_config, canned_plan
    ):
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, _FakePlanner(canned_plan))
        result = await engine._make_plan("complex multistep request")
        assert result == canned_plan

    def test_format_plan_renders_markdown_block(
        self, mock_memory, mock_subbrain, mock_llm_config, canned_plan
    ):
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, None)
        block = engine._format_plan_for_prompt(canned_plan)
        assert "## Plan" in block
        assert "[task-1] 读取文件 — tool: read_file" in block
        assert "[task-2] 总结要点" in block
        # task-2 has requires_tool False → no tool annotation
        assert "task-2] 总结要点 — tool" not in block

    def test_format_plan_empty_when_no_plan(self, mock_memory, mock_subbrain, mock_llm_config):
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, None)
        assert engine._format_plan_for_prompt(None) == ""
        assert engine._format_plan_for_prompt({"tasks": []}) == ""

    @pytest.mark.asyncio
    async def test_chat_threads_plan_into_response(
        self, mock_memory, mock_subbrain, mock_llm_config, canned_plan
    ):
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, _FakePlanner(canned_plan))
        plain_resp = {
            "choices": [{
                "message": {"role": "assistant", "content": "Done."},
                "finish_reason": "stop",
            }]
        }
        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value.raise_for_status = MagicMock()
            mock_post.return_value.json = MagicMock(return_value=plain_resp)
            result = await engine.chat("先 A 然后 B 整个流程都规划清楚再开始干活", "sess-plan")

        assert result["plan"] == canned_plan
        assert result["reply"] == "Done."

    @pytest.mark.asyncio
    async def test_chat_stream_emits_plan_event_before_content(
        self, mock_memory, mock_subbrain, mock_llm_config, canned_plan
    ):
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, _FakePlanner(canned_plan))

        async def mock_stream(*args, **kwargs):
            yield {"type": "content", "data": "step "}
            yield {"type": "content", "data": "done"}
            yield {"type": "done"}

        events = []
        with patch.object(engine, "_chat_completion_stream", mock_stream):
            async for ev in engine.chat_stream("先 A 然后 B 整个流程都规划清楚再开始干活", "sess"):
                events.append(ev)

        plan_events = [e for e in events if e["type"] == "plan"]
        assert len(plan_events) == 1
        assert plan_events[0]["data"] == canned_plan
        # plan event MUST precede first content chunk
        plan_idx = events.index(plan_events[0])
        first_content_idx = next(i for i, e in enumerate(events) if e["type"] == "content")
        assert plan_idx < first_content_idx

    @pytest.mark.asyncio
    async def test_chat_stream_skips_plan_event_when_planner_returns_none(
        self, mock_memory, mock_subbrain, mock_llm_config
    ):
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, _FakePlanner(None))

        async def mock_stream(*args, **kwargs):
            yield {"type": "content", "data": "Hi"}
            yield {"type": "done"}

        events = []
        with patch.object(engine, "_chat_completion_stream", mock_stream):
            async for ev in engine.chat_stream("hello", "sess"):
                events.append(ev)

        assert not any(e["type"] == "plan" for e in events)


class TestChatEngineExecutionFlags:
    """M3 — chat() honors disable_planner / disable_rag context flags so the
    PlanExecutor can call back into chat() without recursive replanning."""

    @pytest.fixture
    def mock_memory(self):
        mm = MagicMock()
        mm.query = AsyncMock(return_value=[])
        mm.store = AsyncMock(return_value={"id": "m1"})
        return mm

    @pytest.fixture
    def mock_subbrain(self):
        sb = MagicMock()
        sb.execute_tool = AsyncMock(return_value="tool result")
        return sb

    @pytest.fixture
    def loud_planner_loud_rag(self):
        # Planner that would return a plan, RAG that would return chunks —
        # the flags must prevent both from firing.
        planner = _FakePlanner({
            "plan_id": "plan-x",
            "user_input": "x",
            "tasks": [{"id": "task-1", "description": "would have planned"}],
            "confidence": 0.9,
            "reasoning": "",
        })
        rag = _FakeRAG([_FakeChunk("/doc.md", 0, "would have retrieved", 0.9)])
        return planner, rag

    def _make_engine(self, mem, sb, cfg, planner, rag):
        return ChatEngine(
            memory_manager=mem,
            sub_brain_client=sb,
            llm_config=cfg,
            planner=planner,
            rag_retriever=rag,
        )

    @pytest.mark.asyncio
    async def test_chat_skips_planner_when_disable_planner_set(
        self, mock_memory, mock_subbrain, mock_llm_config, loud_planner_loud_rag
    ):
        planner, rag = loud_planner_loud_rag
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, planner, rag)

        plain_resp = {"choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]}
        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value.raise_for_status = MagicMock()
            mock_post.return_value.json = MagicMock(return_value=plain_resp)
            result = await engine.chat(
                "complex request that would normally trigger planner",
                "sess",
                context={"disable_planner": True},
            )

        assert result["plan"] is None
        assert planner.calls == []  # planner never invoked

    @pytest.mark.asyncio
    async def test_chat_skips_rag_when_disable_rag_set(
        self, mock_memory, mock_subbrain, mock_llm_config, loud_planner_loud_rag
    ):
        planner, rag = loud_planner_loud_rag
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, planner, rag)

        plain_resp = {"choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]}
        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value.raise_for_status = MagicMock()
            mock_post.return_value.json = MagicMock(return_value=plain_resp)
            result = await engine.chat("question about docs", "sess", context={"disable_rag": True})

        assert result["rag_sources"] == []
        assert rag.calls == []  # retriever never queried

    @pytest.mark.asyncio
    async def test_chat_stream_honors_both_flags(
        self, mock_memory, mock_subbrain, mock_llm_config, loud_planner_loud_rag
    ):
        planner, rag = loud_planner_loud_rag
        engine = self._make_engine(mock_memory, mock_subbrain, mock_llm_config, planner, rag)

        async def mock_stream(*args, **kwargs):
            yield {"type": "content", "data": "Hi"}
            yield {"type": "done"}

        events = []
        with patch.object(engine, "_chat_completion_stream", mock_stream):
            async for ev in engine.chat_stream(
                "complex multi-step request would have planned and retrieved",
                "sess",
                context={"disable_planner": True, "disable_rag": True},
            ):
                events.append(ev)

        # No plan event, no rag_sources event
        assert not any(e["type"] in ("plan", "rag_sources") for e in events)
        assert planner.calls == []
        assert rag.calls == []
