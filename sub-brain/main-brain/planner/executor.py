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
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from .planner import Plan, PlanTask

logger = logging.getLogger("webrain.planner.executor")

# Tunables. Kept module-level constants on purpose — easy to monkey-patch
# in tests, no need for a config object.
MAX_RETRIES = 5
STRATEGY_SWITCH_AT = 3  # attempts 1..3 = default, 4..5 = augmented
MIN_OUTPUT_LEN = 5  # for presence_verifier
MAX_PRIOR_OUTPUT_CHARS = 200  # truncation when threading prior outputs into prompt


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

    def to_dict(self) -> Dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "results": [r.to_dict() for r in self.results],
            "total_attempts": self.total_attempts,
            "overall_success": self.overall_success,
            "failed_task_ids": self.failed_task_ids,
        }


# Verifier interface: async (task, output) -> (passed, reason)
VerifierFn = Callable[[PlanTask, str], Awaitable[Tuple[bool, str]]]
# Executor interface: async (user_input, session_id, agent_id, context) -> reply text
ExecuteFn = Callable[[str, str, str, Optional[Dict[str, Any]]], Awaitable[str]]


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
    ):
        self._execute = execute_fn
        self._verify = verifier or presence_verifier
        self._max_retries = max_retries
        self._strategy_switch_at = strategy_switch_at

    async def run(self, plan: Plan, session_id: str, agent_id: str = "agent-default") -> ExecutionResult:
        """Execute every task in plan, return aggregated result.

        Tasks run sequentially. Successful task outputs are passed forward
        as context for subsequent tasks; failed tasks still run their
        successors so the user gets partial results rather than nothing.
        """
        results: List[TaskResult] = []
        prior_outputs: List[Tuple[str, str]] = []  # [(description, output), ...]
        total_attempts = 0

        for task in plan.tasks:
            r = await self._run_task(task, session_id, agent_id, prior_outputs)
            results.append(r)
            total_attempts += len(r.attempts)
            if r.succeeded and r.final_output.strip():
                prior_outputs.append((task.description, r.final_output))

        failed_ids = [r.task_id for r in results if not r.succeeded]
        return ExecutionResult(
            plan_id=plan.plan_id,
            results=results,
            total_attempts=total_attempts,
            overall_success=not failed_ids,
            failed_task_ids=failed_ids,
        )

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
