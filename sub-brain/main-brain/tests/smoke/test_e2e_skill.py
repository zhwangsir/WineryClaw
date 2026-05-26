"""End-to-end skill execution smoke tests (Round C8, 2026-05-20).

Skills are user-defined JS / Python code that runs on demand in
isolated runtimes (M6a):
  - JS:     worker_threads with resourceLimits, params via structured clone
  - Python: child_process spawn + JSON-over-stdin

Different bug class than chat/dreaming/RAG/etc — those are
HTTP+config-wiring bugs. Skill execution bugs cluster in:
  - subprocess hang / timeout not enforced
  - output truncated / stderr lost / parse errors
  - isolation breach (skill reaches host fs / network)
  - return-value envelope shape drift
  - language detection wrong, dispatches to wrong runtime

This round probes the success path + each common failure mode.

Marker: `@pytest.mark.smoke`. Run with:
    pytest -m smoke tests/smoke/test_e2e_skill.py -s
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, Optional

import httpx
import pytest

pytestmark = pytest.mark.smoke


def _create_skill(
    sub_url: str, name: str, code: str, language: str,
    description: str = "", tags: Optional[list] = None,
) -> Dict[str, Any]:
    r = httpx.post(
        f"{sub_url}/skills",
        json={
            "name": name,
            "description": description or f"smoke skill {name}",
            "code": code,
            "language": language,
            "triggerPatterns": [],
            "tags": tags or ["smoke"],
        },
        timeout=10.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True, body
    return body["skill"]


def _invoke_skill(
    sub_url: str, skill_id: str, params: Dict[str, Any],
) -> Dict[str, Any]:
    r = httpx.post(
        f"{sub_url}/skills/{skill_id}/invoke",
        json={"params": params, "session_id": "skill-smoke"},
        timeout=60.0,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _delete_skill(sub_url: str, skill_id: str) -> None:
    try:
        httpx.delete(f"{sub_url}/skills/{skill_id}", timeout=5.0)
    except httpx.HTTPError:
        pass


def test_js_skill_simple_compute_returns_result(smoke_rig):
    """Keystone JS test: skill receives params, returns a computed value.

    The skill code is wrapped as a function body; `return value` is the
    final result. Params arrive via structured clone (NOT shell-quoted),
    so even special characters in values are safe.
    """
    sub_url = smoke_rig.sub_brain.base_url
    code = "return params.x * 2 + params.y;"
    skill = _create_skill(sub_url, f"js-double-{uuid.uuid4().hex[:6]}", code, "javascript")
    try:
        result = _invoke_skill(sub_url, skill["id"], {"x": 7, "y": 5})
        assert result.get("ok") is True, result
        # The skill manager wraps the runner's output as
        # { ok: true, result: { success: true, result: <value>, error: ... } }
        inner = result.get("result", {})
        assert inner.get("success") is True, inner
        assert inner.get("result") == 19, inner  # 7*2 + 5
    finally:
        _delete_skill(sub_url, skill["id"])


def test_js_skill_async_compute_supported(smoke_rig):
    """Skill body is wrapped in `(async () => { ... })()` so callers can
    `await` inside. Verifies the async wrapping is intact."""
    sub_url = smoke_rig.sub_brain.base_url
    code = """
const sum = await Promise.all([
  Promise.resolve(params.a),
  Promise.resolve(params.b),
]).then(([a, b]) => a + b);
return { sum, doubled: sum * 2 };
"""
    skill = _create_skill(sub_url, f"js-async-{uuid.uuid4().hex[:6]}", code, "javascript")
    try:
        result = _invoke_skill(sub_url, skill["id"], {"a": 10, "b": 20})
        inner = result.get("result", {})
        assert inner.get("success") is True, inner
        assert inner["result"] == {"sum": 30, "doubled": 60}, inner["result"]
    finally:
        _delete_skill(sub_url, skill["id"])


def test_js_skill_throw_returns_structured_failure(smoke_rig):
    """A skill that throws must return ok=true (HTTP-level) with
    inner success=false and an error message — NOT crash the process.

    Defends against the bug class: 'one bad user skill takes down
    the whole sub-brain process'.
    """
    sub_url = smoke_rig.sub_brain.base_url
    code = "throw new Error('intentional smoke failure');"
    skill = _create_skill(sub_url, f"js-throw-{uuid.uuid4().hex[:6]}", code, "javascript")
    try:
        result = _invoke_skill(sub_url, skill["id"], {})
        # HTTP-level success (the route caught it)
        assert result.get("ok") is True, result
        inner = result.get("result", {})
        # Inner failure
        assert inner.get("success") is False, inner
        err = inner.get("error") or ""
        assert "intentional smoke failure" in err or "smoke failure" in err, inner
    finally:
        _delete_skill(sub_url, skill["id"])


def test_python_skill_simple_compute_returns_result(smoke_rig):
    """Same as the JS test but for Python runtime.

    Round C9 harmonized the Python runtime with JS — skills can now
    use any of:
        print(value)          # legacy, returns the string
        result = value        # NEW: parity with JS `return value`
        set_result(value)     # NEW: explicit, keeps the print path free
    Each variant has its own dedicated test below.
    """
    sub_url = smoke_rig.sub_brain.base_url
    code = "print(params['x'] * 2 + params['y'])"
    skill = _create_skill(sub_url, f"py-double-{uuid.uuid4().hex[:6]}", code, "python")
    try:
        result = _invoke_skill(sub_url, skill["id"], {"x": 4, "y": 3})
        assert result.get("ok") is True, result
        inner = result.get("result", {})
        assert inner.get("success") is True, inner
        # Python stdout is a string — the manager doesn't JSON-parse it.
        assert inner.get("result") == "11", inner
    finally:
        _delete_skill(sub_url, skill["id"])


def test_python_skill_result_variable_returns_typed_value(smoke_rig):
    """Round C9: `result = value` returns the typed Python value
    (number, dict, list — not a string)."""
    sub_url = smoke_rig.sub_brain.base_url
    code = "result = {'sum': params['a'] + params['b'], 'tag': 'C9'}"
    skill = _create_skill(sub_url, f"py-result-{uuid.uuid4().hex[:6]}", code, "python")
    try:
        result = _invoke_skill(sub_url, skill["id"], {"a": 10, "b": 5})
        assert result.get("ok") is True, result
        inner = result.get("result", {})
        assert inner.get("success") is True, inner
        # Round-trips as a real dict, not a string
        assert inner.get("result") == {"sum": 15, "tag": "C9"}, inner


    finally:
        _delete_skill(sub_url, skill["id"])


def test_python_skill_set_result_api(smoke_rig):
    """Round C9: explicit `set_result(value)` works alongside print() —
    useful when the skill wants debug output AND a structured result."""
    sub_url = smoke_rig.sub_brain.base_url
    code = """print('progress: starting')
