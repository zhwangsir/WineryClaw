"""Tests for the skill improvement cycle and the LLM client factory."""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from evolution.llm_client import make_llm_call_from_config  # noqa: E402
from evolution.skill_improvement_cycle import (  # noqa: E402
    CycleReport,
    SkillImprovementCycle,
)
from evolution.skill_reflector import Reflection, SkillReflector  # noqa: E402


# -----------------------------------------------------------------------------
# Shared HTTP fake — mimics enough of httpx.AsyncClient for these tests.
# -----------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, json_data: Any, status: int = 200):
        self._json = json_data
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"status {self.status_code}", request=None, response=None  # type: ignore[arg-type]
            )

    def json(self) -> Any:
        return self._json


class _FakeAsyncClient:
    """Records GET/POST calls and returns canned responses keyed by URL."""

    def __init__(
        self,
        get_responses: Dict[str, Any] = None,
        post_responses: Dict[str, Any] = None,
        timeout: Any = None,
    ):
        self._get_responses = get_responses or {}
        self._post_responses = post_responses or {}
        self.gets: List[Dict[str, Any]] = []
        self.posts: List[Dict[str, Any]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url: str, **kwargs: Any):
        self.gets.append({"url": url, "kwargs": kwargs})
        body = self._get_responses.get(url)
        if body is None:
            return _FakeResponse({}, status=404)
        return _FakeResponse(body)

    async def post(self, url: str, json: Any = None, headers: Any = None, **kwargs: Any):
        self.posts.append({"url": url, "json": json, "headers": headers})
        body = self._post_responses.get(url)
        if body is None:
            return _FakeResponse({"ok": False, "error": "not mocked"}, status=200)
        return _FakeResponse(body)


def install_fake_client(monkeypatch, fake: _FakeAsyncClient) -> None:
    """Make httpx.AsyncClient(...) return our `fake` regardless of args."""

    def _factory(*args: Any, **kwargs: Any) -> _FakeAsyncClient:
        return fake

    monkeypatch.setattr(httpx, "AsyncClient", _factory)


# =============================================================================
# llm_client factory
# =============================================================================

