"""Tests for the PlanExecutor (M3 — verify + retry)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from unittest.mock import AsyncMock

import pytest

from planner import (
    ExecutionResult,
    LLMGradeVerifier,
    Plan,
    PlanExecutor,
    PlanTask,
    TaskAttempt,
    TaskResult,
    presence_verifier,
)
from planner.executor import (
    MAX_PRIOR_OUTPUT_CHARS,
    MAX_RETRIES,
    MIN_OUTPUT_LEN,
    STRATEGY_SWITCH_AT,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_plan(tasks: List[PlanTask], plan_id: str = "plan-test") -> Plan:
    return Plan(
        plan_id=plan_id,
        user_input="test request",
        tasks=tasks,
        confidence=0.8,
        reasoning="test",
    )


def _task(
    tid: str = "task-1",
    desc: str = "do the thing",
    requires_tool: bool = False,
    tool_hint: str = "",
    expected_output: str = "",
) -> PlanTask:
    return PlanTask(
        id=tid,
        description=desc,
        requires_tool=requires_tool,
        tool_hint=tool_hint,
        expected_output=expected_output,
    )


class _RecordingExecutor:
    """Tracks every call to execute_fn so tests can assert prompt evolution."""

    def __init__(self, outputs: List[str]):
        # outputs is consumed in order; if exhausted, "" is returned.
        self.outputs = list(outputs)
        self.calls: List[Tuple[str, str, str, Optional[Dict[str, Any]]]] = []

    async def __call__(
        self,
        user_input: str,
        session_id: str,
        agent_id: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> str:
        self.calls.append((user_input, session_id, agent_id, context))
        return self.outputs.pop(0) if self.outputs else ""


# ---------------------------------------------------------------------------
# presence_verifier
# ---------------------------------------------------------------------------


class TestPresenceVerifier:
    @pytest.mark.asyncio
    async def test_empty_string_fails(self) -> None:
        passed, _ = await presence_verifier(_task(), "")
        assert passed is False

    @pytest.mark.asyncio
    async def test_whitespace_only_fails(self) -> None:
        passed, _ = await presence_verifier(_task(), "   \n  \t  ")
        assert passed is False

    @pytest.mark.asyncio
    async def test_short_output_fails(self) -> None:
        passed, reason = await presence_verifier(_task(), "hi")
        assert passed is False
        assert "too short" in reason.lower()

    @pytest.mark.asyncio
    async def test_long_enough_output_passes(self) -> None:
        passed, _ = await presence_verifier(_task(), "Some valid output that's longer.")
        assert passed is True

    @pytest.mark.asyncio
    async def test_boundary_at_min_length(self) -> None:
        # Exactly MIN_OUTPUT_LEN chars after strip
        passed, _ = await presence_verifier(_task(), "x" * MIN_OUTPUT_LEN)
        assert passed is True


# ---------------------------------------------------------------------------
# PlanExecutor — happy paths
# ---------------------------------------------------------------------------


class TestPlanExecutorHappyPath:
    @pytest.mark.asyncio
    async def test_single_task_succeeds_first_try(self) -> None:
        execute = _RecordingExecutor(["a perfectly good answer"])
        executor = PlanExecutor(execute)
        plan = _make_plan([_task("t1", "explain X")])
        result = await executor.run(plan, "sess-1")

        assert isinstance(result, ExecutionResult)
        assert result.overall_success is True
        assert result.failed_task_ids == []
        assert result.total_attempts == 1
        assert len(result.results) == 1
        assert result.results[0].succeeded is True
        assert result.results[0].final_output == "a perfectly good answer"
        assert len(result.results[0].attempts) == 1
        # Verify the first attempt used "default" strategy
        assert result.results[0].attempts[0].strategy == "default"

    @pytest.mark.asyncio
    async def test_multi_task_all_succeed(self) -> None:
        execute = _RecordingExecutor(["output 1 done", "output 2 done", "output 3 done"])
        plan = _make_plan(
            [_task("t1", "step one"), _task("t2", "step two"), _task("t3", "step three")]
        )
        executor = PlanExecutor(execute)
        result = await executor.run(plan, "sess-1")

        assert result.overall_success is True
        assert result.total_attempts == 3
        assert len(result.results) == 3
        assert all(r.succeeded for r in result.results)
        assert [r.final_output for r in result.results] == [
            "output 1 done",
            "output 2 done",
            "output 3 done",
        ]

    @pytest.mark.asyncio
    async def test_prior_outputs_are_threaded_into_subsequent_prompts(self) -> None:
        execute = _RecordingExecutor(["first task complete", "second relies on first"])
        plan = _make_plan([_task("t1", "read file"), _task("t2", "summarize it")])
        executor = PlanExecutor(execute)
        await executor.run(plan, "sess-1")

        # First prompt: only the task itself
        first_prompt = execute.calls[0][0]
        assert "read file" in first_prompt
        assert "first task complete" not in first_prompt  # nothing prior

        # Second prompt: includes prior context block referencing task 1
        second_prompt = execute.calls[1][0]
        assert "summarize it" in second_prompt
        assert "上下文" in second_prompt
        assert "first task complete" in second_prompt


# ---------------------------------------------------------------------------
# PlanExecutor — retry & strategy switch
# ---------------------------------------------------------------------------


class TestPlanExecutorRetry:
    @pytest.mark.asyncio
    async def test_retries_until_success(self) -> None:
        # First 2 attempts fail (empty), 3rd succeeds
        execute = _RecordingExecutor(["", "", "finally a good answer"])
        plan = _make_plan([_task("t1", "do it")])
        executor = PlanExecutor(execute)
        result = await executor.run(plan, "sess-1")

        assert result.overall_success is True
        assert result.total_attempts == 3
        attempts = result.results[0].attempts
        assert len(attempts) == 3
        assert [a.verification_passed for a in attempts] == [False, False, True]
        assert result.results[0].final_output == "finally a good answer"

    @pytest.mark.asyncio
    async def test_strategy_switches_after_threshold(self) -> None:
        # All attempts fail (empty) so we observe all strategies
        execute = _RecordingExecutor(["", "", "", "", ""])
        plan = _make_plan([_task("t1", "stubborn task")])
        executor = PlanExecutor(execute)
        result = await executor.run(plan, "sess-1")

        attempts = result.results[0].attempts
        assert len(attempts) == MAX_RETRIES
        strategies = [a.strategy for a in attempts]
        # First STRATEGY_SWITCH_AT are "default", rest are "augmented"
        assert strategies[:STRATEGY_SWITCH_AT] == ["default"] * STRATEGY_SWITCH_AT
        assert strategies[STRATEGY_SWITCH_AT:] == ["augmented"] * (MAX_RETRIES - STRATEGY_SWITCH_AT)

    @pytest.mark.asyncio
    async def test_augmented_prompt_includes_prior_failure_reasons(self) -> None:
        # Fail 4 times then succeed — the 4th call is in augmented mode and
        # should mention prior failure reasons.
        execute = _RecordingExecutor(["", "", "", "", "good enough now to pass verifier"])
        plan = _make_plan([_task("t1", "task X")])
        executor = PlanExecutor(execute)
        await executor.run(plan, "sess-1")

        # 4th attempt's prompt (index 3) is the first augmented call
        augmented_prompt = execute.calls[STRATEGY_SWITCH_AT][0]
        assert "之前的尝试未通过验证" in augmented_prompt
        assert "请换一种方式重新作答" in augmented_prompt

    @pytest.mark.asyncio
    async def test_exhausts_all_retries_when_persistently_failing(self) -> None:
        execute = _RecordingExecutor([""] * (MAX_RETRIES + 2))
        plan = _make_plan([_task("t1", "impossible task")])
        executor = PlanExecutor(execute)
        result = await executor.run(plan, "sess-1")

        assert result.overall_success is False
        assert result.failed_task_ids == ["t1"]
        assert len(result.results[0].attempts) == MAX_RETRIES
        assert result.results[0].succeeded is False
        # Best-effort fallback: final_output is the last attempt's output
        assert result.results[0].final_output == ""

    @pytest.mark.asyncio
    async def test_failed_task_does_not_block_subsequent_tasks(self) -> None:
        # task 1 fails 5x, task 2 succeeds on first try
        execute = _RecordingExecutor([""] * MAX_RETRIES + ["task 2 succeeded fine"])
        plan = _make_plan([_task("t1", "broken"), _task("t2", "fine")])
        executor = PlanExecutor(execute)
        result = await executor.run(plan, "sess-1")

        assert result.overall_success is False
        assert result.failed_task_ids == ["t1"]
        assert result.results[1].succeeded is True
        assert result.results[1].final_output == "task 2 succeeded fine"
        # t1 failed → its output is NOT threaded into t2's prompt
        t2_prompt = execute.calls[MAX_RETRIES][0]  # call after t1's 5 attempts
        assert "上下文" not in t2_prompt


# ---------------------------------------------------------------------------
# Robustness
# ---------------------------------------------------------------------------


class TestPlanExecutorRobustness:
    @pytest.mark.asyncio
    async def test_executor_exception_recorded_as_failed_attempt(self) -> None:
        # execute_fn raises every time; should not propagate, should retry
        call_log: List[int] = []

        async def boom(*args, **kwargs):
            call_log.append(1)
            raise RuntimeError("transient network error")

        executor = PlanExecutor(boom)
        plan = _make_plan([_task("t1", "any task")])
        result = await executor.run(plan, "sess-1")

        assert result.overall_success is False
        assert len(call_log) == MAX_RETRIES
        assert len(result.results[0].attempts) == MAX_RETRIES
        # Each recorded attempt has empty output
        assert all(a.output == "" for a in result.results[0].attempts)
        assert all(not a.verification_passed for a in result.results[0].attempts)

    @pytest.mark.asyncio
    async def test_disable_planner_and_rag_flags_passed_to_executor(self) -> None:
        execute = _RecordingExecutor(["fine output"])
        plan = _make_plan([_task("t1", "do it")])
        executor = PlanExecutor(execute)
        await executor.run(plan, "sess-1", "agent-x")

        # Inspect the context passed to execute_fn
        _, session_id, agent_id, ctx = execute.calls[0]
        assert session_id == "sess-1"
        assert agent_id == "agent-x"
        assert ctx is not None
        assert ctx.get("disable_planner") is True
        assert ctx.get("disable_rag") is True
        assert ctx.get("plan_execution") is True

    @pytest.mark.asyncio
    async def test_empty_plan_returns_success_with_no_results(self) -> None:
        execute = _RecordingExecutor([])
        plan = _make_plan([])
        executor = PlanExecutor(execute)
        result = await executor.run(plan, "sess-1")

        assert result.overall_success is True
        assert result.results == []
        assert result.total_attempts == 0
        assert execute.calls == []

    @pytest.mark.asyncio
    async def test_custom_verifier_can_force_specific_decision(self) -> None:
        # Verifier: pass only if output contains the literal "MAGIC"
        async def magic_verifier(task, output):
            return ("MAGIC" in output, "needs MAGIC")

        execute = _RecordingExecutor(["no magic here", "still nothing", "behold MAGIC arrives"])
        plan = _make_plan([_task("t1", "produce magic")])
        executor = PlanExecutor(execute, verifier=magic_verifier)
        result = await executor.run(plan, "sess-1")

        assert result.overall_success is True
        assert len(result.results[0].attempts) == 3
        assert result.results[0].attempts[-1].verification_passed is True

    @pytest.mark.asyncio
    async def test_task_with_tool_hint_appears_in_prompt(self) -> None:
        execute = _RecordingExecutor(["valid response from the model"])
        plan = _make_plan([
            _task("t1", "read a file", requires_tool=True, tool_hint="read_file",
                  expected_output="file contents string")
        ])
        executor = PlanExecutor(execute)
        await executor.run(plan, "sess-1")

        prompt = execute.calls[0][0]
        assert "read a file" in prompt
        assert "read_file" in prompt
        assert "file contents string" in prompt


# ---------------------------------------------------------------------------
# LLMGradeVerifier
# ---------------------------------------------------------------------------


class TestLLMGradeVerifier:
    @pytest.mark.asyncio
    async def test_empty_output_is_failed_without_calling_llm(self) -> None:
        called = []

        async def llm(_):
            called.append(1)
            return '{"pass": true}'

        v = LLMGradeVerifier(llm)
        passed, _ = await v(_task(), "")
        assert passed is False
        assert called == []  # short-circuited before LLM

    @pytest.mark.asyncio
    async def test_parses_clean_json_pass(self) -> None:
        async def llm(_):
            return '{"pass": true, "reason": "satisfied"}'

        v = LLMGradeVerifier(llm)
        passed, reason = await v(_task("t1", "do it"), "good answer here.")
        assert passed is True
        assert reason == "satisfied"

    @pytest.mark.asyncio
    async def test_parses_fenced_json_fail(self) -> None:
        async def llm(_):
            return 'Grader says:\n```json\n{"pass": false, "reason": "missing detail"}\n```'

        v = LLMGradeVerifier(llm)
        passed, reason = await v(_task("t1", "do it"), "stub")
        assert passed is False
        assert "missing detail" in reason

    @pytest.mark.asyncio
    async def test_passes_through_on_llm_exception(self) -> None:
        async def llm(_):
            raise RuntimeError("grader unreachable")

        v = LLMGradeVerifier(llm)
        passed, reason = await v(_task(), "any output")
        # Fail-safe: pass through so a flaky grader doesn't block successful work
        assert passed is True
        assert "grader unavailable" in reason

    @pytest.mark.asyncio
    async def test_passes_through_on_unparseable_output(self) -> None:
        async def llm(_):
            return "Sure thing, looks good to me."

        v = LLMGradeVerifier(llm)
        passed, reason = await v(_task(), "any output")
        assert passed is True
        assert "unparseable" in reason


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


class TestSerialization:
    @pytest.mark.asyncio
    async def test_execution_result_to_dict_round_trip(self) -> None:
        execute = _RecordingExecutor(["good answer here"])
        plan = _make_plan([_task("t1", "explain X")])
        executor = PlanExecutor(execute)
        result = await executor.run(plan, "sess-1")

        d = result.to_dict()
        assert d["plan_id"] == "plan-test"
        assert d["overall_success"] is True
        assert d["failed_task_ids"] == []
        assert d["total_attempts"] == 1
        assert isinstance(d["results"], list)
        assert d["results"][0]["task_id"] == "t1"
        assert d["results"][0]["succeeded"] is True
        assert isinstance(d["results"][0]["attempts"], list)
        attempt = d["results"][0]["attempts"][0]
        # Confirm attempt dict has the expected keys
        for key in ("attempt_idx", "output", "verification_passed", "verification_reason",
                    "strategy", "duration_ms"):
            assert key in attempt

    def test_prior_output_constants_sensible(self) -> None:
        # Sanity check: tunables haven't drifted into nonsense
        assert MAX_RETRIES > STRATEGY_SWITCH_AT
        assert MIN_OUTPUT_LEN > 0
        assert MAX_PRIOR_OUTPUT_CHARS >= 50
