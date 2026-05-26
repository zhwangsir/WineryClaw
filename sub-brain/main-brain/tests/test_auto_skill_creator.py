"""Tests for AutoSkillCreator."""

from dataclasses import dataclass
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from evolution.auto_skill_creator import AutoSkillCreator, SkillDraft, _extract_json
from planner.planner import Plan, PlanTask
from planner.executor import ExecutionResult


class TestExtractJson:
    def test_bare_json(self):
        assert _extract_json('{"a": 1}') == {"a": 1}

    def test_fenced_json(self):
        assert _extract_json("```json\n{\"a\": 1}\n```") == {"a": 1}

    def test_plain_fenced(self):
        assert _extract_json("```\n{\"a\": 1}\n```") == {"a": 1}

    def test_invalid_returns_none(self):
        assert _extract_json("not json") is None

    def test_empty_returns_none(self):
        assert _extract_json("") is None


class TestShouldCreateSkill:
    @pytest.fixture
    def creator(self):
        return AutoSkillCreator(llm_config={"base_url": "http://test", "model_id": "m"})

    @pytest.mark.asyncio
    async def test_empty_input_returns_false(self, creator):
        plan = Plan(plan_id="p1", user_input="", tasks=[])
        assert await creator.should_create_skill("", plan) is False

    @pytest.mark.asyncio
    async def test_no_skills_and_no_tasks_returns_false(self, creator):
        with patch.object(creator, "_fetch_skills", new_callable=AsyncMock, return_value=[]):
            plan = Plan(plan_id="p1", user_input="hello", tasks=[])
            assert await creator.should_create_skill("hello", plan) is False

    @pytest.mark.asyncio
    async def test_no_skills_with_tasks_returns_true(self, creator):
        with patch.object(creator, "_fetch_skills", new_callable=AsyncMock, return_value=[]):
            plan = Plan(
                plan_id="p1",
                user_input="hello",
                tasks=[PlanTask(id="t1", description="do thing", requires_tool=True, tool_hint="shell")],
            )
            assert await creator.should_create_skill("hello", plan) is True

    @pytest.mark.asyncio
    async def test_matching_trigger_pattern_returns_false(self, creator):
        skills = [
            {
                "id": "s1",
                "triggerPatterns": ["hello"],
                "code": "",
            }
        ]
        with patch.object(creator, "_fetch_skills", new_callable=AsyncMock, return_value=skills):
            plan = Plan(
                plan_id="p1",
                user_input="hello world",
                tasks=[PlanTask(id="t1", description="do thing", requires_tool=True, tool_hint="shell")],
            )
            assert await creator.should_create_skill("hello world", plan) is False

    @pytest.mark.asyncio
    async def test_novel_tool_returns_true(self, creator):
        skills = [
            {
                "id": "s1",
                "triggerPatterns": ["bye"],
                "code": "shell",
            }
        ]
        with patch.object(creator, "_fetch_skills", new_callable=AsyncMock, return_value=skills):
            plan = Plan(
                plan_id="p1",
                user_input="hello world",
                tasks=[PlanTask(id="t1", description="do thing", requires_tool=True, tool_hint="novel_tool")],
            )
            assert await creator.should_create_skill("hello world", plan) is True

    @pytest.mark.asyncio
    async def test_existing_tool_in_code_returns_false(self, creator):
        skills = [
            {
                "id": "s1",
                "triggerPatterns": ["bye"],
                "code": "novel_tool",
            }
        ]
        with patch.object(creator, "_fetch_skills", new_callable=AsyncMock, return_value=skills):
            plan = Plan(
                plan_id="p1",
                user_input="hello world",
                tasks=[PlanTask(id="t1", description="do thing", requires_tool=True, tool_hint="novel_tool")],
            )
            assert await creator.should_create_skill("hello world", plan) is False


