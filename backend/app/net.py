"""Shared HTTP session, circuit breaker and mirror fallback for all external calls."""
from __future__ import annotations

import logging
import threading
import time
from typing import Iterable
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from . import config
from .errors import UpstreamError

log = logging.getLogger(__name__)

USER_AGENT = "COSMIC-Space-Blink-AI/0.1 (NASA Space Apps 2026; SPHEREx viewer)"


def _make_session() -> requests.Session:
    retry = Retry(
        total=2,
        connect=2,
        read=2,
        status=2,
        backoff_factor=0.5,
        # 429/503 ("server busy") are handled by our own code so we can honour
        # Retry-After and slow down instead of hammering the service.
        status_forcelist=(500, 502, 504),
        allowed_methods=frozenset({"GET", "POST", "HEAD"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=retry)
    s = requests.Session()
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    s.headers.update({"User-Agent": USER_AGENT, "Connection": "keep-alive"})
    return s


session = _make_session()


class CircuitBreaker:
    """Skip a service for `cooldown_s` after it fails."""

    def __init__(self, cooldown_s: float | None = None, threshold: int = 1):
        self.cooldown_s = cooldown_s
        self.threshold = threshold
        self._lock = threading.Lock()
        self._failures: dict[str, int] = {}
        self._open_until: dict[str, float] = {}
        self._last_error: dict[str, str] = {}

    def _cooldown(self) -> float:
        return self.cooldown_s if self.cooldown_s is not None else config.settings.breaker_cooldown_s

    def is_open(self, name: str) -> bool:
        with self._lock:
            return time.monotonic() < self._open_until.get(name, 0.0)

    def record_success(self, name: str) -> None:
        with self._lock:
            self._failures.pop(name, None)
            self._open_until.pop(name, None)

    def record_failure(self, name: str, error: str, threshold: int | None = None) -> None:
        with self._lock:
            n = self._failures.get(name, 0) + 1
            self._failures[name] = n
            self._last_error[name] = error
            if n >= (threshold or self.threshold):
                if time.monotonic() >= self._open_until.get(name, 0.0):
                    log.warning("%s marked down for %ds: %s", name, int(self._cooldown()), error)
                self._open_until[name] = time.monotonic() + self._cooldown()

    def status(self) -> dict:
        now = time.monotonic()
        with self._lock:
            return {
                name: {
                    "open": now < until,
                    "retry_in_s": max(0, round(until - now)),
                    "last_error": self._last_error.get(name),
                }
                for name, until in self._open_until.items()
            }

    def reset(self) -> None:
        with self._lock:
            self._failures.clear()
            self._open_until.clear()
            self._last_error.clear()


breaker = CircuitBreaker()


def retry_after_s(resp, default: float = 5.0) -> float:
    """Seconds to wait from a Retry-After header (numeric form), else `default`."""
    headers = getattr(resp, "headers", None) or {}
    try:
        return max(0.0, float(headers.get("Retry-After", default)))
    except (TypeError, ValueError):
        return default


class AdaptiveGate:
    """Concurrency limiter that backs off when a service says it is busy (AIMD).

    Starts at `max_concurrency`; every busy reply halves the limit and pauses
    new requests for Retry-After seconds; every success grows it by ~1 per
    `limit` successes, up to the maximum.
    """

    def __init__(self, max_concurrency: int, min_concurrency: int = 1):
        self.max = max(1, max_concurrency)
        self.min = max(1, min(min_concurrency, self.max))
        self.limit = float(self.max)
        self.active = 0
        self.pause_until = 0.0
        self.busy_count = 0
        self._cond = threading.Condition()

    def acquire(self, deadline: float | None = None) -> bool:
        with self._cond:
            while True:
                now = time.monotonic()
                if deadline is not None and now >= deadline:
                    return False
                wait = self.pause_until - now
                if wait <= 0 and self.active < int(self.limit):
                    self.active += 1
                    return True
                timeout = wait if wait > 0 else 0.25
                if deadline is not None:
                    timeout = min(timeout, deadline - now)
                self._cond.wait(timeout=max(0.01, timeout))

    def release(self, outcome: str = "ok", retry_after: float = 0.0) -> None:
        """outcome: 'ok', 'busy' (429/503) or 'error'."""
        with self._cond:
            self.active = max(0, self.active - 1)
            if outcome == "busy":
                self.busy_count += 1
                self.limit = max(float(self.min), self.limit / 2.0)
                self.pause_until = max(self.pause_until, time.monotonic() + retry_after)
            elif outcome == "ok":
                self.limit = min(float(self.max), self.limit + 1.0 / max(1.0, self.limit))
            self._cond.notify_all()

    def status(self) -> dict:
        with self._cond:
            return {"limit": round(self.limit, 2), "active": self.active, "max": self.max,
                    "busy_replies": self.busy_count,
                    "paused_s": max(0.0, round(self.pause_until - time.monotonic(), 1))}


def _host(url: str) -> str:
    return urlparse(url).netloc or url


def request_with_mirrors(
    service: str,
    urls: Iterable[str],
    method: str = "GET",
    *,
    timeout: float | None = None,
    ok_status: Iterable[int] = (200,),
    **kwargs,
) -> requests.Response:
    """Try each mirror in order, skipping hosts whose breaker is open.

    Raises UpstreamError with a readable message if every mirror fails.
    """
    timeout = timeout if timeout is not None else config.settings.http_timeout_s
    ok = set(ok_status)
    errors: list[str] = []
    urls = list(urls)
    for url in urls:
        name = f"{service}@{_host(url)}"
        if breaker.is_open(name):
            errors.append(f"{_host(url)}: skipped (recently failed)")
            continue
        try:
            resp = session.request(method, url, timeout=timeout, **kwargs)
            if resp.status_code in (429, 503):  # busy: wait once as asked, then retry
                time.sleep(min(retry_after_s(resp, 2.0), 10.0))
                resp = session.request(method, url, timeout=timeout, **kwargs)
            elif resp.status_code in (502, 504):  # proxy hiccup at the archive: retry twice
                for pause in (1.5, 4.0):
                    time.sleep(pause)
                    resp = session.request(method, url, timeout=timeout, **kwargs)
                    if resp.status_code not in (502, 504):
                        break
        except requests.Timeout:
            msg = f"timed out after {timeout:g}s"
        except requests.RequestException as exc:
            msg = f"connection failed ({type(exc).__name__})"
        else:
            if resp.status_code in ok:
                breaker.record_success(name)
                return resp
            msg = f"HTTP {resp.status_code}"
            # 404 = this mirror's endpoint is gone (seen on CDS SIMBAD): skip it for a while.
            if resp.status_code < 500 and resp.status_code not in (429, 404):
                # Client error: our request is wrong, not the service. Do not trip the breaker.
                errors.append(f"{_host(url)}: {msg}")
                continue
        breaker.record_failure(name, msg)
        errors.append(f"{_host(url)}: {msg}")
    raise UpstreamError(f"{service} unavailable: " + "; ".join(errors or ["no URL configured"]))
