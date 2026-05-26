"""pytest configuration and shared fixtures."""

import os
import shutil
import tempfile
from pathlib import Path

import pytest


@pytest.fixture(scope="session", autouse=True)
def _prewarm_embedder_and_fast_provider_timeout():
    """Pre-load the sentence-transformers model once per test session so
    cold-start cost (~8s) is paid upfront, not inside every test.

    Also drop the embedding-provider timeout to 0.1s so unreachable
    Ollama/OpenAI endpoints fail fast instead of burning 3-5s per call.
    Without this, the memory benchmark (60+ embedding calls) times out
    at 300s because each call waits for localhost:11434 to time out.
    """
    os.environ.setdefault("WEBRAIN_EMBEDDING_PROVIDER_TIMEOUT_S", "0.1")
    from memory.memory_manager import _get_embedder
    _get_embedder()


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test data."""
    d = tempfile.mkdtemp(prefix="webrain_test_")
    yield Path(d)
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def mock_llm_config():
    """Minimal LLM config for testing without real endpoints."""
    return {
        "base_url": "http://localhost:99999/v1",
        "model_id": "test-model",
        "api_key": "test-key",
        "temperature": 0.7,
        "max_tokens": 512,
    }


@pytest.fixture(autouse=True)
def isolate_webrain_home(monkeypatch, temp_dir):
    """Redirect ~/.webrain to temp dir during tests."""
    monkeypatch.setenv("HOME", str(temp_dir))
    # Pre-create expected dirs
    (temp_dir / ".webrain").mkdir(exist_ok=True)


@pytest.fixture
def mock_llm_response():
    """Standard mock LLM chat completion response."""
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": '{"sub_tasks": ["task1"], "reasoning_chain": [{"step": 1, "task": "task1", "reasoning": "test"}], "conclusion": "test conclusion", "confidence": 0.9, "needs_tool": false, "suggested_tool": ""}',
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20},
    }
