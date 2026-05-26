"""Profile updater — background task that periodically rebuilds the user profile."""

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from .profile_builder import ProfileBuilder
from .user_profile import UserProfile

logger = logging.getLogger("webrain.user_modeling")


class ProfileUpdater:
    """Periodically rebuild user profile and write to local disk."""

    def __init__(
        self,
        builder: ProfileBuilder,
        interval_hours: float = 24.0,
    ):
        self.builder = builder
        self.interval_hours = interval_hours
        self._task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()

    @property
    def profile_dir(self) -> Path:
        return Path.home() / ".webrain" / "user"

    def start(self) -> None:
        """Launch the background update loop."""
        if self._task is not None:
            logger.warning("ProfileUpdater already started")
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._loop())
        logger.info("ProfileUpdater started (interval=%.1fh)", self.interval_hours)

    async def stop(self) -> None:
        """Signal the background loop to stop and await it."""
        if self._task is None:
            return
        self._stop_event.set()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        logger.info("ProfileUpdater stopped")

    async def run_now(self) -> Optional[UserProfile]:
        """Manually trigger one update cycle."""
        return await self._run_update()

    async def _loop(self) -> None:
        """Background loop: run update, then sleep until next interval."""
        while not self._stop_event.is_set():
            try:
                await self._run_update()
            except Exception as e:
                logger.warning("ProfileUpdater cycle failed: %s", e)
            # Sleep in chunks so we can respond to stop quickly
            total_seconds = self.interval_hours * 3600
            slept = 0.0
            chunk = 10.0
            while slept < total_seconds and not self._stop_event.is_set():
                await asyncio.sleep(min(chunk, total_seconds - slept))
                slept += chunk

    async def _run_update(self) -> Optional[UserProfile]:
        """Build profile and persist to disk."""
        profile = await self.builder.build_profile()
        if profile is None:
            logger.info("ProfileUpdater: no profile produced this cycle")
            return None

        self.profile_dir.mkdir(parents=True, exist_ok=True)

        # Write JSON (machine-readable)
        json_path = self.profile_dir / "profile.json"
        try:
            json_path.write_text(json.dumps(profile.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning("ProfileUpdater: failed to write JSON: %s", e)

        # Write Markdown (human-readable)
        md_path = self.profile_dir / "profile.md"
        md_lines = [
            "# User Profile",
            "",
            f"**Name:** {profile.name or 'Unknown'}",
            "",
            "## Interests",
            "",
        ]
        if profile.interests:
            for item in profile.interests:
                md_lines.append(f"- {item}")
        else:
            md_lines.append("- (none identified)")
        md_lines.extend([
            "",
            "## Communication Style",
            "",
            profile.communication_style or "(not identified)",
            "",
            "## Expertise Areas",
            "",
        ])
        if profile.expertise_areas:
            for item in profile.expertise_areas:
                md_lines.append(f"- {item}")
        else:
            md_lines.append("- (none identified)")
        md_lines.extend([
            "",
            "## Preferred Tools",
            "",
        ])
        if profile.preferred_tools:
            for item in profile.preferred_tools:
                md_lines.append(f"- {item}")
        else:
            md_lines.append("- (none identified)")
        md_lines.extend([
            "",
            "## Timezone",
            "",
            profile.timezone or "(not identified)",
            "",
            f"*Created at {profile.created_at}*",
        ])
        try:
            md_path.write_text("\n".join(md_lines), encoding="utf-8")
        except Exception as e:
            logger.warning("ProfileUpdater: failed to write Markdown: %s", e)

        logger.info("ProfileUpdater: profile written to %s", self.profile_dir)
        return profile
