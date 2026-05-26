"""v2.28 — PlanExecutor.run_stream tests (P0 #5 SSE plan progress).

Verifies the streaming variant emits the documented event sequence
(plan_start → task_start/attempt_start/attempt_done/task_done... → finished)
and that the `finished` payload matches what `run()` would produce
synchronously. Replan and failure paths covered too.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import pytest

from planner import Plan, PlanExecutor, PlanTask, presence_verifier


def _task(tid: str = "t1", desc: str = "do the thing") -> PlanTask:
    return PlanTask(
        id=tid,
        description=desc,
        requires_tool=False,
        tool_hint="",
        expected_output="",
    )


def _plan(tasks: List[PlanTask], plan_id: str = "p1") -> Plan:
    return Plan(
        plan_id=plan_id,
        user_input="test request",
        tasks=tasks,
        confidence=0.8,
        reasoning="test",
    )


class _StubExec:
    def __init__(self, outputs: List[str]) -> None:
        self.outputs = list(outputs)
        self.calls = 0

    async def __call__(
        self,
        user_input: str,
        session_id: str,
        agent_id: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> str:
        self.calls += 1
        return self.outputs.pop(0) if self.outputs else ""


async def _collect(gen) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    async for ev in gen:
        out.append(ev)
    return out


@pytest.mark.asyncio
async def test_run_stream_emits_documented_event_sequence_on_success():
    """Single-task happy path: plan_start → task_start → attempt_start →
    attempt_done(passed) → task_done(succeeded) → finished(overall_success).
    """
    plan = _plan([_task()])
    executor = PlanExecutor(_StubExec(["a valid first attempt output"]), verifier=presence_verifier)

    events = await _collect(executor.run_stream(plan, "sess-1"))
    types = [e["type"] for e in events]

    assert types == [
        "plan_start",
        "task_start",
        "attempt_start",
        "attempt_done",
        "task_done",
        "finished",
    ]

    plan_start = events[0]["data"]
    assert plan_start["plan_id"] == "p1"
    assert plan_start["n_tasks"] == 1
    assert plan_start["replan_count"] == 0

    task_start = events[1]["data"]
    assert task_start["task_id"] == "t1"
    assert task_start["idx"] == 1 and task_start["total"] == 1

    attempt_start = events[2]["data"]
    assert attempt_start["attempt_idx"] == 1
    assert attempt_start["strategy"] == "default"

    attempt_done = events[3]["data"]
    assert attempt_done["passed"] is True
    assert attempt_done["attempt_idx"] == 1
    assert isinstance(attempt_done["duration_ms"], int)
    assert "a valid first" in attempt_done["output_preview"]

    task_done = events[4]["data"]
    assert task_done["succeeded"] is True
    assert task_done["attempts"] == 1

    finished = events[5]["data"]
    assert finished["overall_success"] is True
    assert finished["ok"] is True
    assert finished["failed_task_ids"] == []
    assert finished["total_attempts"] == 1


@pytest.mark.asyncio
async def test_run_stream_emits_one_attempt_event_per_retry_until_pass():
    """Two-attempt task: empty then valid → two attempt_done events, second passes."""
    plan = _plan([_task()])
    # First attempt empty (fails presence), second succeeds.
    executor = PlanExecutor(_StubExec(["", "valid output text"]), verifier=presence_verifier)

    events = await _collect(executor.run_stream(plan, "sess-2"))
    attempt_dones = [e for e in events if e["type"] == "attempt_done"]
    assert len(attempt_dones) == 2
    assert attempt_dones[0]["data"]["passed"] is False
    assert attempt_dones[1]["data"]["passed"] is True

    task_done = next(e for e in events if e["type"] == "task_done")
    assert task_done["data"]["succeeded"] is True
    assert task_done["data"]["attempts"] == 2


@pytest.mark.asyncio
async def test_run_stream_strategy_switches_after_threshold():
    """After STRATEGY_SWITCH_AT (=3) failing attempts, strategy flips to augmented."""
    plan = _plan([_task()])
    # All-empty outputs force every attempt to fail presence.
    executor = PlanExecutor(_StubExec([""] * 5), verifier=presence_verifier)

    events = await _collect(executor.run_stream(plan, "sess-3"))
    strategies = [
        e["data"]["strategy"] for e in events if e["type"] == "attempt_start"
    ]
    # MAX_RETRIES = 5; first 3 default, then 2 augmented.
    assert strategies == ["default", "default", "default", "augmented", "augmented"]


@pytest.mark.asyncio
async def test_run_stream_finished_carries_failure_when_all_attempts_fail():
    """Failing task → finished event has overall_success=false + failed_task_ids."""
    plan = _plan([_task("t-failing")])
    executor = PlanExecutor(_StubExec([""] * 5), verifier=presence_verifier)

    events = await _collect(executor.run_stream(plan, "sess-4"))
    finished = next(e for e in events if e["type"] == "finished")
    assert finished["data"]["overall_success"] is False
    assert finished["data"]["failed_task_ids"] == ["t-failing"]


@pytest.mark.asyncio
async def test_run_stream_replan_emits_replan_events_and_re_runs():
    """When replan_fn produces a new plan, replan_start + replan_done fire
    and the new plan's tasks emit their own task_start sequence."""
    failing_plan = _plan([_task("t-orig")], plan_id="p-orig")
    rescue_plan = _plan([_task("t-rescue")], plan_id="p-rescue")

    # First task always fails (empty); rescue task succeeds.
    outputs = iter([""] * 5 + ["rescue worked"])

    async def stub_exec(prompt, session_id, agent_id, context=None):
        return next(outputs, "")

    async def replan_fn(failed_plan, failures, session_id):
        # Sanity: we should be asked to replan p-orig with one failure.
        assert failed_plan.plan_id == "p-orig"
        assert len(failures) == 1
        return rescue_plan

    executor = PlanExecutor(
        stub_exec,
        verifier=presence_verifier,
        replan_fn=replan_fn,
        max_replans=2,
    )
    events = await _collect(executor.run_stream(failing_plan, "sess-replan"))

    # Two task_start events: t-orig then t-rescue.
    task_starts = [e["data"] for e in events if e["type"] == "task_start"]
    assert [ts["task_id"] for ts in task_starts] == ["t-orig", "t-rescue"]

    replan_start = next(e for e in events if e["type"] == "replan_start")
    assert replan_start["data"]["old_plan_id"] == "p-orig"
    assert replan_start["data"]["n_failures"] == 1
    assert replan_start["data"]["replan_count"] == 1

    replan_done = next(e for e in events if e["type"] == "replan_done")
    assert replan_done["data"]["new_plan_id"] == "p-rescue"
    assert replan_done["data"]["n_tasks"] == 1

    finished = next(e for e in events if e["type"] == "finished")
    assert finished["data"]["overall_success"] is True
    # Original plan id is preserved on the ExecutionResult.
    assert finished["data"]["plan_id"] == "p-orig"
    assert finished["data"]["final_plan_id"] == "p-rescue"
    assert finished["data"]["replan_count"] == 1


