"""Token loading + verification for MCP write-class tools (M4b.1).

Resolution order:
  1. `WEBRAIN_MCP_TOKEN` env var (highest priority; admin override)
  2. `~/.webrain/mcp_token` persisted file (auto-generated on first run)
  3. Generated cryptographically random token, written to (2) for reuse

The token is *not* returned by `/mcp/info` — only `token_configured`
status. Clients learn it out-of-band (env var or reading the file).
This mirrors the Jupyter / Grafana initial-admin-token pattern.
"""

from __future__ import annotations

import logging
import os
import secrets
from pathlib import Path
from typing import Optional

logger = logging.getLogger("webrain.mcp.auth")

TOKEN_FILE_NAME = "mcp_token"
TOKEN_FILE_DIR = ".webrain"
TOKEN_BYTES = 32  # 256 bits — overkill but free


def resolve_token(data_dir: Optional[Path] = None) -> str:
    """Return the MCP token, generating + persisting one on first call.

    Idempotent: subsequent calls with the same data_dir return the same
    token (read from file). The env var takes priority and bypasses
    file persistence entirely so admin overrides don't get auto-saved.
    """
    env_token = os.environ.get("WEBRAIN_MCP_TOKEN", "").strip()
    if env_token:
        return env_token

    base = data_dir or (Path.home() / TOKEN_FILE_DIR)
    base.mkdir(parents=True, exist_ok=True)
    token_path = base / TOKEN_FILE_NAME

    if token_path.exists():
        try:
            existing = token_path.read_text().strip()
            if existing:
                return existing
        except OSError as e:
            logger.warning("could not read MCP token file %s: %s", token_path, e)

    # Generate fresh
    token = secrets.token_urlsafe(TOKEN_BYTES)
    try:
        token_path.write_text(token + "\n")
        # 0600 — only the owning user should read it. Matches sshd habits.
        os.chmod(token_path, 0o600)
        logger.info(
            "MCP token generated and persisted to %s (read it for stdio bridge / external clients)",
            token_path,
        )
    except OSError as e:
        logger.warning("could not persist MCP token to %s: %s — falling back to in-memory only", token_path, e)
    return token


def extract_bearer(header_value: Optional[str]) -> Optional[str]:
    """Pull the token out of an `Authorization: Bearer <token>` header.

    Returns None for missing/malformed headers. Case-insensitive on the
    scheme name (some HTTP clients normalize it).
    """
    if not header_value:
        return None
    parts = header_value.strip().split(None, 1)
    if len(parts) != 2:
        return None
    scheme, token = parts
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


def verify(presented: Optional[str], expected: str) -> bool:
    """Constant-time comparison so token guessing can't time-channel-leak.

    Returns False if either side is empty — never let a missing token
    pass against an empty expected.
    """
    if not presented or not expected:
        return False
    # secrets.compare_digest is constant-time across equal-length inputs.
    # Pre-pad shorter side to avoid revealing length difference too.
    pa, pb = presented.encode("utf-8"), expected.encode("utf-8")
    if len(pa) != len(pb):
        return False
    return secrets.compare_digest(pa, pb)
