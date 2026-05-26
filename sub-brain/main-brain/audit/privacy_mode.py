"""Privacy Mode Toggle — v2.17 (Axis 3).

When privacy mode is "on", LLMRouter is filtered to LOCAL endpoints only
(LM Studio, Ollama, localhost variants). Any remote provider (OpenAI,
Anthropic, etc.) is suppressed for that request — user data never leaves
the machine.

State is persisted at ~/.webrain/privacy_mode (single line: "on" or "off")
so the setting survives restarts.

Override storage location via env: WEBRAIN_PRIVACY_STATE_PATH=<abs path>

The privacy check (`is_local_url`) deliberately treats a few host
patterns as local:
  - localhost / 127.0.0.1 / ::1 / ::
  - 10.* / 192.168.* / 172.16-31.*  (RFC 1918)
  - file:// URIs

Anything else (api.openai.com, *.cloudflare.com, vpn-host-x, etc.) is
remote — even if it happens to be on a private VLAN we cannot verify
that, so we err on the safe side.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from threading import Lock
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger("webrain.audit.privacy_mode")

_RFC1918_RE = re.compile(
    r"^(?:"
    r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}"        # 10.0.0.0/8
    r"|192\.168\.\d{1,3}\.\d{1,3}"          # 192.168.0.0/16
    r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"  # 172.16.0.0/12
    r")$"
)


def is_local_url(url: str) -> bool:
    """Return True iff `url` resolves to a local/loopback host string.

    Pure string check — no DNS lookup. Anything not in the safe-list
    is considered remote.
    """
    if not url:
        return False
    if url.startswith("file://") or url.startswith("unix://"):
        return True
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    if host in ("localhost", "127.0.0.1", "::1", "::", "0.0.0.0"):
        return True
    # Strip IPv6 brackets if any
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if _RFC1918_RE.match(host):
        return True
    # *.local mDNS hostnames also count as local
    if host.endswith(".local"):
        return True
    return False


def _default_state_path() -> Path:
    env_path = os.environ.get("WEBRAIN_PRIVACY_STATE_PATH")
    if env_path:
        return Path(env_path).expanduser()
    return Path.home() / ".webrain" / "privacy_mode"


class PrivacyState:
    """Process-wide privacy toggle backed by a single-line state file.

    Default: off (allow all endpoints).
    Setting to "on" filters LLMRouter to local endpoints only.
    """

    def __init__(self, state_path: Optional[Path] = None) -> None:
        self.state_path: Path = state_path or _default_state_path()
        self._lock = Lock()
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            logger.warning(
                "Could not create privacy state dir %s: %s", self.state_path.parent, e
            )

    def get(self) -> str:
        """Return current mode: 'on' or 'off'. Missing file → 'off'."""
        if not self.state_path.exists():
            return "off"
        try:
            with self._lock:
                content = self.state_path.read_text(encoding="utf-8").strip().lower()
        except OSError as e:
            logger.warning("Read privacy_mode file failed: %s", e)
            return "off"
        return "on" if content == "on" else "off"

    def is_on(self) -> bool:
        return self.get() == "on"

    def set(self, mode: str) -> str:
        """Set mode to 'on' or 'off'. Returns the normalized written value.

        Invalid input is normalized to 'off' (fail-safe default).
        """
        normalized = "on" if str(mode).strip().lower() == "on" else "off"
        try:
            with self._lock:
                with open(self.state_path, "w", encoding="utf-8") as fp:
                    fp.write(normalized + "\n")
        except OSError as e:
            logger.warning("Write privacy_mode file failed: %s", e)
        return normalized

    def toggle(self) -> str:
        """Flip current state, return new value."""
        new = "off" if self.is_on() else "on"
        return self.set(new)


# Module-level singleton.
_state: Optional[PrivacyState] = None
_state_lock = Lock()


def get_privacy_state() -> PrivacyState:
    """Lazy singleton accessor."""
    global _state
    with _state_lock:
        if _state is None:
            _state = PrivacyState()
    return _state


def reset_for_tests(path: Optional[Path] = None) -> PrivacyState:
    global _state
    with _state_lock:
        _state = PrivacyState(state_path=path)
    return _state
