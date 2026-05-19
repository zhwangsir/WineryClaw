"""Task decomposition (Planner — M2) and execution (PlanExecutor — M3).

- `Planner` splits a complex user request into structured atomic subtasks
  so chat can show "here's what I'm about to do" before generating a reply.
- `PlanExecutor` runs the plan task-by-task with bounded retries, pluggable
  verification, and a strategy switch after repeated failures.
"""

from .executor import (
    ExecutionResult,
    LLMGradeVerifier,
    PlanExecutor,
    TaskAttempt,
    TaskResult,
    presence_verifier,
)
from .planner import Plan, PlanTask, Planner, plan_from_dict

__all__ = [
    "Plan",
    "PlanTask",
    "Planner",
    "plan_from_dict",
    "PlanExecutor",
    "TaskAttempt",
    "TaskResult",
    "ExecutionResult",
    "presence_verifier",
    "LLMGradeVerifier",
]
