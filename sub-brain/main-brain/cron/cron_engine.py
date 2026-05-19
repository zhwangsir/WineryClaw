"""
WeBrain Cron Engine — 通用定时任务调度器
支持: Cron 表达式、任务队列、重试机制、Webhook 回调
"""

import asyncio
import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("webrain.cron")


class CronJob:
    """A single cron job definition."""

    def __init__(self, job_id: str, name: str, cron_expr: str, task_type: str,
                 task_params: Dict[str, Any], enabled: bool = True,
                 max_retries: int = 3, webhook_url: Optional[str] = None):
        self.job_id = job_id
        self.name = name
        self.cron_expr = cron_expr
        self.task_type = task_type
        self.task_params = task_params
        self.enabled = enabled
        self.max_retries = max_retries
        self.webhook_url = webhook_url
        self.last_run: Optional[str] = None
        self.next_run: Optional[str] = None
        self.run_count = 0
        self.fail_count = 0
        self.created_at = datetime.now(timezone.utc).isoformat()
        self._update_next_run()

    def _update_next_run(self) -> None:
        try:
            from croniter import croniter
            itr = croniter(self.cron_expr, datetime.now(timezone.utc))
            self.next_run = itr.get_next(datetime).isoformat()
        except Exception as e:
            logger.warning(f"Invalid cron expression '{self.cron_expr}': {e}")
            self.next_run = None

    def should_run(self) -> bool:
        if not self.enabled or not self.next_run:
            return False
        return datetime.now(timezone.utc).isoformat() >= self.next_run

    def to_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id, "name": self.name, "cron_expr": self.cron_expr,
            "task_type": self.task_type, "task_params": self.task_params,
            "enabled": self.enabled, "max_retries": self.max_retries,
            "webhook_url": self.webhook_url, "last_run": self.last_run,
            "next_run": self.next_run, "run_count": self.run_count,
            "fail_count": self.fail_count, "created_at": self.created_at,
        }


