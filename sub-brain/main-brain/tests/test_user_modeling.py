"""Tests for Phase 7 user modeling system."""

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from user_modeling import ProfileBuilder, ProfileUpdater, UserProfile


class TestUserProfile:
    def test_to_dict_roundtrip(self):
        p = UserProfile(
            name="Alice",
            interests=["AI", "Reading"],
            communication_style="concise",
            expertise_areas=["Backend"],
            preferred_tools=["Python"],
            timezone="UTC+8",
            created_at="2026-01-01T00:00:00+00:00",
            updated_at="2026-01-02T00:00:00+00:00",
        )
        d = p.to_dict()
        restored = UserProfile.from_dict(d)
        assert restored.name == "Alice"
        assert restored.interests == ["AI", "Reading"]
        assert restored.timezone == "UTC+8"

    def test_from_dict_defaults(self):
        p = UserProfile.from_dict({})
        assert p.name == ""
        assert p.interests == []
        assert p.timezone is None


class TestProfileBuilder:
    @pytest.fixture
    def mock_memory(self):
        mm = MagicMock()
        mm.get_recent = AsyncMock(return_value=[])
        return mm

    @pytest.fixture
    def builder(self, mock_memory):
        return ProfileBuilder(
            llm_config={
                "base_url": "http://localhost:99999/v1",
                "model_id": "test-model",
            },
            memory_manager=mock_memory,
        )

    @pytest.mark.asyncio
    async def test_build_profile_empty_conversations_returns_none(self, builder, mock_memory):
        mock_memory.get_recent.return_value = []
        result = await builder.build_profile()
        assert result is None

    @pytest.mark.asyncio
    async def test_build_profile_extracts_from_memory(self, builder, mock_memory):
        mock_memory.get_recent.return_value = [
            {"content": "Hello, I am Alice", "source": "user"},
            {"content": "Assistant: Hi Alice", "source": "assistant"},
        ]
        llm_response = json.dumps({
            "name": "Alice",
            "interests": ["AI"],
            "communication_style": "friendly",
            "expertise_areas": ["Engineering"],
            "preferred_tools": ["Python"],
            "timezone": "UTC+8",
        })

        with patch.object(builder, "_call_llm", new_callable=AsyncMock, return_value=llm_response):
            profile = await builder.build_profile()

        assert profile is not None
        assert profile.name == "Alice"
        assert profile.interests == ["AI"]
        assert profile.communication_style == "friendly"

    @pytest.mark.asyncio
    async def test_build_profile_llm_exception_fail_open(self, builder, mock_memory):
        mock_memory.get_recent.return_value = [
            {"content": "I love Rust", "source": "user"},
        ]
        with patch.object(builder, "_call_llm", new_callable=AsyncMock, side_effect=RuntimeError("boom")):
            profile = await builder.build_profile()
        assert profile is None

    @pytest.mark.asyncio
    async def test_build_profile_non_json_response_fail_open(self, builder, mock_memory):
        mock_memory.get_recent.return_value = [
            {"content": "I love Rust", "source": "user"},
        ]
        with patch.object(builder, "_call_llm", new_callable=AsyncMock, return_value="not json"):
            profile = await builder.build_profile()
        assert profile is None

    @pytest.mark.asyncio
    async def test_build_profile_with_fenced_json(self, builder, mock_memory):
        mock_memory.get_recent.return_value = [
            {"content": "I am Bob", "source": "user"},
        ]
        fenced = '```json\n{"name":"Bob","interests":[],"communication_style":"","expertise_areas":[],"preferred_tools":[],"timezone":null}\n```'
        with patch.object(builder, "_call_llm", new_callable=AsyncMock, return_value=fenced):
            profile = await builder.build_profile()
        assert profile is not None
        assert profile.name == "Bob"

    @pytest.mark.asyncio
    async def test_extract_recent_conversations_filters_and_reverses(self, builder, mock_memory):
        mock_memory.get_recent.return_value = [
            {"content": "Assistant: reply 2", "source": "assistant"},
            {"content": "user msg 2", "source": "user"},
            {"content": "system init", "source": "system"},
            {"content": "Assistant: reply 1", "source": "assistant"},
            {"content": "user msg 1", "source": "user"},
        ]
        convs = await builder._extract_recent_conversations()
        assert len(convs) == 4  # system skipped
        assert convs[0]["role"] == "user"
        assert convs[0]["content"] == "user msg 1"
        assert convs[1]["role"] == "assistant"
        assert convs[1]["content"] == "reply 1"
        assert convs[3]["role"] == "assistant"
        assert convs[3]["content"] == "reply 2"

    @pytest.mark.asyncio
    async def test_extract_recent_no_memory_manager(self):
        builder = ProfileBuilder(llm_config={})
        convs = await builder._extract_recent_conversations()
        assert convs == []

    @pytest.mark.asyncio
    async def test_build_profile_with_explicit_conversations(self, builder):
        """When conversations are passed explicitly, do not query memory."""
        convs = [{"role": "user", "content": "I am Carol"}]
        llm_response = json.dumps({
            "name": "Carol",
            "interests": [],
            "communication_style": "",
            "expertise_areas": [],
            "preferred_tools": [],
            "timezone": None,
        })
        with patch.object(builder, "_call_llm", new_callable=AsyncMock, return_value=llm_response):
            profile = await builder.build_profile(conversations=convs)
        assert profile is not None
        assert profile.name == "Carol"


