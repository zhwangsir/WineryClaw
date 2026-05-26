"""v2.17 — Axis 3: PrivacyState + is_local_url unit tests.

Verifies:
- is_local_url returns True for localhost, 127.0.0.1, ::1, RFC1918
- is_local_url returns False for public cloud APIs
- get() defaults to "off" when state file missing
- set("on") / set("off") persists across instances
- toggle() flips current value
- malformed file contents normalize to "off"
- env-var path override respected
"""

from pathlib import Path

import pytest

from audit import privacy_mode as pm_module
from audit.privacy_mode import (
    PrivacyState,
    get_privacy_state,
    is_local_url,
    reset_for_tests,
)


@pytest.fixture
def tmp_state(tmp_path: Path):
    """Fresh PrivacyState pointing at tmp file."""
    state = reset_for_tests(path=tmp_path / "privacy_mode")
    yield state
    pm_module._state = None


# ─────────────────────── is_local_url helper ────────────────────────────


class TestIsLocalUrl:
    def test_localhost_is_local(self):
        assert is_local_url("http://localhost:8080") is True

    def test_127_is_local(self):
        assert is_local_url("http://127.0.0.1:1234/v1") is True

    def test_ipv6_localhost(self):
        assert is_local_url("http://[::1]:1234") is True

    def test_lm_studio_default(self):
        # LM Studio default
        assert is_local_url("http://localhost:1234/v1") is True

    def test_ollama_default(self):
        assert is_local_url("http://127.0.0.1:11434") is True

    def test_rfc1918_10(self):
        assert is_local_url("http://10.0.0.50:8000") is True

    def test_rfc1918_192_168(self):
        assert is_local_url("http://192.168.1.100:11434") is True

    def test_rfc1918_172_16(self):
        assert is_local_url("http://172.16.0.1:8080") is True

    def test_rfc1918_172_31(self):
        assert is_local_url("http://172.31.255.254:8080") is True

    def test_rfc1918_172_32_is_remote(self):
        # 172.32.* is OUT of 172.16-31.* private range
        assert is_local_url("http://172.32.0.1:8080") is False

    def test_mdns_local_suffix(self):
        assert is_local_url("http://my-mac.local:1234") is True

    def test_public_remote(self):
        assert is_local_url("https://api.openai.com/v1") is False

    def test_anthropic_remote(self):
        assert is_local_url("https://api.anthropic.com/v1") is False

    def test_8_8_8_8_remote(self):
        assert is_local_url("http://8.8.8.8") is False

    def test_empty_string(self):
        assert is_local_url("") is False

    def test_file_uri_local(self):
        assert is_local_url("file:///tmp/socket") is True

    def test_unix_uri_local(self):
        assert is_local_url("unix:///tmp/sock") is True

    def test_malformed_url_safe(self):
        # No host portion — treated as not local
        assert is_local_url("not-a-url-at-all") is False

    def test_aws_metadata_endpoint_remote(self):
        # 169.254.169.254 is link-local, NOT in our safe-list — treat as remote.
        # User can always whitelist later if needed.
        assert is_local_url("http://169.254.169.254") is False


# ────────────────────── PrivacyState file ops ───────────────────────────


class TestPrivacyState:
    def test_default_off_when_missing(self, tmp_state):
        assert tmp_state.get() == "off"
        assert tmp_state.is_on() is False

    def test_set_on_persists(self, tmp_state):
        result = tmp_state.set("on")
        assert result == "on"
        assert tmp_state.is_on() is True
        # Reading via a different instance also sees "on"
        other = PrivacyState(state_path=tmp_state.state_path)
        assert other.is_on() is True

    def test_set_off_persists(self, tmp_state):
        tmp_state.set("on")
        tmp_state.set("off")
        assert tmp_state.is_on() is False

    def test_set_case_insensitive(self, tmp_state):
        tmp_state.set("ON")
        assert tmp_state.is_on() is True
        tmp_state.set("OFF")
        assert tmp_state.is_on() is False

    def test_set_invalid_normalizes_to_off(self, tmp_state):
        tmp_state.set("garbage")
        assert tmp_state.get() == "off"

    def test_toggle_from_off(self, tmp_state):
        # Start in default off → toggle should turn on
        assert tmp_state.get() == "off"
        result = tmp_state.toggle()
        assert result == "on"
        assert tmp_state.is_on() is True

    def test_toggle_from_on(self, tmp_state):
        tmp_state.set("on")
        result = tmp_state.toggle()
        assert result == "off"

    def test_malformed_file_contents(self, tmp_state):
        # Write garbage directly into the file
        tmp_state.state_path.write_text("???\n", encoding="utf-8")
        # Reads should fall back to "off"
        assert tmp_state.get() == "off"

    def test_state_file_round_trip_has_newline(self, tmp_state):
        tmp_state.set("on")
        content = tmp_state.state_path.read_text(encoding="utf-8")
        assert content == "on\n"


# ───────────────────────── env path override ────────────────────────────


class TestEnvPathOverride:
    def test_env_path_used(self, tmp_path, monkeypatch):
        custom = tmp_path / "alt-privacy"
        monkeypatch.setenv("WEBRAIN_PRIVACY_STATE_PATH", str(custom))
        state = PrivacyState()
        assert state.state_path == custom
        state.set("on")
        assert custom.exists()
        assert custom.read_text().strip() == "on"


# ─────────────────────── module singleton ───────────────────────────────


class TestSingleton:
    def test_get_privacy_state_same_instance(self, tmp_path, monkeypatch):
        monkeypatch.setenv(
            "WEBRAIN_PRIVACY_STATE_PATH", str(tmp_path / "p.state")
        )
        pm_module._state = None
        a = get_privacy_state()
        b = get_privacy_state()
        assert a is b
        pm_module._state = None

    def test_reset_for_tests(self, tmp_path):
        pm_module._state = None
        a = reset_for_tests(path=tmp_path / "x")
        b = reset_for_tests(path=tmp_path / "y")
        assert a is not b
        assert b.state_path == tmp_path / "y"
        pm_module._state = None