class TestCreateSkillDraft:
    @pytest.fixture
    def creator(self):
        return AutoSkillCreator(llm_config={"base_url": "http://test", "model_id": "m"})

    @pytest.mark.asyncio
    async def test_valid_json_returns_draft(self, creator):
        llm_response = (
            "```json\n"
            '{"name": "TestSkill", "description": "A test skill", "triggerPatterns": ["test"], '
            '"code": "return 42;", "language": "javascript", "tags": ["auto"]}'
            "\n```"
        )
        with patch.object(creator, "_call_llm", new_callable=AsyncMock, return_value=llm_response):
            plan = Plan(plan_id="p1", user_input="test", tasks=[])
            exec_result = ExecutionResult(
                plan_id="p1", results=[], total_attempts=1, overall_success=True, failed_task_ids=[]
            )
            draft = await creator.create_skill_draft("test", plan, exec_result)
            assert draft is not None
            assert draft.name == "TestSkill"
            assert draft.code == "return 42;"
            assert draft.language == "javascript"
            assert draft.triggerPatterns == ["test"]
            assert draft.tags == ["auto"]

    @pytest.mark.asyncio
    async def test_llm_exception_returns_none(self, creator):
        with patch.object(creator, "_call_llm", new_callable=AsyncMock, side_effect=RuntimeError("boom")):
            plan = Plan(plan_id="p1", user_input="test", tasks=[])
            exec_result = ExecutionResult(
                plan_id="p1", results=[], total_attempts=1, overall_success=True, failed_task_ids=[]
            )
            draft = await creator.create_skill_draft("test", plan, exec_result)
            assert draft is None

    @pytest.mark.asyncio
    async def test_non_json_returns_none(self, creator):
        with patch.object(creator, "_call_llm", new_callable=AsyncMock, return_value="not json"):
            plan = Plan(plan_id="p1", user_input="test", tasks=[])
            exec_result = ExecutionResult(
                plan_id="p1", results=[], total_attempts=1, overall_success=True, failed_task_ids=[]
            )
            draft = await creator.create_skill_draft("test", plan, exec_result)
            assert draft is None

    @pytest.mark.asyncio
    async def test_empty_name_returns_none(self, creator):
        with patch.object(
            creator, "_call_llm", new_callable=AsyncMock, return_value='{"name": "", "code": "x"}'
        ):
            plan = Plan(plan_id="p1", user_input="test", tasks=[])
            exec_result = ExecutionResult(
                plan_id="p1", results=[], total_attempts=1, overall_success=True, failed_task_ids=[]
            )
            draft = await creator.create_skill_draft("test", plan, exec_result)
            assert draft is None

    @pytest.mark.asyncio
    async def test_empty_code_returns_none(self, creator):
        with patch.object(
            creator, "_call_llm", new_callable=AsyncMock, return_value='{"name": "X", "code": ""}'
        ):
            plan = Plan(plan_id="p1", user_input="test", tasks=[])
            exec_result = ExecutionResult(
                plan_id="p1", results=[], total_attempts=1, overall_success=True, failed_task_ids=[]
            )
            draft = await creator.create_skill_draft("test", plan, exec_result)
            assert draft is None


class TestSubmitDraft:
    @pytest.fixture
    def creator(self):
        return AutoSkillCreator(llm_config={})

    @pytest.mark.asyncio
    async def test_successful_post(self, creator):
        draft = SkillDraft(
            id="d1", name="N", description="D", triggerPatterns=["t"], code="c", language="javascript", tags=[]
        )
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json = MagicMock(return_value={"ok": True, "skill": {"id": "d1"}})
        mock_resp.raise_for_status = MagicMock()

        with patch.object(creator, "_get_client", return_value=MagicMock(post=AsyncMock(return_value=mock_resp))):
            result = await creator.submit_draft(draft)
            assert result["ok"] is True
            assert result["skill_id"] == "d1"

    @pytest.mark.asyncio
    async def test_failed_post_returns_error(self, creator):
        draft = SkillDraft(
            id="d1", name="N", description="D", triggerPatterns=["t"], code="c", language="javascript", tags=[]
        )
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json = MagicMock(return_value={"ok": False, "error": "bad request"})
        mock_resp.raise_for_status = MagicMock()

        with patch.object(creator, "_get_client", return_value=MagicMock(post=AsyncMock(return_value=mock_resp))):
            result = await creator.submit_draft(draft)
            assert result["ok"] is False
            assert "bad request" in result["error"]

    @pytest.mark.asyncio
    async def test_network_error_returns_error(self, creator):
        draft = SkillDraft(
            id="d1", name="N", description="D", triggerPatterns=["t"], code="c", language="javascript", tags=[]
        )

        with patch.object(
            creator, "_get_client", return_value=MagicMock(post=AsyncMock(side_effect=httpx.ConnectError("nope")))
        ):
            result = await creator.submit_draft(draft)
            assert result["ok"] is False
            assert "nope" in result["error"]


