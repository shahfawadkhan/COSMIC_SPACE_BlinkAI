"""Background jobs: POST returns an id, GET returns progress and then the result.

Status lives in memory and in Redis while running (published at most every
0.25 s); the final status is also written to disk. The same request always
maps to the same job id, so repeating a POST joins the running job.
"""
from __future__ import annotations

import logging
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from . import cache as cache_mod
from . import config
from .errors import AppError

log = logging.getLogger(__name__)

STAGES = ("queued", "searching", "downloading", "reprojecting", "rendering", "done")
PUBLISH_EVERY_S = 0.25
STALE_AFTER_S = 120.0  # a "running" job not updated for this long (and not in memory) died


class Job:
    def __init__(self, job_id: str, kind: str, params: dict):
        self.id = job_id
        self.kind = kind
        self.params = params
        self.state = "queued"        # queued | running | done | error
        self.stage = "queued"
        self.done = 0
        self.total = 0
        self.eta_s: float | None = None
        self.message = ""
        self.error: dict | None = None
        self.result: Any = None
        self.detail: dict = {}
        self.created = time.time()
        self.updated = self.created
        self._stage_t0 = time.monotonic()
        self._last_publish = 0.0
        self._lock = threading.Lock()

    # ---------------------------------------------------------- updates (called by the worker)
    def set_stage(self, stage: str, total: int = 0, message: str = "") -> None:
        with self._lock:
            self.state = "running"
            self.stage = stage
            self.done, self.total = 0, total
            self.eta_s = None
            self.message = message
            self._stage_t0 = time.monotonic()
        self.publish(force=True)

    def progress(self, done: int, total: int | None = None, *, eta_s: float | None = None,
                 message: str | None = None, **detail) -> None:
        with self._lock:
            self.done = done
            if total is not None:
                self.total = total
            if eta_s is not None:
                self.eta_s = eta_s
            elif self.done > 0 and self.total > self.done:
                elapsed = time.monotonic() - self._stage_t0
                self.eta_s = elapsed / self.done * (self.total - self.done)
            elif self.total and self.done >= self.total:
                self.eta_s = 0.0
            if message is not None:
                self.message = message
            self.detail.update(detail)
        self.publish()

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "job_id": self.id,
                "kind": self.kind,
                "state": self.state,
                "stage": self.stage,
                "progress": {"done": self.done, "total": self.total},
                "eta_s": None if self.eta_s is None else round(self.eta_s, 1),
                "message": self.message,
                "detail": dict(self.detail),
                "error": self.error,
                "params": self.params,
                "created": self.created,
                "updated": time.time(),
            }

    def publish(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_publish < PUBLISH_EVERY_S:
            return
        self._last_publish = now
        final = self.state in ("done", "error")
        try:
            cache_mod.get_cache().set_json(job_key(self.id), self.to_dict(),
                                           ttl=config.TTL_JOB, disk=final)
        except Exception as exc:  # noqa: BLE001  status publishing must never kill a job
            log.debug("job publish failed: %s", exc)


def job_key(job_id: str) -> str:
    return cache_mod.make_key(cache_mod.NS_JOB, job_id)


class JobManager:
    def __init__(self, max_concurrent: int = 2):
        self._executor = ThreadPoolExecutor(max_workers=max_concurrent, thread_name_prefix="job")
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def submit(self, job_id: str, kind: str, params: dict, fn: Callable[[Job], Any]) -> Job:
        """Start fn(job) unless the same job is already queued/running."""
        with self._lock:
            existing = self._jobs.get(job_id)
            if existing is not None and existing.state in ("queued", "running"):
                return existing
            job = Job(job_id, kind, params)
            self._jobs[job_id] = job
        job.publish(force=True)
        self._executor.submit(self._run, job, fn)
        return job

    def _run(self, job: Job, fn: Callable[[Job], Any]) -> None:
        job.state = "running"
        try:
            job.result = fn(job)
            job.state, job.stage = "done", "done"
            job.done = job.total
            job.eta_s = 0.0
        except AppError as exc:
            job.state, job.error = "error", exc.to_dict()
        except Exception as exc:  # noqa: BLE001
            log.error("Job %s failed:\n%s", job.id, traceback.format_exc())
            job.state = "error"
            job.error = {"code": "internal_error", "message": f"{type(exc).__name__}: {exc}"}
        job.publish(force=True)

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is not None:
            return job.to_dict()
        status = cache_mod.get_cache().get_json(job_key(job_id))
        if status and status.get("state") in ("queued", "running") \
                and time.time() - float(status.get("updated", 0)) > STALE_AFTER_S:
            status["state"] = "error"
            status["error"] = {"code": "interrupted",
                               "message": "The server restarted while this job ran. Start it again."}
        return status

    def get_job(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)


jobs = JobManager()
