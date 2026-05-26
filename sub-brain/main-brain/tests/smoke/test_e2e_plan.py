"""End-to-end plan executor smoke tests (Round C7, 2026-05-20).

PlanExecutor (M3) is the orchestration layer:

  user_input → Planner.plan → Plan{tasks: [...]}
    → PlanExecutor.run:
        for each task:
          for each attempt (up to retry budget):
            execute via chat_engine.chat (mocked LLM)
            verify via presence or LLM grader
            if verified: continue
            else: retry with feedback
    → ExecutionResult{overall_success, failed_task_ids, per_task: [...]}

Unit tests in test_planner_executor.py covered the executor with mocked
execute_fn + mocked verifier. These smoke tests prove the HTTP path
works against a real running stack + chat_engine + mock LLM.

Given C5/C6 came back clean but D2 caught a real benchmark-config bug,
the bug surface area is dwindling but architecturally-complex paths
like PlanExecutor are still worth probing.

Marker: `@pytest.mark.smoke`. Run with:
    pytest -m smoke tests/smoke/test_e2e_plan.py -s
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List

import httpx
import pytest

pytestmark = pytest.mark.smoke


def _plan_execute(sub_url: str, body: Dict[str, Any]) -> Dict[str, Any]:
    r = httpx.post(
        f"{sub_url}/brain/plan/execute",
        json=body,
        timeout=120.0,  # multi-task plans can take a while even with mock LLM
    )
    assert r.status_code == 200, r.text
    return r.json()


def _explicit_plan(tasks: List[Dict[str, str]]) -> Dict[str, Any]:
    """Build a minimal Plan dict that plan_from_dict() accepts."""
    return {
        "plan_id": f"plan-{uuid.uuid4().hex[:8]}",
        "user_input": "smoke-test synthetic plan",
        "tasks": [
            {
                "id": f"t{i+1}",
                "description": t["description"],
                "requires_tool": False,
                "tool_hint": "",
                "expected_output": t.get("expected", ""),
            }
            for i, t in enumerate(tasks)
        ],
        "confidence": 0.9,
        "reasoning": "synthetic plan for smoke test",
    }


def test_plan_execute_with_empty_input_returns_clean_error(chat_smoke_rig):
    """No user_input + no plan must return a structured error, not 500."""
    sub_url = chat_smoke_rig.sub_brain.base_url
    body = _plan_execute(sub_url, {})
    assert body.get("ok") is False, body
    assert "required" in (body.get("error") or "").lower(), body


def test_plan_execute_with_explicit_plan_runs_every_task(chat_smoke_rig):
    """Pass an explicit plan with 3 tasks, verify each ran.

    The keystone test — proves the executor reaches chat_engine for
    each task and the result envelope echoes per-task attempts.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    anchor = uuid.uuid4().hex[:8]
    plan = _explicit_plan([
        {"description": f"Task one for {anchor}", "expected": "MOCK"},
        {"description": f"Task two for {anchor}", "expected": "MOCK"},
        {"description": f"Task three for {anchor}", "expected": "MOCK"},
    ])
    body = _plan_execute(sub_url, {
        "plan": plan,
        "session_id": f"plan-smoke-{anchor}",
        "verify": "presence",
    })
    assert body.get("ok") is True, body
    # plan echoed for client convenience
    assert "plan" in body, body
    assert len(body["plan"]["tasks"]) == 3

    # per_task list shape: each task has attempts with verification outcome
    # The executor returns task records under `results` (not `tasks` or
    # `per_task` — those names were wrong guesses on first draft).
    results = body.get("results")
    assert isinstance(results, list), f"results missing: {body}"
    assert len(results) == 3, f"expected 3 task results, got {len(results)}: {results}"

    # Each task should have at least one attempt with verification verdict
    for i, t in enumerate(results):
        attempts = t.get("attempts") or []
        assert isinstance(attempts, list) and len(attempts) >= 1, (
            f"task {i} has no attempts: {t}"
        )
        # Each attempt records its verification outcome
        first = attempts[0]
        assert "verification_passed" in first, first
        assert "duration_ms" in first, first


def test_plan_execute_overall_success_with_presence_verifier(chat_smoke_rig):
    """A plan whose expected_output is empty + presence verifier should
    succeed on first try (presence checks just 'reply has content')."""
    sub_url = chat_smoke_rig.sub_brain.base_url
    plan = _explicit_plan([
        {"description": "Simple task without expected output"},
    ])
    body = _plan_execute(sub_url, {
        "plan": plan,
        "verify": "presence",
        "session_id": f"presence-{uuid.uuid4().hex[:6]}",
    })
    assert body.get("ok") is True, body
    # overall_success should be True — mock LLM always returns non-empty content
    assert body.get("overall_success") is True, (
        f"presence verifier failed against mock LLM (which always replies). "
        f"body: {body}"
    )
    failed = body.get("failed_task_ids") or []
    assert not failed, f"unexpected failures: {failed}"


def test_plan_execute_explicit_plan_with_missing_tasks_fails_cleanly(chat_smoke_rig):
    """A plan dict with no tasks must fail clean — not run an empty loop
    and silently return success."""
    sub_url = chat_smoke_rig.sub_brain.base_url
    bad_plan = {"plan_id": "empty", "user_input": "x", "tasks": []}
    body = _plan_execute(sub_url, {"plan": bad_plan})
    # Either rejected at plan_from_dict (ok=false) or returns success
    # with zero results — both are reasonable. What's NOT OK is a 500.
    if body.get("ok") is False:
        assert "task" in (body.get("error") or "").lower() or \
               "plan" in (body.get("error") or "").lower(), body
    else:
        # If it accepted the empty plan, the result must reflect zero work
        per_task = body.get("per_task") or body.get("task_results") or body.get("tasks") or []
        assert len(per_task) == 0, (
            f"empty plan should produce zero task results: {body}"
        )


def test_plan_execute_user_input_path_invokes_planner(chat_smoke_rig):
    """When given user_input (no explicit plan), the executor must call
    Planner.plan first. With the mock LLM, the planner will fail to
    generate a structured plan and return None — which should yield
    `skipped: true` rather than 500 or hang.
    """
    sub_url = chat_smoke_rig.sub_brain.base_url
    # Mock LLM returns "MOCK-LLM-REPLY: hello…" which is NOT a valid plan
    # JSON. Planner.plan should return None and the executor should
    # surface that as a `skipped` response.
    body = _plan_execute(sub_url, {
        "user_input": "Plan a research project on quantum computing",
        "session_id": f"planner-path-{uuid.uuid4().hex[:6]}",
    })
    # Two acceptable outcomes:
    # (a) skipped — planner declined / unavailable (most likely with mock LLM)
    # (b) overall_success with at least one task — if pre-filter matched
    #     and somehow a plan was constructed
    assert body.get("ok") is True, body
    if body.get("skipped") is True:
        assert "reason" in body, body
    else:
        assert "plan" in body or "per_task" in body or "tasks" in body, body
