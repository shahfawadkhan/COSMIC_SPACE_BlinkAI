"""Two-level cache: Redis (fast, shared, TTL) in front of disk (big, survives restarts).

Reads try Redis first, then disk; a disk hit is copied back into Redis.
Writes go to both. If Redis is down the cache logs once, keeps working on
disk only, and retries Redis at most every 30 s.

Keys look like "cosmic:<namespace>:<sha256 prefix>" (see make_key). The
namespace stays readable so a whole group (e.g. renders) can be cleared.

Disk layout under CACHE_DIR:
    json/<namespace>/<hash>.json     {"expires_at": epoch|null, "value": ...}
    bytes/<namespace>/<hash>.bin     5-byte magic + 8-byte expiry + payload
    arrays/<namespace>/<hash>.npz    numpy arrays (+ "__meta__" JSON string)

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import shutil
import struct
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np

from . import config
from .jsonutil import dumps, to_jsonable

log = logging.getLogger(__name__)

KEY_PREFIX = "cosmic"

# Namespaces used across the app.
NS_SEARCH = "irsa_search"
NS_CATALOG = "catalog"
NS_NAME = "name_lookup"
NS_RENDER = "render"
NS_JOB = "job"
NS_MANIFEST = "manifest"
NS_CUTOUT = "cutout"
NS_STACK = "stack"
NS_SIM = "sim"  # Planet X Lab: SIMULATED sets, never mixed with real ones

CLEAR_SCOPES: dict[str, list[str] | None] = {
    "renders": [NS_RENDER],
    "searches": [NS_SEARCH],
    "all": None,  # everything
}

REDIS_RETRY_S = 30.0
REDIS_TIMEOUT_S = 0.5
# Items stored on disk "forever" get this TTL when copied back to Redis.
REDIS_COPYBACK_TTL_S = 7 * 24 * 3600

_BIN_MAGIC = b"CSMC1"
_BIN_HEADER = struct.Struct(">d")
_KEY_RE = re.compile(r"^cosmic:([a-z0-9_]+):([0-9a-f]{8,64})$")
_KINDS = ("json", "bytes", "arrays")


def make_key(namespace: str, *parts: Any) -> str:
    """Build a stable, hashed cache key: cosmic:<namespace>:<hash>."""
    if not re.fullmatch(r"[a-z0-9_]+", namespace):
        raise ValueError(f"bad cache namespace {namespace!r}")
    payload = json.dumps(to_jsonable(list(parts)), sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]
    return f"{KEY_PREFIX}:{namespace}:{digest}"


def _split_key(key: str) -> tuple[str, str]:
    m = _KEY_RE.match(key)
    if m:
        return m.group(1), m.group(2)
    # Foreign key: hash it into the "misc" namespace so the path is safe.
    return "misc", hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_bytes(data)
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows: target briefly open by a reader
            if attempt == 4:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.05 * (attempt + 1))


class Cache:
    def __init__(
        self,
        cache_dir: str | Path | None = None,
        redis_url: str | None = None,
        redis_client: Any = None,
    ):
        self.dir = Path(cache_dir if cache_dir is not None else config.settings.cache_dir).resolve()
        self.dir.mkdir(parents=True, exist_ok=True)
        self._redis_url = config.settings.redis_url if redis_url is None else redis_url
        self._enabled = redis_client is not None or self._redis_url.lower() not in (
            "", "none", "off", "disabled")
        self._client = redis_client
        self._next_retry = 0.0
        self._down = False
        self._lock = threading.Lock()        # guards Redis (re)connect
        self._stats_lock = threading.Lock()  # guards counters (separate: _mark_down counts under _lock)
        self._stats = {k: 0 for k in (
            "redis_hits", "redis_misses", "redis_errors",
            "disk_hits", "disk_misses", "writes")}

    # ------------------------------------------------------------------ redis
    def _redis(self):
        """Return a live Redis client or None (disabled / down / retry not due)."""
        if not self._enabled:
            return None
        if self._client is not None and not self._down:
            return self._client
        now = time.monotonic()
        if now < self._next_retry:
            return None
        with self._lock:
            if self._client is not None and not self._down:
                return self._client
            self._next_retry = now + REDIS_RETRY_S
            try:
                client = self._client
                if client is None:
                    import redis  # local import keeps tests free of a hard dependency
                    client = redis.Redis.from_url(
                        self._redis_url,
                        socket_timeout=REDIS_TIMEOUT_S,
                        socket_connect_timeout=REDIS_TIMEOUT_S,
                        retry_on_timeout=False,
                    )
                client.ping()
            except Exception as exc:  # noqa: BLE001
                self._mark_down(exc)
                return None
            if self._down:
                log.info("Redis is back: using Redis + disk cache")
            self._client = client
            self._down = False
            return client

    def _mark_down(self, exc: Exception) -> None:
        self._count("redis_errors")
        if not self._down:
            log.warning("Redis unavailable (%s); using disk cache only, retrying every %ds",
                        exc, int(REDIS_RETRY_S))
        self._down = True
        self._next_retry = time.monotonic() + REDIS_RETRY_S

    def _redis_call(self, fn_name: str, *args, **kwargs):
        client = self._redis()
        if client is None:
            return None, False
        try:
            return getattr(client, fn_name)(*args, **kwargs), True
        except Exception as exc:  # noqa: BLE001
            self._mark_down(exc)
            return None, False

    def redis_status(self) -> str:
        """'connected', 'disabled' or 'down'."""
        if not self._enabled:
            return "disabled"
        return "connected" if self._redis() is not None else "down"

    # ------------------------------------------------------------------ utils
    def _count(self, name: str, n: int = 1) -> None:
        with self._stats_lock:
            self._stats[name] += n

    def _path(self, kind: str, key: str, ext: str) -> Path:
        ns, digest = _split_key(key)
        return self.dir / kind / ns / f"{digest}.{ext}"

    @staticmethod
    def _expiry(ttl: float | None) -> float | None:
        return None if ttl is None else time.time() + float(ttl)

    @staticmethod
    def _remaining(expires_at: float | None) -> int | None:
        if expires_at is None:
            return REDIS_COPYBACK_TTL_S
        return max(1, math.ceil(expires_at - time.time()))

    def _redis_set(self, key: str, data: bytes | str, ttl: float | None) -> None:
        ex = None if ttl is None else max(1, int(math.ceil(ttl)))
        self._redis_call("set", key, data, ex=ex)

    # ------------------------------------------------------------------ JSON
    def get_json(self, key: str, *, allow_stale: bool = False) -> Any | None:
        raw, ok = self._redis_call("get", key)
        if ok:
            if raw is not None:
                self._count("redis_hits")
                return json.loads(raw)
            self._count("redis_misses")
        path = self._path("json", key, "json")
        try:
            record = json.loads(path.read_text("utf-8"))
        except (FileNotFoundError, ValueError, OSError):
            self._count("disk_misses")
            return None
        expires_at = record.get("expires_at")
        if expires_at is not None and expires_at < time.time() and not allow_stale:
            self._count("disk_misses")
            return None
        self._count("disk_hits")
        value = record.get("value")
        if expires_at is None or expires_at > time.time():
            self._redis_set(key, dumps(value), self._remaining(expires_at))
        return value

    def set_json(self, key: str, value: Any, ttl: float | None = None, *, disk: bool = True) -> None:
        text = dumps(value)
        self._redis_set(key, text, ttl)
        if disk:
            record = '{"expires_at":%s,"value":%s}' % (
                json.dumps(self._expiry(ttl)), text)
            _atomic_write(self._path("json", key, "json"), record.encode("utf-8"))
        self._count("writes")

    # ------------------------------------------------------------------ bytes
    def get_bytes(self, key: str) -> bytes | None:
        raw, ok = self._redis_call("get", key)
        if ok:
            if raw is not None:
                self._count("redis_hits")
                return bytes(raw)
            self._count("redis_misses")
        path = self._path("bytes", key, "bin")
        try:
            blob = path.read_bytes()
        except (FileNotFoundError, OSError):
            self._count("disk_misses")
            return None
        head = len(_BIN_MAGIC) + _BIN_HEADER.size
        if len(blob) < head or not blob.startswith(_BIN_MAGIC):
            self._count("disk_misses")
            return None
        (exp,) = _BIN_HEADER.unpack_from(blob, len(_BIN_MAGIC))
        expires_at = None if exp == 0 else exp
        if expires_at is not None and expires_at < time.time():
            self._count("disk_misses")
            return None
        self._count("disk_hits")
        data = blob[head:]
        self._redis_set(key, data, self._remaining(expires_at))
        return data

    def set_bytes(self, key: str, data: bytes, ttl: float | None = None, *, disk: bool = True) -> None:
        self._redis_set(key, data, ttl)
        if disk:
            exp = self._expiry(ttl)
            _atomic_write(self._path("bytes", key, "bin"),
                          _BIN_MAGIC + _BIN_HEADER.pack(exp or 0.0) + data)
        self._count("writes")

    def delete(self, key: str) -> None:
        self._redis_call("delete", key)
        for kind, ext in (("json", "json"), ("bytes", "bin"), ("arrays", "npz")):
            self._path(kind, key, ext).unlink(missing_ok=True)

    # ------------------------------------------------------------------ arrays (disk only)
    def array_path(self, key: str) -> Path:
        return self._path("arrays", key, "npz")

    def has_arrays(self, key: str) -> bool:
        return self.array_path(key).exists()

    def save_arrays(self, key: str, arrays: dict[str, np.ndarray],
                    meta: dict | None = None, *, compressed: bool = False) -> Path:
        path = self.array_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.stem}.{uuid.uuid4().hex}.tmp.npz")
        payload = dict(arrays)
        if meta is not None:
            payload["__meta__"] = np.array(dumps(meta))
        (np.savez_compressed if compressed else np.savez)(tmp, **payload)
        data = tmp.read_bytes()
        tmp.unlink(missing_ok=True)
        _atomic_write(path, data)
        self._count("writes")
        return path

    def load_arrays(self, key: str) -> tuple[dict[str, np.ndarray], dict] | None:
        """Return (arrays, meta) or None if missing/corrupt."""
        path = self.array_path(key)
        try:
            with np.load(path, allow_pickle=False) as npz:
                arrays = {name: npz[name] for name in npz.files if name != "__meta__"}
                meta = json.loads(str(npz["__meta__"])) if "__meta__" in npz.files else {}
        except FileNotFoundError:
            self._count("disk_misses")
            return None
        except OSError as exc:  # e.g. Windows: file is being replaced right now. Not corrupt.
            log.debug("array cache %s busy (%s)", path.name, exc)
            self._count("disk_misses")
            return None
        except Exception as exc:  # noqa: BLE001  corrupt file: drop it
            log.warning("Corrupt array cache %s (%s); removing", path.name, exc)
            path.unlink(missing_ok=True)
            self._count("disk_misses")
            return None
        self._count("disk_hits")
        return arrays, meta

    # ------------------------------------------------------------------ admin
    def clear(self, scope: str) -> dict:
        if scope not in CLEAR_SCOPES:
            raise ValueError(f"scope must be one of {sorted(CLEAR_SCOPES)}")
        namespaces = CLEAR_SCOPES[scope]
        patterns = ([f"{KEY_PREFIX}:*"] if namespaces is None
                    else [f"{KEY_PREFIX}:{ns}:*" for ns in namespaces])
        redis_deleted = 0
        client = self._redis()
        if client is not None:
            try:
                for pattern in patterns:
                    batch = []
                    for k in client.scan_iter(match=pattern, count=500):
                        batch.append(k)
                        if len(batch) >= 500:
                            redis_deleted += client.delete(*batch)
                            batch = []
                    if batch:
                        redis_deleted += client.delete(*batch)
            except Exception as exc:  # noqa: BLE001
                self._mark_down(exc)
        files_deleted = 0
        for kind in _KINDS:
            base = self.dir / kind
            if not base.exists():
                continue
            dirs = [base] if namespaces is None else [base / ns for ns in namespaces]
            for d in dirs:
                if d.exists():
                    files_deleted += sum(1 for p in d.rglob("*") if p.is_file())
                    shutil.rmtree(d, ignore_errors=True)
        return {"scope": scope, "redis_keys_deleted": redis_deleted,
                "disk_files_deleted": files_deleted}

    def stats(self) -> dict:
        with self._stats_lock:
            counters = dict(self._stats)
        disk: dict[str, dict] = {}
        for kind in _KINDS:
            base = self.dir / kind
            if not base.exists():
                continue
            for ns_dir in base.iterdir():
                if not ns_dir.is_dir():
                    continue
                files = [p for p in ns_dir.rglob("*") if p.is_file()]
                entry = disk.setdefault(ns_dir.name, {"files": 0, "bytes": 0})
                entry["files"] += len(files)
                entry["bytes"] += sum(p.stat().st_size for p in files)
        status = self.redis_status()
        redis_info: dict[str, Any] = {"status": status}
        if status == "connected":
            try:  # informational only: never mark Redis down because INFO failed
                info = self._client.info("memory")
                redis_info["used_memory_human"] = info.get("used_memory_human")
            except Exception:  # noqa: BLE001
                pass
        return {
            "redis": redis_info,
            "counters": counters,
            "disk": {"dir": str(self.dir), "namespaces": disk,
                     "total_bytes": sum(v["bytes"] for v in disk.values())},
        }


_cache: Cache | None = None
_cache_lock = threading.Lock()


def get_cache() -> Cache:
    global _cache
    if _cache is None:
        with _cache_lock:
            if _cache is None:
                _cache = Cache()
    return _cache


def set_cache(cache: Cache | None) -> None:
    """Replace the process-wide cache (used by tests)."""
    global _cache
    _cache = cache