class TestChatEngineIntegration:
    @pytest.fixture
    def mock_memory(self):
        mm = MagicMock()
        mm.query = AsyncMock(return_value=[])
        mm.store = AsyncMock(return_value={"id": "m1"})
        return mm

    @pytest.fixture
    def mock_subbrain(self):
        sb = MagicMock()
        sb.execute_tool = AsyncMock(return_value="tool result")
        return sb

    @pytest.fixture
    def mock_llm_config(self):
        return {"base_url": "http://localhost:99999/v1", "model_id": "test-model"}

    @pytest.fixture
    def chat(self, mock_memory, mock_subbrain, mock_llm_config):
        from chat.chat_engine import ChatEngine
        engine = ChatEngine(
            memory_manager=mock_memory,
            sub_brain_client=mock_subbrain,
            llm_config=mock_llm_config,
        )
        engine.hyde_enabled = False
        engine.reflection_enabled = False
        engine.working_memory_enabled = False
        return engine

    @pytest.mark.asyncio
    async def test_chat_triggers_auto_skill_after_success(self, chat, mock_llm_config):
        from evolution.auto_skill_creator import AutoSkillCreator
        creator = AutoSkillCreator(llm_config=mock_llm_config)
        chat.auto_skill_creator = creator

        resp = {
            "choices": [{
                "message": {"role": "assistant", "content": "Done!"},
                "finish_reason": "stop",
            }]
        }

        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value.raise_for_status = MagicMock()
            mock_post.return_value.json = MagicMock(return_value=resp)
            # Mock planner to return a plan
            plan_dict = {
                "plan_id": "p1",
                "user_input": "test",
                "tasks": [{"id": "t1", "description": "step", "requires_tool": True, "tool_hint": "shell"}],
                "confidence": 0.8,
                "reasoning": "r",
            }
            with patch.object(chat, "_make_plan", new_callable=AsyncMock, return_value=plan_dict):
                with patch.object(creator, "should_create_skill", new_callable=AsyncMock, return_value=True):
                    with patch.object(creator, "create_skill_draft", new_callable=AsyncMock, return_value=None):
                        result = await chat.chat("test", "sess-1")
                        # Fire-and-forget task may still be running; give it a tick
                        await AsyncMock()()

        assert result["reply"] == "Done!"

    @pytest.mark.asyncio
    async def test_chat_does_not_trigger_on_failure(self, chat, mock_llm_config):
        from evolution.auto_skill_creator import AutoSkillCreator
        creator = AutoSkillCreator(llm_config=mock_llm_config)
        chat.auto_skill_creator = creator

        # Force max iterations by always returning tool_calls
        tool_resp = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "test_tool", "arguments": "{}"}}],
                },
                "finish_reason": "tool_calls",
            }]
        }

        call_count = [0]
        async def mock_post(*args, **kwargs):
            call_count[0] += 1
            class MockResp:
                def raise_for_status(self): pass
                def json(self): return tool_resp
            return MockResp()

        with patch("httpx.AsyncClient.post", mock_post):
            plan_dict = {
                "plan_id": "p1",
                "user_input": "test",
                "tasks": [{"id": "t1", "description": "step", "requires_tool": True, "tool_hint": "shell"}],
                "confidence": 0.8,
                "reasoning": "r",
            }
            with patch.object(chat, "_make_plan", new_callable=AsyncMock, return_value=plan_dict):
                with patch.object(creator, "should_create_skill", new_callable=AsyncMock) as mock_should:
                    result = await chat.chat("test", "sess-1")
                    mock_should.assert_not_awaited()

        assert "过多" in result["reply"] or "simplify" in result["reply"].lower()