@pytest.mark.asyncio
async def test_run_stream_replan_giving_up_surfaces_partial_finished():
    """When replan_fn returns None, executor surfaces partial result without
    looping forever."""
    plan = _plan([_task()])
    executor = PlanExecutor(
        _StubExec([""] * 5),
        verifier=presence_verifier,
        replan_fn=lambda *a, **kw: _none_async(),
        max_replans=2,
    )
    events = await _collect(executor.run_stream(plan, "sess-noreplan"))
    finished = next(e for e in events if e["type"] == "finished")
    assert finished["data"]["overall_success"] is False
    # replan_start fired once, replan_done did NOT (because new_plan is None).
    starts = [e for e in events if e["type"] == "replan_start"]
    dones = [e for e in events if e["type"] == "replan_done"]
    assert len(starts) == 1
    assert len(dones) == 0


async def _none_async():
    """Helper coroutine returning None — used as `replan_fn` to trigger
    the "replan unavailable" branch.
    """
    return None


@pytest.mark.asyncio
async def test_run_stream_finished_payload_equals_run_for_simple_plan():
    """The synchronous `run()` and streaming `run_stream`'s finished payload
    must agree on the canonical fields (overall_success, plan_id,
    total_attempts, failed_task_ids). Guards against drift between code paths.
    """
    plan = _plan([_task("t-a"), _task("t-b")])
    # Both tasks succeed in one attempt.
    executor = PlanExecutor(_StubExec(["valid output A", "valid output B"]), verifier=presence_verifier)
    sync_result = (await executor.run(plan, "sess-equiv")).to_dict()

    plan2 = _plan([_task("t-a"), _task("t-b")])  # fresh; outputs consumed above
    executor2 = PlanExecutor(_StubExec(["valid output A", "valid output B"]), verifier=presence_verifier)
    events = await _collect(executor2.run_stream(plan2, "sess-equiv"))
    streamed_result = next(e for e in events if e["type"] == "finished")["data"]
    # Drop the streaming-only `ok` field for comparison.
    streamed_result.pop("ok", None)

    for key in ["plan_id", "overall_success", "failed_task_ids", "total_attempts"]:
        assert sync_result[key] == streamed_result[key], (
            f"divergence at {key}: sync={sync_result[key]} stream={streamed_result[key]}"
        )
