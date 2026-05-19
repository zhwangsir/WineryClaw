"""Service-launch fixtures for the e2e boot smoke test.

This module spawns main-brain AND sub-brain as real subprocesses, waits
for both to become healthy, yields a live config dict to the test, then
tears everything down. No mocks. The whole point is to catch the bug
class where "every unit test passes but the actual binary can't boot
or has dead wiring".

Why a separate conftest under tests/smoke/:
  - The smoke test must NOT run during normal pytest sweeps (it would
    require Python venv + Node pnpm install + free network ports + ~30s).
    Keeping fixtures in a sibling subdir lets the `smoke` marker do the
    gating without polluting the regular test session.
  - It's the only test in the codebase that crosses the
    Python ↔ Node boundary, so the boilerplate (port waiting, subprocess
    cleanup, log capture) lives in one place.

Run: pytest -m smoke tests/smoke/ -s
"""

from __future__ import annotations

import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, Optional

import httpx
import pytest


# ---------------------------------------------------------------------------
# Repo layout discovery
# ---------------------------------------------------------------------------


def _repo_root() -> Path:
    """Walk up from this file to find webrain-integration root."""
    p = Path(__file__).resolve()
    for parent in p.parents:
        if (parent / "sub-brain" / "main-brain" / "main_brain.py").exists():
            return parent
    raise RuntimeError(f"Could not locate webrain-integration root from {p}")


REPO_ROOT = _repo_root()
MAIN_BRAIN_DIR = REPO_ROOT / "sub-brain" / "main-brain"
SUB_BRAIN_DIR = REPO_ROOT / "sub-brain"
VENV_PYTHON = MAIN_BRAIN_DIR / "venv" / "bin" / "python3"


# ---------------------------------------------------------------------------
# Port allocation — use high random ports so parallel CI doesn't collide
# ---------------------------------------------------------------------------


