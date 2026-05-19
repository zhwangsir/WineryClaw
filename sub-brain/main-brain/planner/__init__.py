"""Task decomposition (Planner) — M2.

Splits a complex user request into structured atomic subtasks so chat
can show the user "here's what I'm about to do" before generating a
reply. See `planner.Planner` for the public API.
"""

from .planner import Plan, PlanTask, Planner

__all__ = ["Plan", "PlanTask", "Planner"]