class CronEngine:
    """General-purpose cron job scheduler."""

    TASK_HANDLERS: Dict[str, Callable] = {}

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or str(Path.home() / ".webrain" / "cron.db")
        self.jobs: Dict[str, CronJob] = {}
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._init_db()
        self._load_jobs()

    def _init_db(self) -> None:
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cron_jobs (
                job_id TEXT PRIMARY KEY, name TEXT NOT NULL, cron_expr TEXT NOT NULL,
                task_type TEXT NOT NULL, task_params TEXT NOT NULL, enabled INTEGER DEFAULT 1,
                max_retries INTEGER DEFAULT 3, webhook_url TEXT, last_run TEXT, next_run TEXT,
                run_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0, created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cron_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
                started_at TEXT NOT NULL, finished_at TEXT, status TEXT,
                output TEXT, error TEXT, retry_count INTEGER DEFAULT 0
            )
        """)
        conn.commit()
        conn.close()

    def _load_jobs(self) -> None:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM cron_jobs").fetchall()
        conn.close()
        for row in rows:
            job = CronJob(row["job_id"], row["name"], row["cron_expr"], row["task_type"],
                          json.loads(row["task_params"]), bool(row["enabled"]),
                          row["max_retries"], row["webhook_url"])
            job.last_run = row["last_run"]
            job.run_count = row["run_count"]
            job.fail_count = row["fail_count"]
            job.created_at = row["created_at"]
            self.jobs[job.job_id] = job

    def _save_job(self, job: CronJob) -> None:
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """INSERT OR REPLACE INTO cron_jobs
               (job_id, name, cron_expr, task_type, task_params, enabled, max_retries, webhook_url,
                last_run, next_run, run_count, fail_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (job.job_id, job.name, job.cron_expr, job.task_type,
             json.dumps(job.task_params, ensure_ascii=False), int(job.enabled),
             job.max_retries, job.webhook_url, job.last_run, job.next_run,
             job.run_count, job.fail_count, job.created_at),
        )
        conn.commit()
        conn.close()

    def create_job(self, name: str, cron_expr: str, task_type: str,
                   task_params: Dict[str, Any], **kwargs) -> CronJob:
        import uuid
        job_id = f"cron-{datetime.now(timezone.utc).timestamp():.6f}-{uuid.uuid4().hex[:6]}"
        job = CronJob(job_id, name, cron_expr, task_type, task_params, **kwargs)
        self.jobs[job_id] = job
        self._save_job(job)
        logger.info(f"Created cron job '{name}': {cron_expr}")
        return job

    def get_job(self, job_id: str) -> Optional[CronJob]:
        return self.jobs.get(job_id)

    def list_jobs(self) -> List[Dict[str, Any]]:
        return [j.to_dict() for j in self.jobs.values()]

    def update_job(self, job_id: str, **updates) -> Optional[CronJob]:
        job = self.jobs.get(job_id)
        if not job:
            return None
        for key, value in updates.items():
            if hasattr(job, key):
                setattr(job, key, value)
        job._update_next_run()
        self._save_job(job)
        return job

    def delete_job(self, job_id: str) -> bool:
        if job_id not in self.jobs:
            return False
        del self.jobs[job_id]
        conn = sqlite3.connect(self.db_path)
        conn.execute("DELETE FROM cron_jobs WHERE job_id = ?", (job_id,))
        conn.commit()
        conn.close()
        return True

    def enable_job(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if job:
            job.enabled = True
            job._update_next_run()
            self._save_job(job)
            return True
        return False

    def disable_job(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if job:
            job.enabled = False
            self._save_job(job)
            return True
        return False

    async def start(self) -> None:
        if self._running:
            return
        pid_path = Path(self.db_path).parent / "cron.pid"
        if pid_path.exists():
            try:
                existing = int(pid_path.read_text().strip())
                os.kill(existing, 0)
                logger.warning(f"Cron engine already running (pid {existing}); skipping start")
                return
            except (ValueError, ProcessLookupError, OSError):
                pass  # stale lock from a dead process — take over
        pid_path.parent.mkdir(parents=True, exist_ok=True)
        pid_path.write_text(str(os.getpid()))
        self._pid_path = pid_path
        self._running = True
        self._task = asyncio.create_task(self._scheduler_loop())
        logger.info("Cron engine started")

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        pid_path = getattr(self, "_pid_path", None)
        if pid_path and pid_path.exists():
            try:
                if int(pid_path.read_text().strip()) == os.getpid():
                    pid_path.unlink()
            except (ValueError, OSError):
                pass
        logger.info("Cron engine stopped")

    async def _scheduler_loop(self) -> None:
        while self._running:
            try:
                for job in list(self.jobs.values()):
                    if job.should_run():
                        asyncio.create_task(self._execute_job(job))
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Scheduler loop error: {e}")
                await asyncio.sleep(10)

    async def _execute_job(self, job: CronJob) -> None:
        run_id = self._record_run_start(job.job_id)
        job.last_run = datetime.now(timezone.utc).isoformat()
        job.run_count += 1
        job._update_next_run()
        self._save_job(job)

        handler = self.TASK_HANDLERS.get(job.task_type)
        if not handler:
            error = f"No handler for task type: {job.task_type}"
            self._record_run_finish(run_id, "failed", error=error)
            job.fail_count += 1
            self._save_job(job)
            return

        for attempt in range(job.max_retries + 1):
            try:
                result = await handler(job.task_params)
                self._record_run_finish(run_id, "success", output=str(result)[:1000])
                logger.info(f"Cron job '{job.name}' succeeded")
                if job.webhook_url:
                    asyncio.create_task(self._send_webhook(job.webhook_url, {
                        "job_id": job.job_id, "name": job.name, "status": "success", "output": result,
                    }))
                return
            except Exception as e:
                error = f"{type(e).__name__}: {str(e)}"
                logger.warning(f"Cron job '{job.name}' attempt {attempt + 1} failed: {error}")
                if attempt < job.max_retries:
                    await asyncio.sleep(2 ** attempt)
                else:
                    self._record_run_finish(run_id, "failed", error=error)
                    job.fail_count += 1
                    self._save_job(job)
                    if job.webhook_url:
                        asyncio.create_task(self._send_webhook(job.webhook_url, {
                            "job_id": job.job_id, "name": job.name, "status": "failed", "error": error,
                        }))

    @classmethod
    def register_handler(cls, task_type: str, handler: Callable):
        cls.TASK_HANDLERS[task_type] = handler

    def _record_run_start(self, job_id: str) -> int:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.execute(
            "INSERT INTO cron_runs (job_id, started_at, status) VALUES (?, ?, ?)",
            (job_id, datetime.now(timezone.utc).isoformat(), "running"),
        )
        conn.commit()
        run_id = cursor.lastrowid
        conn.close()
        return run_id or 0

    def _record_run_finish(self, run_id: int, status: str, output: Optional[str] = None, error: Optional[str] = None) -> None:
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "UPDATE cron_runs SET finished_at = ?, status = ?, output = ?, error = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), status, output, error, run_id),
        )
        conn.commit()
        conn.close()

    def get_run_history(self, job_id: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        if job_id:
            rows = conn.execute("SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?",
                                (job_id, limit)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?",
                                (limit,)).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    async def _send_webhook(self, url: str, payload: Dict[str, Any]) -> None:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(url, json=payload)
        except Exception as e:
            logger.warning(f"Webhook failed: {e}")

    def get_stats(self) -> Dict[str, Any]:
        total = len(self.jobs)
        enabled = sum(1 for j in self.jobs.values() if j.enabled)
        total_runs = sum(j.run_count for j in self.jobs.values())
        total_fails = sum(j.fail_count for j in self.jobs.values())
        return {
            "total_jobs": total, "enabled_jobs": enabled, "disabled_jobs": total - enabled,
            "total_runs": total_runs, "total_failures": total_fails,
            "success_rate": (total_runs - total_fails) / max(total_runs, 1),
        }