def _find_free_port() -> int:
    """Bind a TCP socket to port 0, read what the kernel gave us, release.

    There's a TOCTOU window between release and the subprocess binding —
    in practice this is fine on dev machines. CI parallelism would need a
    lockfile but we're not there yet.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------


@dataclass
class RunningService:
    name: str
    process: subprocess.Popen
    port: int
    log_path: Path
    base_url: str

    def kill(self, timeout: float = 5.0) -> None:
        """Terminate cleanly, then SIGKILL if it ignores us."""
        if self.process.poll() is not None:
            return
        try:
            # Send SIGTERM to the entire process group so uvicorn/tsx
            # children also die. We started with start_new_session=True so
            # the subprocess is its own process-group leader.
            os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            self.process.terminate()
        try:
            self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(self.process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                self.process.kill()
            self.process.wait(timeout=timeout)


def _wait_for_http(url: str, timeout: float, label: str, log_path: Path) -> None:
    """Poll `url` until it responds 2xx or timeout. Dump logs on fail."""
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            r = httpx.get(url, timeout=2.0)
            if 200 <= r.status_code < 300:
                return
            last_err = f"HTTP {r.status_code}"
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.RemoteProtocolError) as e:
            last_err = type(e).__name__
        time.sleep(0.5)

    # Failure path — surface the service log so the assertion error is actionable
    log_tail = ""
    try:
        log_tail = log_path.read_text(errors="replace")[-4000:]
    except OSError:
        pass
    raise TimeoutError(
        f"{label} failed to become ready at {url} within {timeout}s "
        f"(last: {last_err}).\n--- last 4KB of log ---\n{log_tail}"
    )


def _spawn_main_brain(
    port: int, tmp_data_dir: Path, log_path: Path,
    sub_brain_port: Optional[int] = None,
) -> RunningService:
    """Start main-brain bound to a specific port with an isolated data dir.

    Critical: we point HOME at a tmpdir so the persisted mcp_token and any
    ~/.webrain artifacts don't leak between runs. WEBRAIN_DATA_DIR also
    redirects the main memory.db etc. to the tmpdir so each smoke run
    starts with a fresh DB — no cross-run contamination, no dev DB
    pollution. (Added 2026-05-20; prior to that smoke runs accumulated
    rows in the project's data/main-brain dir and tests had to filter
    by unique session_id to dodge the cruft.)

    sub_brain_port: if known up-front, set WEBRAIN_SUB_BRAIN_URL so main-brain's
    _fetch_llm_config() can reach the smoke's sub-brain rather than the
    hard-coded :3000 default (which won't be running in smoke).
    Without this, /config/reload silently falls back to the default LM
    Studio URL — the chat-flow smoke test would hit a real dev endpoint
    instead of our mock LLM.
    """
    log_file = open(log_path, "w", buffering=1)  # line-buffered
    env = os.environ.copy()
    env["WEBRAIN_MAIN_BRAIN_PORT"] = str(port)
    env["WEBRAIN_LLM_HEALTH_DISABLED"] = "1"
    # The smoke env has no live LLM endpoint. Without a tight conflict
    # judge timeout, any L3 store that finds a similar predecessor blocks
    # for 20s on a doomed httpx call. 2s is well under our per-test 30s
    # budget while still proving the wiring fires.
    env["WEBRAIN_CONFLICT_LLM_TIMEOUT_S"] = "2"
    # Force HOME to tmp so persisted files don't leak
    env["HOME"] = str(tmp_data_dir)
    # Redirect main-brain's data dir to the same tmp so memory.db,
    # vectors, RAG state, etc. all stay isolated per smoke run.
    env["WEBRAIN_DATA_DIR"] = str(tmp_data_dir / "main-brain-data")
    # Speed up boot — skip Tokenizers parallelism warnings
    env["TOKENIZERS_PARALLELISM"] = "false"
    if sub_brain_port is not None:
        env["WEBRAIN_SUB_BRAIN_URL"] = f"http://127.0.0.1:{sub_brain_port}"

    if not VENV_PYTHON.exists():
        raise FileNotFoundError(
            f"main-brain venv not found at {VENV_PYTHON}. "
            "Run `cd sub-brain/main-brain && python3 -m venv venv && "
            "venv/bin/pip install -r requirements.txt` first."
        )

    # main_brain.py uses argparse — its `--port` arg is what controls
    # uvicorn binding. The WEBRAIN_MAIN_BRAIN_PORT env var is sub-brain's
    # client-side configuration, not the server-side bind port. Pass both
    # so behaviour is unambiguous regardless of how main-brain evolves.
    proc = subprocess.Popen(
        [str(VENV_PYTHON), "main_brain.py", "--port", str(port)],
        cwd=str(MAIN_BRAIN_DIR),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,  # process group leader for clean kill
    )
    base_url = f"http://127.0.0.1:{port}"
    _wait_for_http(f"{base_url}/health", timeout=30.0, label="main-brain", log_path=log_path)
    return RunningService("main-brain", proc, port, log_path, base_url)


def _spawn_sub_brain(port: int, main_brain_port: int, log_path: Path) -> RunningService:
    """Start sub-brain on the given port, pointed at the running main-brain.

    Uses `npx tsx` instead of `pnpm dev` (tsx watch) because watch mode
    eats startup errors silently — the bug class Issue #8 / #7 from the
    user trial. Direct `tsx src/main.ts` surfaces them.
    """
    log_file = open(log_path, "w", buffering=1)
    env = os.environ.copy()
    # sub-brain main.ts reads BOTH of these explicit names. Setting
    # WEBRAIN_MAIN_BRAIN_PORT also flips it out of UDS mode (the auto
    # mode kicks in only when neither MAIN_BRAIN_UDS nor MAIN_BRAIN_PORT
    # env vars are set — see sub-brain/src/main.ts:37).
    env["WEBRAIN_MAIN_BRAIN_PORT"] = str(main_brain_port)
    env["WEBRAIN_SUB_BRAIN_PORT"] = str(port)
    env["TOKENIZERS_PARALLELISM"] = "false"
    # Explicitly clear UDS to be defensive — if the parent shell had it
    # set, sub-brain would try UDS first and ignore our TCP port.
    env.pop("WEBRAIN_MAIN_BRAIN_UDS", None)

    proc = subprocess.Popen(
        ["npx", "tsx", "src/main.ts"],
        cwd=str(SUB_BRAIN_DIR),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    # Sub-brain boot includes module compilation; give it more headroom.
    _wait_for_http(f"{base_url}/health", timeout=45.0, label="sub-brain", log_path=log_path)
    return RunningService("sub-brain", proc, port, log_path, base_url)


# ---------------------------------------------------------------------------
# The pytest fixture
# ---------------------------------------------------------------------------


@dataclass
class SmokeRig:
    main_brain: RunningService
    sub_brain: RunningService
    tmp_dir: Path


def _spawn_mock_llm(port: int, log_path: Path) -> RunningService:
    """Spawn the tests/smoke/mock_llm_server.py FastAPI app on `port`.

    Used by chat-flow smoke tests that need a working LLM endpoint
    main-brain can actually reach. The mock returns a deterministic
    "MOCK-LLM-REPLY" sentinel so tests can grep for it.
    """
    log_file = open(log_path, "w", buffering=1)
    mock_script = Path(__file__).parent / "mock_llm_server.py"
    if not mock_script.exists():
        raise FileNotFoundError(f"mock LLM script missing: {mock_script}")

    proc = subprocess.Popen(
        [str(VENV_PYTHON), str(mock_script), "--port", str(port)],
        cwd=str(MAIN_BRAIN_DIR),  # uvicorn is installed in main-brain venv
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env=os.environ.copy(),
        start_new_session=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    # Mock LLM has no /health; poll /v1/models instead.
    _wait_for_http(f"{base_url}/v1/models", timeout=10.0, label="mock-llm", log_path=log_path)
    return RunningService("mock-llm", proc, port, log_path, base_url)


@dataclass
class ChatSmokeRig:
    main_brain: RunningService
    sub_brain: RunningService
    mock_llm: RunningService
    tmp_dir: Path


@pytest.fixture(scope="module")
def chat_smoke_rig(smoke_rig) -> Iterator[ChatSmokeRig]:
    """Extend smoke_rig with a mock LLM + wire main-brain to use it.

    Module-scoped so chat tests share one LLM mock + one config reload.
    Implementation:
      1. Spawn mock_llm_server.py on a fresh port
      2. POST /config/model to sub-brain pointing at the mock URL
      3. POST /config/reload on main-brain so ChatEngine.router picks up
         the new endpoint
      4. Yield the rig
      5. Restore original sub-brain config + reload main-brain on teardown
         so other tests aren't affected
    """
    mock_log = smoke_rig.tmp_dir / "mock-llm.log"
    mock_port = _find_free_port()
    mock_llm: Optional[RunningService] = None
    original_config: Optional[Dict] = None

    try:
        mock_llm = _spawn_mock_llm(mock_port, mock_log)

        # Snapshot sub-brain's current model config so we can restore later
        sub_url = smoke_rig.sub_brain.base_url
        snapshot = httpx.get(f"{sub_url}/config/model", timeout=5.0)
        if snapshot.status_code == 200:
            original_config = snapshot.json().get("config") or snapshot.json()

        # Point main-brain at the mock LLM via sub-brain's config API
        new_config = {
            "endpoints": [{
                "name": "mock-llm",
                "base_url": f"{mock_llm.base_url}/v1",
                "model_id": "mock-model",
                "api_key": "test-key",
                "priority": 100,
                "timeout": 10.0,
                "provider": "openai",
            }],
            "temperature": 0.0,
            "maxTokens": 256,
        }
        r = httpx.post(f"{sub_url}/config/model", json=new_config, timeout=10.0)
        assert r.status_code == 200, f"Failed to set mock LLM config: {r.text}"

        # Tell main-brain to reload. Without this, ChatEngine.router still
        # points at whatever was loaded at lifespan time.
        r = httpx.post(f"{smoke_rig.main_brain.base_url}/config/reload", timeout=15.0)
        assert r.status_code == 200, f"Failed to reload main-brain config: {r.text}"

        # Warm up the chat path with one throwaway call. The first chat
        # triggers lazy loads (cross-encoder for re-ranking,
        # paraphrase-multilingual-MiniLM-L12-v2 for ConflictDetector) that
        # cost ~25s combined and would push the first real test body past
        # any sane timeout. By front-loading them into fixture setup, each
        # actual test body sees a sub-second chat latency.
        try:
            httpx.post(
                f"{sub_url}/brain/chat",
                json={
                    "message": "warmup ping",
                    "session_id": "smoke-warmup",
                    "context": {"tools_enabled": False},
                },
                timeout=90.0,  # generous; cold load may be slower on CI
            )
        except httpx.HTTPError as exc:
            # Warm-up failure is non-fatal — tests will discover the
            # problem with a clearer message than a timeout in setup.
            print(f"[chat_smoke_rig] warm-up chat failed: {exc}")

        yield ChatSmokeRig(
            main_brain=smoke_rig.main_brain,
            sub_brain=smoke_rig.sub_brain,
            mock_llm=mock_llm,
            tmp_dir=smoke_rig.tmp_dir,
        )
    finally:
        # Best-effort restoration — if these fail, the worst case is that
        # other tests inherit the mock LLM URL, which is fine since they
        # don't exercise the chat path.
        if original_config is not None:
            try:
                httpx.post(
                    f"{smoke_rig.sub_brain.base_url}/config/model",
                    json=original_config, timeout=5.0,
                )
                httpx.post(
                    f"{smoke_rig.main_brain.base_url}/config/reload", timeout=10.0,
                )
            except (httpx.HTTPError, httpx.ConnectError):
                pass
        if mock_llm is not None:
            mock_llm.kill()


@pytest.fixture(scope="module")
def smoke_rig() -> Iterator[SmokeRig]:
    """Module-scoped fixture: spawn both services once for all smoke tests.

    Module scope rather than function scope because service boot is the
    expensive part — ~10s for main-brain (loads sentence-transformers),
    ~3-5s for sub-brain. Tests should be order-independent and idempotent.
    """
    tmp_dir = Path(tempfile.mkdtemp(prefix="webrain-smoke-"))
    main_log = tmp_dir / "main-brain.log"
    sub_log = tmp_dir / "sub-brain.log"

    main_brain: Optional[RunningService] = None
    sub_brain: Optional[RunningService] = None

    try:
        # Allocate both ports up front so we can tell main-brain which
        # sub-brain port to query for /config/model. Without this, any
        # /config/reload falls back to defaults (LM Studio at
        # 192.168.71.100), which breaks the chat-flow smoke completely.
        main_port = _find_free_port()
        sub_port = _find_free_port()
        main_brain = _spawn_main_brain(main_port, tmp_dir, main_log,
                                       sub_brain_port=sub_port)

        sub_brain = _spawn_sub_brain(sub_port, main_port, sub_log)

        yield SmokeRig(main_brain=main_brain, sub_brain=sub_brain, tmp_dir=tmp_dir)

    finally:
        # Order: sub-brain first (it may have child processes pointing at
        # main-brain), then main-brain.
        if sub_brain is not None:
            sub_brain.kill()
        if main_brain is not None:
            main_brain.kill()
        # Keep logs around on failure so they can be inspected, but clean
        # up on success. pytest's tmp_path system handles its own cleanup;
        # we used our own tempfile because the fixture is module-scoped.
        # Conservative: always keep — they're tiny and useful when CI fails.
        # shutil.rmtree(tmp_dir, ignore_errors=True)
