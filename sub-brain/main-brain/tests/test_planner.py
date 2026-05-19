"""Tests for the Planner (M2 — task decomposition)."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from planner import Plan, Planner


# ---------------------------------------------------------------------------
# is_complex — cheap pre-filter
# ---------------------------------------------------------------------------


class TestIsComplex:
    def setup_method(self) -> None:
        self.p = Planner({})

    def test_empty_input_is_not_complex(self) -> None:
        assert self.p.is_complex("") is False
        assert self.p.is_complex("   ") is False

    def test_short_greeting_is_not_complex(self) -> None:
        assert self.p.is_complex("hi") is False
        assert self.p.is_complex("你好") is False

    def test_short_question_no_markers_is_not_complex(self) -> None:
        # Below MIN_COMPLEX_LEN, no markers
        assert self.p.is_complex("what time is it?") is False

    def test_long_request_is_complex_even_without_markers(self) -> None:
        # > LONG_REQUEST_LEN (120 chars)
        long_q = "请详细介绍一下机器学习里的支持向量机算法,它的数学推导,核函数的选择,以及在文本分类问题上的表现和工程上需要注意的事项,要尽量完整"
        assert len(long_q) > 30
        assert self.p.is_complex(long_q) is True

    def test_marker_then_triggers_planning(self) -> None:
        s = "先帮我打开项目下的 config.json 文件然后总结里面所有的关键字段和它们的含义"
        assert len(s) >= 30  # sanity: above MIN_COMPLEX_LEN
        assert self.p.is_complex(s) is True

    def test_english_step_by_step_marker(self) -> None:
        s = "Please help me debug this bug step by step in the auth module"
        assert self.p.is_complex(s) is True

    def test_multiple_questions_marker(self) -> None:
        s = "What is X? And how does Y work? Why is Z important?"
        assert self.p.is_complex(s) is True

    def test_marker_without_min_length_does_not_trigger(self) -> None:
        # Marker present but text below MIN_COMPLEX_LEN — skip
        assert self.p.is_complex("先 A 然后 B") is False


# ---------------------------------------------------------------------------
# plan() — happy path and fail-open
# ---------------------------------------------------------------------------


class TestPlanLLMHappyPath:
    @pytest.fixture
    def cfg(self):
        return {"base_url": "http://localhost:99999/v1", "model_id": "test-model"}

    @pytest.mark.asyncio
    async def test_returns_none_for_trivial_input(self, cfg) -> None:
        planner = Planner(cfg)
        assert await planner.plan("hi") is None
        assert await planner.plan("") is None

    @pytest.mark.asyncio
    async def test_parses_well_formed_llm_response(self, cfg) -> None:
        llm_response = (
            '{"tasks": ['
            '{"description": "读取 notes.md", "requires_tool": true, '
            '"tool_hint": "read_file", "expected_output": "文件内容"},'
            '{"description": "总结要点", "requires_tool": false, '
            '"tool_hint": "", "expected_output": "3 个要点"}'
            '], "confidence": 0.85, "reasoning": "标准两步任务"}'
        )
        planner = Planner(cfg)
        with patch.object(planner, "_call_llm", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = llm_response
            plan = await planner.plan("帮我先读取 notes.md 这个文件然后再总结里面所有的要点和关键术语,要详细")

        assert isinstance(plan, Plan)
        assert len(plan.tasks) == 2
        assert plan.tasks[0].id == "task-1"
        assert plan.tasks[0].description == "读取 notes.md"
        assert plan.tasks[0].requires_tool is True
        assert plan.tasks[0].tool_hint == "read_file"
        assert plan.tasks[1].id == "task-2"
        assert plan.confidence == 0.85
        assert plan.reasoning == "标准两步任务"
        assert plan.plan_id.startswith("plan-")

    @pytest.mark.asyncio
    async def test_parses_fenced_json_block(self, cfg) -> None:
        llm_response = (
            "Here is the plan:\n```json\n"
            '{"tasks": [{"description": "step A"}, {"description": "step B"}],'
            ' "confidence": 0.7, "reasoning": "two-step"}\n'
            "```"
        )
        planner = Planner(cfg)
        with patch.object(planner, "_call_llm", new_callable=AsyncMock, return_value=llm_response):
            plan = await planner.plan("先做 A 然后再做 B,期间还要做点必要的准备工作并验证每一步")

        assert plan is not None
        assert len(plan.tasks) == 2
        assert plan.tasks[0].description == "step A"

    @pytest.mark.asyncio
    async def test_caps_tasks_at_max(self, cfg) -> None:
        # 12 tasks in LLM response → planner should truncate to 8
        tasks = ",".join(f'{{"description": "task {i}"}}' for i in range(12))
        llm_response = f'{{"tasks": [{tasks}], "confidence": 0.5, "reasoning": "many"}}'
        planner = Planner(cfg)
        with patch.object(planner, "_call_llm", new_callable=AsyncMock, return_value=llm_response):
            plan = await planner.plan(
                "我要做很多事情包括 A B C D E F G H I J K L 每一项都很重要请帮我规划好顺序和依赖关系"
            )

        assert plan is not None
        assert len(plan.tasks) == 8  # MAX_TASKS_PER_PLAN

    @pytest.mark.asyncio
    async def test_skips_tasks_with_empty_description(self, cfg) -> None:
        llm_response = (
            '{"tasks": ['
            '{"description": ""}, '
            '{"description": "valid"}, '
            '{"description": "   "}'
            '], "confidence": 0.6, "reasoning": "filter test"}'
        )
        planner = Planner(cfg)
        with patch.object(planner, "_call_llm", new_callable=AsyncMock, return_value=llm_response):
            plan = await planner.plan("先 A 然后 B 接着 C 最后 D 整个流程要完整并验证好")

        assert plan is not None
        assert len(plan.tasks) == 1
        assert plan.tasks[0].description == "valid"

    @pytest.mark.asyncio
    async def test_clamps_confidence_to_valid_range(self, cfg) -> None:
        llm_response = (
            '{"tasks": [{"description": "ok"}], "confidence": 5.5, "reasoning": "bad conf"}'
        )
        planner = Planner(cfg)
        with patch.object(planner, "_call_llm", new_callable=AsyncMock, return_value=llm_response):
            plan = await planner.plan("帮我先 A 然后 B 整个流程都规划好需要哪些工具调用和顺序")
        assert plan is not None
        assert plan.confidence == 1.0


class TestPlanFailOpen:
    @pytest.fixture
    def cfg(self):
        return {"base_url": "http://localhost:99999/v1", "model_id": "test-model"}

    @pytest.mark.asyncio
    async def test_returns_none_when_llm_raises(self, cfg) -> None:
        planner = Planner(cfg)
        with patch.object(
            planner, "_call_llm", new_callable=AsyncMock, side_effect=RuntimeError("connection refused")
        ):
            plan = await planner.plan("先 A 然后 B 整个流程都规划清楚再开始干活")
        assert plan is None

    @pytest.mark.asyncio
    async def test_returns_none_for_non_json_output(self, cfg) -> None:
        planner = Planner(cfg)
        with patch.object(planner, "_call_llm", new_callable=AsyncMock, return_value="Sure, I'll do it!"):
            plan = await planner.plan("先 A 然后 B 整个流程都规划清楚再开始干活")
        assert plan is None

    @pytest.mark.asyncio
    async def test_returns_none_when_tasks_missing(self, cfg) -> None:
        planner = Planner(cfg)
        with patch.object(
            planner,
            "_call_llm",
            new_callable=AsyncMock,
            return_value='{"confidence": 0.5, "reasoning": "no tasks"}',
        ):
            plan = await planner.plan("先 A 然后 B 整个流程都规划清楚再开始干活")
        assert plan is None

    @pytest.mark.asyncio
    async def test_returns_none_when_all_tasks_invalid(self, cfg) -> None:
        # All tasks lack a non-empty description → drop
        planner = Planner(cfg)
        with patch.object(
            planner,
            "_call_llm",
            new_callable=AsyncMock,
            return_value='{"tasks": [{}, {"description": ""}, "not even a dict"], "confidence": 0.4}',
        ):
            plan = await planner.plan("先 A 然后 B 整个流程都规划清楚再开始干活")
        assert plan is None


class TestEndpointResolution:
    @pytest.mark.asyncio
    async def test_raises_without_configured_endpoint(self) -> None:
        # No base_url/model_id at all → _call_llm should raise → plan returns None
        planner = Planner({})
        plan = await planner.plan("先 A 然后 B 整个流程都规划清楚再开始干活")
        assert plan is None

    def test_picks_highest_priority_from_endpoints_list(self) -> None:
        planner = Planner({
            "endpoints": [
                {"name": "low", "base_url": "http://low/v1", "model_id": "lo", "priority": 1},
                {"name": "high", "base_url": "http://high/v1", "model_id": "hi", "priority": 10},
                {"name": "mid", "base_url": "http://mid/v1", "model_id": "md", "priority": 5},
            ]
        })
        ep = planner._resolve_endpoint()
        assert ep["base_url"] == "http://high/v1"
        assert ep["model_id"] == "hi"