class TestLLMClientFactory:
    @pytest.mark.asyncio
    async def test_posts_to_base_url_chat_completions(self, monkeypatch):
        fake = _FakeAsyncClient(
            post_responses={
                "http://test.local/v1/chat/completions": {
                    "choices": [{"message": {"content": "hello world"}}]
                }
            }
        )
        install_fake_client(monkeypatch, fake)

        call = make_llm_call_from_config(
            {"base_url": "http://test.local/v1", "model_id": "qwen-test"}
        )
        out = await call([{"role": "user", "content": "hi"}])

        assert out == "hello world"
        assert len(fake.posts) == 1
        payload = fake.posts[0]["json"]
        assert payload["model"] == "qwen-test"
        assert payload["messages"] == [{"role": "user", "content": "hi"}]
        assert payload["stream"] is False

    @pytest.mark.asyncio
    async def test_includes_authorization_when_api_key_set(self, monkeypatch):
        fake = _FakeAsyncClient(
            post_responses={
                "http://test.local/v1/chat/completions": {
                    "choices": [{"message": {"content": "x"}}]
                }
            }
        )
        install_fake_client(monkeypatch, fake)

        call = make_llm_call_from_config(
            {"base_url": "http://test.local/v1", "model_id": "m", "api_key": "secret-123"}
        )
        await call([{"role": "user", "content": "hi"}])

        assert fake.posts[0]["headers"].get("Authorization") == "Bearer secret-123"

    @pytest.mark.asyncio
    async def test_omits_authorization_when_no_api_key(self, monkeypatch):
        fake = _FakeAsyncClient(
            post_responses={
                "http://test.local/v1/chat/completions": {
                    "choices": [{"message": {"content": "x"}}]
                }
            }
        )
        install_fake_client(monkeypatch, fake)

        call = make_llm_call_from_config({"base_url": "http://test.local/v1", "model_id": "m"})
        await call([{"role": "user", "content": "hi"}])

        assert "Authorization" not in (fake.posts[0]["headers"] or {})

    @pytest.mark.asyncio
    async def test_env_var_fallback_used_when_config_missing(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_LLM_BASE_URL", "http://env-fallback.local/v1")
        monkeypatch.setenv("WEBRAIN_LLM_MODEL", "env-model")

        fake = _FakeAsyncClient(
            post_responses={
                "http://env-fallback.local/v1/chat/completions": {
                    "choices": [{"message": {"content": "ok"}}]
                }
            }
        )
        install_fake_client(monkeypatch, fake)

        call = make_llm_call_from_config()  # no config dict
        out = await call([{"role": "user", "content": "hi"}])

        assert out == "ok"
        assert fake.posts[0]["url"] == "http://env-fallback.local/v1/chat/completions"
        assert fake.posts[0]["json"]["model"] == "env-model"

    @pytest.mark.asyncio
    async def test_returns_empty_string_on_malformed_response(self, monkeypatch):
        fake = _FakeAsyncClient(
            post_responses={"http://test.local/v1/chat/completions": {"unexpected": True}}
        )
        install_fake_client(monkeypatch, fake)

        call = make_llm_call_from_config({"base_url": "http://test.local/v1", "model_id": "m"})
        out = await call([{"role": "user", "content": "hi"}])

        assert out == ""


# =============================================================================
# SkillImprovementCycle
# =============================================================================

def _fake_reflector(canned_response: str) -> SkillReflector:
    async def fake_llm(messages, **kwargs):
        return canned_response
    return SkillReflector(fake_llm)


def _candidates_response(skills: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "candidates": [
            {
                "skill": s,
                "primaryFailureMode": (s.get("failureModes") or [{}])[0],
                "reason": "test",
            }
            for s in skills
        ]
    }


def _skill(id_: str, **extras: Any) -> Dict[str, Any]:
    base = {
        "id": id_,
        "name": id_,
        "language": "javascript",
        "code": "throw new Error('broken')",
        "usageCount": 20,
        "successRate": 0.3,
        "failureModes": [
            {
                "signature": "X",
                "count": 7,
                "lastSeen": "2026-05-14T00:00:00.000Z",
                "examples": ["X"],
            }
        ],
    }
    base.update(extras)
    return base


class TestSkillImprovementCycle:
    @pytest.mark.asyncio
    async def test_no_candidates_returns_zero(self, monkeypatch):
        fake = _FakeAsyncClient(
            get_responses={"http://localhost:3000/api/skillhub/candidates": {"candidates": []}},
        )
        install_fake_client(monkeypatch, fake)

        cycle = SkillImprovementCycle(_fake_reflector("not-called"))
        report = await cycle.run_once()

        assert report.checked == 0
        assert report.improved == 0
        assert report.skipped == 0
        assert report.errors == []

    @pytest.mark.asyncio
    async def test_one_candidate_one_improvement_posted(self, monkeypatch):
        improved_code = "console.log('fixed')"
        fake = _FakeAsyncClient(
            get_responses={
                "http://localhost:3000/api/skillhub/candidates": _candidates_response(
                    [_skill("skill-a")]
                ),
            },
            post_responses={
                "http://localhost:3000/api/skillhub/improve": {"ok": True, "fork": {"id": "skill-a-improved-v2"}},
            },
        )
        install_fake_client(monkeypatch, fake)

        reflector = _fake_reflector(
            f'{{"improved_code": {improved_code!r}, "reason": "guard"}}'
        )
        cycle = SkillImprovementCycle(reflector)
        report = await cycle.run_once()

        assert report.checked == 1
        assert report.improved == 1
        assert report.skipped == 0
        assert report.errors == []
        # Verify the improve POST payload
        assert len(fake.posts) == 1
        sent = fake.posts[0]["json"]
        assert sent["skillId"] == "skill-a"
        assert sent["code"] == improved_code
        assert sent["reason"] == "guard"

    @pytest.mark.asyncio
    async def test_candidate_reflection_returns_none_is_skipped(self, monkeypatch):
        fake = _FakeAsyncClient(
            get_responses={
                "http://localhost:3000/api/skillhub/candidates": _candidates_response(
                    [_skill("skill-a")]
                ),
            },
        )
        install_fake_client(monkeypatch, fake)

        # Reflector that always returns None (no useful improvement).
        async def reflect_none(messages, **kwargs):
            return '{"improved_code": "", "reason": "no improvement"}'
        cycle = SkillImprovementCycle(SkillReflector(reflect_none))

        report = await cycle.run_once()

        assert report.checked == 1
        assert report.improved == 0
        assert report.skipped == 1
        assert fake.posts == []  # nothing should be posted

    @pytest.mark.asyncio
    async def test_one_failure_does_not_stop_remaining(self, monkeypatch):
        # First skill -> LLM throws; second skill -> succeeds.
        call_count = {"n": 0}

        async def flaky_llm(messages, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("LLM gateway down")
            return '{"improved_code": "fixed", "reason": "ok"}'

        fake = _FakeAsyncClient(
            get_responses={
                "http://localhost:3000/api/skillhub/candidates": _candidates_response(
                    [_skill("skill-a"), _skill("skill-b")]
                ),
            },
            post_responses={
                "http://localhost:3000/api/skillhub/improve": {"ok": True},
            },
        )
        install_fake_client(monkeypatch, fake)

        cycle = SkillImprovementCycle(SkillReflector(flaky_llm))
        report = await cycle.run_once()

        assert report.checked == 2
        assert report.improved == 1
        # First candidate either skipped (LLM exception swallowed) or surfaced as
        # an error — either way, the second candidate must succeed.
        assert (report.skipped + len(report.errors)) >= 1

    @pytest.mark.asyncio
    async def test_improve_endpoint_returning_ok_false_is_recorded_as_error(self, monkeypatch):
        fake = _FakeAsyncClient(
            get_responses={
                "http://localhost:3000/api/skillhub/candidates": _candidates_response(
                    [_skill("skill-a")]
                ),
            },
            post_responses={
                "http://localhost:3000/api/skillhub/improve": {"ok": False, "error": "not found"},
            },
        )
        install_fake_client(monkeypatch, fake)

        reflector = _fake_reflector('{"improved_code": "x", "reason": "y"}')
        cycle = SkillImprovementCycle(reflector)
        report = await cycle.run_once()

        assert report.checked == 1
        assert report.improved == 0
        assert len(report.errors) == 1
        assert "skill-a" in report.errors[0]

    @pytest.mark.asyncio
    async def test_sub_brain_url_env_override(self, monkeypatch):
        monkeypatch.setenv("WEBRAIN_SUB_BRAIN_URL", "http://other:9999")
        fake = _FakeAsyncClient(
            get_responses={"http://other:9999/api/skillhub/candidates": {"candidates": []}},
        )
        install_fake_client(monkeypatch, fake)

        cycle = SkillImprovementCycle(_fake_reflector("not-called"))
        report = await cycle.run_once()

        assert report.checked == 0
        assert fake.gets[0]["url"] == "http://other:9999/api/skillhub/candidates"

    def test_cycle_report_to_dict(self):
        r = CycleReport(checked=5, improved=3, skipped=1, errors=["x: boom"])
        d = r.to_dict()
        assert d == {"checked": 5, "improved": 3, "skipped": 1, "errors": ["x: boom"]}