print('progress: midpoint')
set_result(['done', params['marker']])"""
    skill = _create_skill(sub_url, f"py-setres-{uuid.uuid4().hex[:6]}", code, "python")
    try:
        result = _invoke_skill(sub_url, skill["id"], {"marker": "C9-smoke"})
        assert result.get("ok") is True, result
        inner = result.get("result", {})
        assert inner.get("success") is True, inner
        # Debug prints are dropped from the result envelope; only the
        # structured set_result payload remains
        assert inner.get("result") == ["done", "C9-smoke"], inner
    finally:
        _delete_skill(sub_url, skill["id"])


def test_python_skill_traceback_surfaces_in_error(smoke_rig):
    """A Python skill that raises must surface the traceback as the
    error message — NOT just 'python exited with code 1'. Defends
    debugging UX for skill authors."""
    sub_url = smoke_rig.sub_brain.base_url
    code = "raise ValueError('intentional smoke traceback')"
    skill = _create_skill(sub_url, f"py-throw-{uuid.uuid4().hex[:6]}", code, "python")
    try:
        result = _invoke_skill(sub_url, skill["id"], {})
        assert result.get("ok") is True, result
        inner = result.get("result", {})
        assert inner.get("success") is False, inner
        err = inner.get("error") or ""
        assert "intentional smoke traceback" in err or "ValueError" in err, inner
    finally:
        _delete_skill(sub_url, skill["id"])


def test_invoke_unknown_skill_returns_structured_error(smoke_rig):
    """Invoking a non-existent skill must return 200 + ok=false, not 500."""
    sub_url = smoke_rig.sub_brain.base_url
    fake = f"skill-does-not-exist-{uuid.uuid4().hex}"
    r = httpx.post(
        f"{sub_url}/skills/{fake}/invoke",
        json={"params": {}, "session_id": "smoke"},
        timeout=10.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is False, body
    err = (body.get("error") or "").lower()
    assert "not found" in err or fake in err, body


def test_skill_listed_after_creation_and_gone_after_delete(smoke_rig):
    """CRUD invariant: create → appears in /skills, delete → vanishes."""
    sub_url = smoke_rig.sub_brain.base_url
    code = "return 'hello';"
    skill = _create_skill(sub_url, f"crud-{uuid.uuid4().hex[:6]}", code, "javascript")
    skill_id = skill["id"]
    try:
        # After create, listed
        r = httpx.get(f"{sub_url}/skills", timeout=5.0)
        assert r.status_code == 200, r.text
        skills = r.json().get("skills", [])
        ids = {s.get("id") for s in skills}
        assert skill_id in ids, f"created skill {skill_id} not in list: {len(ids)} skills"
    finally:
        _delete_skill(sub_url, skill_id)

    # After delete, gone (or marked deleted — accept either)
    r = httpx.get(f"{sub_url}/skills/{skill_id}", timeout=5.0)
    assert r.status_code == 200, r.text
    body = r.json()
    # Either ok=false ("not found") or ok=true with explicit deleted flag
    if body.get("ok") is True:
        # Some implementations soft-delete; accept that too
        assert body.get("skill", {}).get("deleted") in (True, 1) or \
               body.get("skill") is None, body


def test_skill_params_with_special_characters_dont_break_runner(smoke_rig):
    """Round C4 caught a proxy bug from header stripping; this defends
    a related class: skill params with shell-special chars must NOT
    be shell-quoted (M6a fixed this; structured clone for JS, JSON
    stdin for Python). If the runner regressed to shell interpolation,
    a value containing 'rm -rf' would either crash or, worse, execute."""
    sub_url = smoke_rig.sub_brain.base_url
    code = "return { received: params.payload, len: params.payload.length };"
    skill = _create_skill(sub_url, f"js-shell-{uuid.uuid4().hex[:6]}", code, "javascript")
    try:
        # Construct a payload that would be catastrophic if interpolated
        # into a shell. Pure data — the worker should echo it back exactly.
        dangerous = "'; rm -rf / # `cat /etc/passwd` $(echo pwned)"
        result = _invoke_skill(sub_url, skill["id"], {"payload": dangerous})
        inner = result.get("result", {})
        assert inner.get("success") is True, inner
        echoed = inner["result"]
        assert echoed["received"] == dangerous, echoed
        assert echoed["len"] == len(dangerous), echoed
    finally:
        _delete_skill(sub_url, skill["id"])