class TestProfileUpdater:
    @pytest.fixture
    def mock_builder(self):
        b = MagicMock()
        b.build_profile = AsyncMock(return_value=UserProfile(
            name="Test",
            interests=["AI"],
            communication_style="concise",
            expertise_areas=["Dev"],
            preferred_tools=["VSCode"],
            timezone="UTC",
            created_at="2026-05-24T00:00:00+00:00",
            updated_at="2026-05-24T00:00:00+00:00",
        ))
        return b

    @pytest.fixture
    def updater(self, mock_builder, monkeypatch, tmp_path):
        monkeypatch.setenv("HOME", str(tmp_path))
        return ProfileUpdater(builder=mock_builder, interval_hours=0.001)

    @pytest.mark.asyncio
    async def test_run_now_writes_json_and_md(self, updater, tmp_path):
        profile = await updater.run_now()
        assert profile is not None
        json_path = tmp_path / ".webrain" / "user" / "profile.json"
        md_path = tmp_path / ".webrain" / "user" / "profile.md"
        assert json_path.exists()
        assert md_path.exists()

        data = json.loads(json_path.read_text(encoding="utf-8"))
        assert data["name"] == "Test"
        assert data["interests"] == ["AI"]

        md_text = md_path.read_text(encoding="utf-8")
        assert "# User Profile" in md_text
        assert "Test" in md_text
        assert "AI" in md_text

    @pytest.mark.asyncio
    async def test_run_now_with_none_profile(self, updater, mock_builder):
        mock_builder.build_profile = AsyncMock(return_value=None)
        profile = await updater.run_now()
        assert profile is None

    @pytest.mark.asyncio
    async def test_start_stop_lifecycle(self, updater):
        updater.start()
        assert updater._task is not None
        await updater.stop()
        assert updater._task is None

    @pytest.mark.asyncio
    async def test_start_idempotent(self, updater):
        updater.start()
        first_task = updater._task
        updater.start()
        assert updater._task is first_task
        await updater.stop()

    @pytest.mark.asyncio
    async def test_interval_parameter(self, mock_builder):
        updater = ProfileUpdater(builder=mock_builder, interval_hours=12.0)
        assert updater.interval_hours == 12.0


class TestChatEngineProfileIntegration:
    """ChatEngine reads profile.md into system prompt."""

    @pytest.mark.asyncio
    async def test_load_user_profile_includes_file_profile(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        from chat.chat_engine import ChatEngine

        mm = MagicMock()
        mm.query = AsyncMock(return_value=[])
        engine = ChatEngine(memory_manager=mm, sub_brain_client=MagicMock())
        engine.user_profile_enabled = True
        engine.user_profile_ttl = 0  # force refresh
        engine._user_profile_cache = None
        engine._user_profile_cached_at = 0
        engine._user_profile_lock = None

        # Create profile.md
        profile_dir = tmp_path / ".webrain" / "user"
        profile_dir.mkdir(parents=True, exist_ok=True)
        (profile_dir / "profile.md").write_text("# User Profile\n\nName: Dave", encoding="utf-8")

        text = await engine._load_user_profile()
        assert "## User Profile" in text
        assert "Name: Dave" in text

    @pytest.mark.asyncio
    async def test_load_user_profile_without_file(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        from chat.chat_engine import ChatEngine

        mm = MagicMock()
        mm.query = AsyncMock(return_value=[])
        engine = ChatEngine(memory_manager=mm, sub_brain_client=MagicMock())
        engine.user_profile_enabled = True
        engine.user_profile_ttl = 0
        engine._user_profile_cache = None
        engine._user_profile_cached_at = 0
        engine._user_profile_lock = None

        text = await engine._load_user_profile()
        assert text == ""
