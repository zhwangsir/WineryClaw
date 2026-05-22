"""Plan execution engine — runs a Plan task-by-task with verify + retry.

M3 layer on top of M2's Planner. Where Planner *names* the subtasks,
PlanExecutor actually drives the assistant through each one,
verifies the output, and retries on failure.

Design tenets:
  - **Decoupled from ChatEngine**: PlanExecutor receives an async
    `execute_fn(user_input, session_id, agent_id, context) -> str`
    callable. In production this wraps `ChatEngine.chat()`; tests inject
    a stub. The executor never imports ChatEngine.
  - **Plug-in verifier**: any async `(task, output) -> (passed, reason)`
    callable. Two are shipped:
      - `presence_verifier` — non-empty + minimum length floor
      - `LLMGradeVerifier`  — LLM judges semantic satisfaction
  - **Bounded retries with one strategy switch**: each task gets up to
    `MAX_RETRIES` attempts. The first `STRATEGY_SWITCH_AT` use the bare
    task description; subsequent attempts get an augmented prompt
    naming the prior failure reasons and asking for a different
    approach. Single binary switch, no fancy ladders.
  - **Fail-safe per-task**: an exception inside `execute_fn` is logged
    and recorded as a failed attempt; we do not abort the plan.
  - **Failed tasks do not block subsequent tasks**: each task runs
    independently. Prior task outputs are passed forward as context.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from typing import Any, AsyncGenerator, Awaitable, Callable, Dict, List, Optional, Tuple

from .planner import Plan, PlanTask

logger = logging.getLogger("webrain.planner.executor")

# Tunables. Kept module-level constants on purpose — easy to monkey-patch
# in tests, no need for a config object.
MAX_RETRIES = 5
STRATEGY_SWITCH_AT = 3  # attempts 1..3 = default, 4..5 = augmented
MIN_OUTPUT_LEN = 5  # for presence_verifier
MAX_PRIOR_OUTPUT_CHARS = 200  # truncation when threading prior outputs into prompt
# Round M3 — cap how many times we'll regenerate the plan after a fail.
# Even with a smart re-planner, three full plans is plenty before we give
# up and surface the partial result.
MAX_REPLANS = 2


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TaskAttempt:
    """A single attempt at executing one task."""

    attempt_idx: int  # 1-based
    output: str
    verification_passed: bool
    verification_reason: str
    strategy: str  # "default" | "augmented"
    duration_ms: int

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class TaskResult:
    """All attempts plus final outcome for one task."""

    task_id: str
    description: str
    final_output: str
    attempts: List[TaskAttempt] = field(default_factory=list)
    succeeded: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "description": self.description,
            "final_output": self.final_output,
            "attempts": [a.to_dict() for a in self.attempts],
            "succeeded": self.succeeded,
        }


@dataclass(frozen=True)
class ExecutionResult:
    """End-to-end result of running one Plan."""

    plan_id: str
    results: List[TaskResult]
    total_attempts: int
    overall_success: bool
    failed_task_ids: List[str]
    # Round M3 — number of times the executor regenerated the plan after
    # exhausting per-task retries. 0 = the original plan completed (or
    # failed without replanning).
    replan_count: int = 0
    # When replanning produced a new plan, this holds the new plan_id
    # for traceability. None if no replan happened.
    final_plan_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "results": [r.to_dict() for r in self.results],
            "total_attempts": self.total_attempts,
            "overall_success": self.overall_success,
            "failed_task_ids": self.failed_task_ids,
            "replan_count": self.replan_count,
            "final_plan_id": self.final_plan_id,
        }


# Verifier interface: async (task, output) -> (passed, reason)
VerifierFn = Callable[[PlanTask, str], Awaitable[Tuple[bool, str]]]
# Executor interface: async (user_input, session_id, agent_id, context) -> reply text
ExecuteFn = Callable[[str, str, str, Optional[Dict[str, Any]]], Awaitable[str]]
# Round M3 — Replanner interface: async (failed_plan, failures, session_id) -> new Plan | None
# `failures` is a list of (task_id, description, final_output, reason) tuples
# summarising why the prior attempt did not satisfy each failed task.
ReplanFn = Callable[
    [Plan, List[Tuple[str, str, str, str]], str],
    Awaitable[Optional[Plan]],
]


# ---------------------------------------------------------------------------
# Built-in verifiers
# ---------------------------------------------------------------------------


async def presence_verifier(task: PlanTask, output: str) -> Tuple[bool, str]:
    """Default verifier: output is non-empty and at least MIN_OUTPUT_LEN chars.

    Cheap, free, no LLM call. Misses semantic mismatches — but catches the
    most common failure mode (model returned nothing / stub text).
    """
    if not output:
        return False, "Output is empty"
    trimmed = output.strip()
    if len(trimmed) < MIN_OUTPUT_LEN:
        return False, f"Output too short ({len(trimmed)} < {MIN_OUTPUT_LEN} chars)"
    return True, "Output non-empty and above minimum length"


class LLMGradeVerifier:
    """Verifier that asks an LLM whether `output` actually satisfies `task`.

    Opt-in (caller wires it as the executor's verifier). Falls back to a
    *pass* result on parse/transport error — we'd rather not mis-fail a
    correct output because the grader endpoint is flaky. To get strict
    behavior, combine with presence_verifier and the caller's own gates.
    """

    def __init__(self, call_llm: Callable[[List[Dict[str, str]]], Awaitable[str]]):
        # call_llm is an async fn that takes OpenAI-style messages and
        # returns the raw assistant text. Keeping it injected means tests
        # don't need httpx mocks.
        self.call_llm = call_llm

    async def __call__(self, task: PlanTask, output: str) -> Tuple[bool, str]:
        if not output or not output.strip():
            return False, "Output is empty (skipped LLM grade)"

        system = (
            "你是一个任务结果审核员。判断「输出」是否合理满足「任务描述」。"
            "只输出 JSON,不要其他说明。"
        )
        user = (
            f"任务描述: {task.description}\n"
            f"期望产出(如有): {task.expected_output or '(未指定)'}\n\n"
            f"实际输出:\n{output[:1500]}\n\n"
            '严格按此 schema 输出: {"pass": true/false, "reason": "一句话"}'
        )

        try:
            raw = await self.call_llm(
                [{"role": "system", "content": system}, {"role": "user", "content": user}]
            )
        except Exception as e:
            logger.warning("LLMGradeVerifier call failed; passing through: %s", e)
            return True, f"grader unavailable ({type(e).__name__}); passing through"

        parsed = _safe_extract_grader_json(raw)
        if not isinstance(parsed, dict) or "pass" not in parsed:
            return True, "grader produced unparseable output; passing through"
        return bool(parsed["pass"]), str(parsed.get("reason", "")).strip() or "(no reason)"


# ---------------------------------------------------------------------------
# PlanExecutor
# ---------------------------------------------------------------------------


class PlanExecutor:
    """Run a Plan end-to-end with per-task verification and retry."""

    def __init__(
        self,
        execute_fn: ExecuteFn,
        verifier: Optional[VerifierFn] = None,
        max_retries: int = MAX_RETRIES,
        strategy_switch_at: int = STRATEGY_SWITCH_AT,
        replan_fn: Optional[ReplanFn] = None,
        max_replans: int = MAX_REPLANS,
    ):
        self._execute = execute_fn
        self._verify = verifier or presence_verifier
        self._max_retries = max_retries
        self._strategy_switch_at = strategy_switch_at
        # Round M3 — optional replanner. If None, behavior is unchanged
        # from M2: per-task retries only, no plan regeneration.
        self._replan_fn = replan_fn
        self._max_replans = max(0, max_replans)

    async def run(self, plan: Plan, session_id: str, agent_id: str = "agent-default") -> ExecutionResult:
        """Execute every task in plan, return aggregated result.

        Tasks run sequentially. Successful task outputs are passed forward
        as context for subsequent tasks; failed tasks still run their
        successors so the user gets partial results rather than nothing.

        Round M3 — if a replan_fn was wired AND the executor finishes with
        at least one failure, ask the planner to regenerate a fresh plan
        that factors in the failure reasons. Re-run that plan. Up to
        `max_replans` retries before giving up and surfacing the partial
        result. The original_plan_id is preserved on the ExecutionResult;
        final_plan_id tracks which plan actually succeeded.
        """
        original_plan_id = plan.plan_id
        current_plan = plan
        prior_results: List[TaskResult] = []
        total_attempts = 0
        replan_count = 0

        while True:
            results: List[TaskResult] = []
            prior_outputs: List[Tuple[str, str]] = []  # [(description, output), ...]

            for task in current_plan.tasks:
                r = await self._run_task(task, session_id, agent_id, prior_outputs)
                results.append(r)
                total_attempts += len(r.attempts)
                if r.succeeded and r.final_output.strip():
                    prior_outputs.append((task.description, r.final_output))

            failed_ids = [r.task_id for r in results if not r.succeeded]

            # Happy path: every task passed verification.
            if not failed_ids:
                return ExecutionResult(
                    plan_id=original_plan_id,
                    results=results,
                    total_attempts=total_attempts,
                    overall_success=True,
                    failed_task_ids=[],
                    replan_count=replan_count,
                    final_plan_id=current_plan.plan_id if replan_count else None,
                )

            # At least one task failed.
            # If no replan_fn was wired OR we've burned our replan budget,
            # surface the partial result (legacy M2 behavior).
            if self._replan_fn is None or replan_count >= self._max_replans:
                return ExecutionResult(
                    plan_id=original_plan_id,
                    results=results,
                    total_attempts=total_attempts,
                    overall_success=False,
                    failed_task_ids=failed_ids,
                    replan_count=replan_count,
                    final_plan_id=current_plan.plan_id if replan_count else None,
                )

            # Round M3 — assemble the failure summary and ask for a new plan.
            failures: List[Tuple[str, str, str, str]] = []
            for r in results:
                if not r.succeeded:
                    last_reason = r.attempts[-1].verification_reason if r.attempts else "no attempts"
                    failures.append((r.task_id, r.description, r.final_output or "", last_reason))
            try:
                new_plan = await self._replan_fn(current_plan, failures, session_id)
            except Exception as exc:  # noqa: BLE001 — replan failure mustn't crash exec
                logger.warning("replan_fn raised: %s — surfacing partial result", exc)
                new_plan = None

            if new_plan is None or not new_plan.tasks:
                # Replanner couldn't produce something usable — bail with the
                # partial result rather than spinning.
                logger.info("replan returned None / empty — surfacing partial result")
                return ExecutionResult(
                    plan_id=original_plan_id,
                    results=results,
                    total_attempts=total_attempts,
                    overall_success=False,
                    failed_task_ids=failed_ids,
                    replan_count=replan_count,
                    final_plan_id=current_plan.plan_id if replan_count else None,
                )

            # Successful replan — record + loop with the new plan.
            replan_count += 1
            prior_results = results  # noqa: F841 — retained for potential future trace inspection
            logger.info(
                "replan #%d: %d failures → new plan %s with %d tasks",
                replan_count, len(failures), new_plan.plan_id, len(new_plan.tasks),
            )
            current_plan = new_plan
            # Loop continues with the new plan.

    async def run_stream(
        self,
        plan: Plan,
        session_id: str,
        agent_id: str = "agent-default",
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Streaming variant of `run()` — yields progress events as plan runs.

        Event shapes (all envelope dicts):
          {type: "plan_start",   data: {plan_id, n_tasks, replan_count}}
          {type: "task_start",   data: {plan_id, task_id, description,
                                        idx, total}}
          {type: "attempt_start",data: {plan_id, task_id, attempt_idx,
                                        strategy}}
          {type: "attempt_done", data: {plan_id, task_id, attempt_idx,
                                        passed, reason, duration_ms,
                                        output_preview}}
          {type: "task_done",    data: {plan_id, task_id, succeeded,
                                        attempts: int, final_output_preview}}
          {type: "replan_start", data: {old_plan_id, n_failures,
                                        replan_count}}
          {type: "replan_done",  data: {new_plan_id, n_tasks}}
          {type: "finished",     data: ExecutionResult.to_dict() + {ok: true}}

        The shape mirrors what `run()` returns — the `finished` event is the
        same payload `/plan/execute` produces today, so consumers that only
        care about the final result can ignore intermediate events.

        v2.28 — P0 #5 from ROADMAP V2. Previously the only way to know plan
        progress was wait for the synchronous /plan/execute response, which
        on a 5-task replan-3 plan can be 30+ seconds of UI hang.
        """
        original_plan_id = plan.plan_id
        current_plan = plan
        prior_results: List[TaskResult] = []
        total_attempts = 0
        replan_count = 0

        yield {
            "type": "plan_start",
            "data": {
                "plan_id": current_plan.plan_id,
                "n_tasks": len(current_plan.tasks),
                "replan_count": 0,
            },
        }

        while True:
            results: List[TaskResult] = []
            prior_outputs: List[Tuple[str, str]] = []
            total = len(current_plan.tasks)

            for idx_task, task in enumerate(current_plan.tasks, start=1):
                yield {
                    "type": "task_start",
                    "data": {
                        "plan_id": current_plan.plan_id,
                        "task_id": task.id,
                        "description": task.description,
                        "idx": idx_task,
                        "total": total,
                    },
                }
                attempts: List[TaskAttempt] = []
                last_output = ""
                succeeded = False

                for attempt_idx in range(1, self._max_retries + 1):
                    strategy = (
                        "augmented" if attempt_idx > self._strategy_switch_at else "default"
                    )
                    yield {
                        "type": "attempt_start",
                        "data": {
                            "plan_id": current_plan.plan_id,
                            "task_id": task.id,
                            "attempt_idx": attempt_idx,
                            "strategy": strategy,
                        },
                    }
                    prompt = self._build_prompt(task, prior_outputs, attempts, strategy)
                    t0 = time.time()
                    try:
                        output = await self._execute(
                            prompt,
                            session_id,
                            agent_id,
                            {
                                "disable_planner": True,
                                "disable_rag": True,
                                "plan_execution": True,
                            },
                        )
                    except Exception as e:  # noqa: BLE001
                        logger.warning(
                            "task %s attempt %d execute_fn raised: %s",
                            task.id,
                            attempt_idx,
                            e,
                        )
                        output = ""
                    duration_ms = int((time.time() - t0) * 1000)
                    last_output = output or last_output

                    try:
                        passed, reason = await self._verify(task, output or "")
                    except Exception as e:  # noqa: BLE001 — defensive
                        logger.warning(
                            "verifier raised on task %s attempt %d: %s",
                            task.id,
                            attempt_idx,
                            e,
                        )
                        passed, reason = False, f"verifier error: {type(e).__name__}"

                    attempts.append(
                        TaskAttempt(
                            attempt_idx=attempt_idx,
                            output=output or "",
                            verification_passed=passed,
                            verification_reason=reason,
                            strategy=strategy,
                            duration_ms=duration_ms,
                        )
                    )
                    yield {
                        "type": "attempt_done",
                        "data": {
                            "plan_id": current_plan.plan_id,
                            "task_id": task.id,
                            "attempt_idx": attempt_idx,
                            "passed": passed,
                            "reason": reason,
                            "duration_ms": duration_ms,
                            "output_preview": (output or "")[:120],
                        },
                    }
                    if passed:
                        succeeded = True
                        break

                r = TaskResult(
                    task_id=task.id,
                    description=task.description,
                    final_output=(last_output if not succeeded else attempts[-1].output),
                    attempts=attempts,
                    succeeded=succeeded,
                )
                results.append(r)
                total_attempts += len(attempts)
                if r.succeeded and r.final_output.strip():
                    prior_outputs.append((task.description, r.final_output))

                yield {
                    "type": "task_done",
                    "data": {
                        "plan_id": current_plan.plan_id,
                        "task_id": task.id,
                        "succeeded": succeeded,
                        "attempts": len(attempts),
                        "final_output_preview": (r.final_output or "")[:120],
                    },
                }

            failed_ids = [r.task_id for r in results if not r.succeeded]

            if not failed_ids:
                exec_result = ExecutionResult(
                    plan_id=original_plan_id,
                    results=results,
                    total_attempts=total_attempts,
                    overall_success=True,
                    failed_task_ids=[],
                    replan_count=replan_count,
                    final_plan_id=current_plan.plan_id if replan_count else None,
                )
                payload = exec_result.to_dict()
                payload["ok"] = True
                yield {"type": "finished", "data": payload}
                return

            if self._replan_fn is None or replan_count >= self._max_replans:
                exec_result = ExecutionResult(
                    plan_id=original_plan_id,
                    results=results,
                    total_attempts=total_attempts,
                    overall_success=False,
                    failed_task_ids=failed_ids,
                    replan_count=replan_count,
                    final_plan_id=current_plan.plan_id if replan_count else None,
                )
                payload = exec_result.to_dict()
                payload["ok"] = True  # ok meaning the call completed; success is on overall_success
                yield {"type": "finished", "data": payload}
                return

            # Replan flow.
            failures: List[Tuple[str, str, str, str]] = []
            for r in results:
                if not r.succeeded:
                    last_reason = (
                        r.attempts[-1].verification_reason if r.attempts else "no attempts"
                    )
                    failures.append(
                        (r.task_id, r.description, r.final_output or "", last_reason)
                    )
            yield {
                "type": "replan_start",
                "data": {
                    "old_plan_id": current_plan.plan_id,
                    "n_failures": len(failures),
                    "replan_count": replan_count + 1,
                },
            }
            try:
                new_plan = await self._replan_fn(current_plan, failures, session_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "replan_fn raised: %s — surfacing partial result", exc
                )
                new_plan = None

            if new_plan is None or not new_plan.tasks:
                exec_result = ExecutionResult(
                    plan_id=original_plan_id,
                    results=results,
                    total_attempts=total_attempts,
                    overall_success=False,
                    failed_task_ids=failed_ids,
                    replan_count=replan_count,
                    final_plan_id=current_plan.plan_id if replan_count else None,
                )
                payload = exec_result.to_dict()
                payload["ok"] = True
                yield {"type": "finished", "data": payload}
                return

            replan_count += 1
            prior_results = results  # noqa: F841 — retained for potential trace
            yield {
                "type": "replan_done",
                "data": {
                    "new_plan_id": new_plan.plan_id,
                    "n_tasks": len(new_plan.tasks),
                },
            }
            current_plan = new_plan

    async def _run_task(
        self,
        task: PlanTask,
        session_id: str,
        agent_id: str,
        prior_outputs: List[Tuple[str, str]],
    ) -> TaskResult:
        attempts: List[TaskAttempt] = []
        last_output = ""

        for idx in range(1, self._max_retries + 1):
            strategy = "augmented" if idx > self._strategy_switch_at else "default"
            prompt = self._build_prompt(task, prior_outputs, attempts, strategy)

            t0 = time.time()
            try:
                output = await self._execute(
                    prompt,
                    session_id,
                    agent_id,
                    {"disable_planner": True, "disable_rag": True, "plan_execution": True},
                )
            except Exception as e:
                logger.warning("task %s attempt %d execute_fn raised: %s", task.id, idx, e)
                output = ""
            duration_ms = int((time.time() - t0) * 1000)
            last_output = output or last_output

            try:
                passed, reason = await self._verify(task, output or "")
            except Exception as e:  # pragma: no cover — defensive
                logger.warning("verifier raised on task %s attempt %d: %s", task.id, idx, e)
                passed, reason = False, f"verifier error: {type(e).__name__}"

            attempts.append(
                TaskAttempt(
                    attempt_idx=idx,
                    output=output or "",
                    verification_passed=passed,
                    verification_reason=reason,
                    strategy=strategy,
                    duration_ms=duration_ms,
                )
            )

            if passed:
                return TaskResult(
                    task_id=task.id,
                    description=task.description,
                    final_output=output or "",
                    attempts=attempts,
                    succeeded=True,
                )

        # All retries exhausted — return the last output as best-effort so the
        # caller can still surface something useful.
        return TaskResult(
            task_id=task.id,
            description=task.description,
            final_output=last_output,
            attempts=attempts,
            succeeded=False,
        )

    def _build_prompt(
        self,
        task: PlanTask,
        prior_outputs: List[Tuple[str, str]],
        attempts: List[TaskAttempt],
        strategy: str,
    ) -> str:
        parts: List[str] = [f"任务: {task.description}"]
        if task.expected_output:
            parts.append(f"期望产出: {task.expected_output}")
        if task.requires_tool and task.tool_hint:
            parts.append(f"建议使用工具: {task.tool_hint}")

        if prior_outputs:
            # Last 3 outputs only — keeps prompt size bounded even on a
            # 8-task plan where each output could be a screenful of text.
            parts.append("\n上下文(前序任务的输出):")
            for desc, out in prior_outputs[-3:]:
                snippet = out.strip()[:MAX_PRIOR_OUTPUT_CHARS]
                parts.append(f"- {desc}: {snippet}")

        if strategy == "augmented" and attempts:
            failed = [a for a in attempts if not a.verification_passed]
            if failed:
                parts.append("\n之前的尝试未通过验证,原因如下:")
                for a in failed[-3:]:  # last 3 failure reasons
                    parts.append(f"- 第 {a.attempt_idx} 次: {a.verification_reason}")
                parts.append(
                    "\n请换一种方式重新作答——更完整、更具体,或者用不同的角度切入。"
                )

        return "\n".join(parts)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_extract_grader_json(text: str) -> Any:
    """Lenient JSON extraction for LLMGradeVerifier responses."""
    if not text:
        return None
    candidates: List[str] = []
    fenced = re.search(r"```json\s*(.+?)\s*```", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        candidates.append(fenced.group(1))
    plain = re.findall(r"```\s*(.+?)\s*```", text, re.DOTALL)
    candidates.extend(plain)
    candidates.append(text.strip())
    blob = re.search(r"\{[\s\S]*\}", text)
    if blob:
        candidates.append(blob.group(0))
    for c in candidates:
        try:
            return json.loads(c)
        except Exception:
            continue
    return None
