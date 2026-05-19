"""Tests for SkillReflector — the Phase 5b self-improvement loop entry point."""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List

import pytest

# Make the main-brain package importable when running from its root.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from evolution.skill_reflector import Reflection, SkillReflector  # noqa: E402


def make_skill(**overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        "id": "skill-test",
        "name": "Test Skill",
        "language": "javascript",
        "code": "throw new Error('current broken behavior')",
        "usageCount": 20,
        "successRate": 0.4,
        "failureModes": [
            {
                "signature": "TypeError: cannot read property",
                "count": 7,
                "lastSeen": "2026-05-13T00:00:00.000Z",
                "examples": ["TypeError: cannot read property 'x' of undefined"],
            },
            {
                "signature": "ENOENT",
                "count": 2,
                "lastSeen": "2026-05-13T00:00:00.000Z",
                "examples": ["ENOENT: no such file"],
            },
        ],
    }
    base.update(overrides)
    return base


def make_llm(canned_response: str):
    """Build a fake llm_call that records messages it received."""

    captured: List[List[Dict[str, str]]] = []

    async def fake(messages: List[Dict[str, str]], **kwargs: Any) -> str:
        captured.append(messages)
        return canned_response

    fake.captured = captured  # type: ignore[attr-defined]
    return fake


@pytest.mark.asyncio
async def test_reflect_returns_reflection_on_clean_json():
    llm = make_llm('{"improved_code": "console.log(\\"fixed\\")", "reason": "guard undefined"}')
    r = SkillReflector(llm)

    result = await r.reflect_on_skill(make_skill())

    assert isinstance(result, Reflection)
    assert result.improved_code == 'console.log("fixed")'
    assert "guard undefined" in result.reason


@pytest.mark.asyncio
async def test_reflect_handles_fenced_json_block():
    fenced = '```json\n{"improved_code": "fixed", "reason": "ok"}\n```'
    r = SkillReflector(make_llm(fenced))

    result = await r.reflect_on_skill(make_skill())

    assert result is not None
    assert result.improved_code == "fixed"


@pytest.mark.asyncio
async def test_reflect_handles_trailing_prose():
    sloppy = 'Sure, here you go: {"improved_code": "yes", "reason": "added null check"} \nLet me know if you want more.'
    r = SkillReflector(make_llm(sloppy))

    result = await r.reflect_on_skill(make_skill())

    assert result is not None
    assert result.improved_code == "yes"


@pytest.mark.asyncio
async def test_reflect_returns_none_when_llm_proposes_empty_code():
    llm = make_llm('{"improved_code": "", "reason": "no improvement"}')
    r = SkillReflector(llm)

    result = await r.reflect_on_skill(make_skill())

    assert result is None


@pytest.mark.asyncio
async def test_reflect_returns_none_when_llm_proposes_identical_code():
    current = "throw new Error('current broken behavior')"
    llm = make_llm(f'{{"improved_code": "{current}", "reason": "same"}}')
    r = SkillReflector(llm)

    result = await r.reflect_on_skill(make_skill(code=current))

    assert result is None


@pytest.mark.asyncio
async def test_reflect_returns_none_on_unparseable_response():
    llm = make_llm("this is not json at all")
    r = SkillReflector(llm)

    result = await r.reflect_on_skill(make_skill())

    assert result is None


@pytest.mark.asyncio
async def test_reflect_skips_when_no_failure_modes():
    llm = make_llm('{"improved_code": "x", "reason": "y"}')
    r = SkillReflector(llm)

    result = await r.reflect_on_skill(make_skill(failureModes=[]))

    assert result is None
    # LLM should NOT have been called when there's nothing to reflect on.
    assert llm.captured == []  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_reflect_skips_when_skill_has_no_code():
    llm = make_llm('{"improved_code": "x", "reason": "y"}')
    r = SkillReflector(llm)

    result = await r.reflect_on_skill(make_skill(code=""))

    assert result is None
    assert llm.captured == []  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_prompt_lists_failure_modes_by_count_desc():
    llm = make_llm('{"improved_code": "fixed", "reason": "ok"}')
    r = SkillReflector(llm)

    await r.reflect_on_skill(make_skill())

    assert llm.captured  # type: ignore[attr-defined]
    user_content = llm.captured[0][1]["content"]  # type: ignore[attr-defined]
    idx_type = user_content.find("TypeError")
    idx_enoent = user_content.find("ENOENT")
    assert idx_type >= 0 and idx_enoent >= 0
    assert idx_type < idx_enoent


@pytest.mark.asyncio
async def test_prompt_caps_examples_per_mode():
    llm = make_llm('{"improved_code": "fixed", "reason": "ok"}')
    r = SkillReflector(llm, max_examples_per_mode=1)

    skill = make_skill(
        failureModes=[
            {
                "signature": "X",
                "count": 5,
                "lastSeen": "2026-05-13T00:00:00.000Z",
                "examples": ["e1", "e2", "e3", "e4"],
            }
        ]
    )

    await r.reflect_on_skill(skill)

    user_content = llm.captured[0][1]["content"]  # type: ignore[attr-defined]
    assert "e1" in user_content
    assert "e2" not in user_content
    assert "e4" not in user_content
