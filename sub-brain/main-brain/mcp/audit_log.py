"""MCP audit log — records every tools/call invocation."""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timezone
from typing import List, Optional

logger = logging.getLogger("webrain.mcp.audit")


def init_audit_db(db_path: str) -> None:
    """Create the mcp_audit_log table if it does not exist."""
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mcp_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                scope TEXT NOT NULL,
                client_ip TEXT,
                success INTEGER DEFAULT 1,
                error_message TEXT
            )
            """
        )
        conn.commit()


def write_audit_log(
    db_path: str,
    tool_name: str,
    scope: str,
    client_ip: Optional[str],
    success: bool,
    error_message: Optional[str] = None,
) -> None:
    """Insert a single audit record. Failures are logged but not raised."""
    try:
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                """
                INSERT INTO mcp_audit_log
                (timestamp, tool_name, scope, client_ip, success, error_message)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    datetime.now(timezone.utc).isoformat(),
                    tool_name,
                    scope,
                    client_ip,
                    1 if success else 0,
                    error_message,
                ),
            )
            conn.commit()
    except Exception as e:
        logger.warning("Failed to write MCP audit log: %s", e)


def get_audit_logs(db_path: str, limit: int = 50) -> List[dict]:
    """Return the most recent audit records, newest first."""
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(
            """
            SELECT id, timestamp, tool_name, scope, client_ip, success, error_message
            FROM mcp_audit_log
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [dict(row) for row in cursor.fetchall()]
