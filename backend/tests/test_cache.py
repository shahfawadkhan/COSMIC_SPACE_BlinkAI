import time

import numpy as np
import pytest

from app import cache as cache_mod
from app.cache import Cache, make_key


def test_make_key_stable_and_namespaced():
    a = make_key("irsa_search", 133.781, -7.241, {"b": 1, "a": 2})
    b = make_key("irsa_search", 133.781, -7.241, {"a": 2, "b": 1})
    assert a == b
    assert a.startswith("cosmic:irsa_search:")
    assert make_key("irsa_search", 133.782) != make_key("irsa_search", 133.781)
    with pytest.raises(ValueError):
        make_key("Bad NS")


def test_json_roundtrip_redis_then_disk(cache, fake_redis):
    key = make_key("catalog", "x")
    cache.set_json(key, {"v": 1, "bad": float("nan"), "arr": np.array([1.5, np.inf])}, ttl=60)
    assert fake_redis.get(key) is not None
    assert cache.get_json(key) == {"v": 1, "bad": None, "arr": [1.5, None]}
    assert cache.stats()["counters"]["redis_hits"] == 1

    # Evict from Redis: next read comes from disk and is copied back.
    fake_redis.delete(key)
    assert cache.get_json(key)["v"] == 1
    assert cache.stats()["counters"]["disk_hits"] == 1
    assert fake_redis.get(key) is not None
    assert 0 < fake_redis.ttl(key) <= 60


def test_json_expired_on_disk(cache, fake_redis):
    key = make_key("irsa_search", "old")
    cache.set_json(key, {"v": 1}, ttl=60)
    fake_redis.flushall()
    path = cache._path("json", key, "json")
    path.write_text('{"expires_at": %f, "value": {"v": 1}}' % (time.time() - 5), "utf-8")
    assert cache.get_json(key) is None
    assert cache.get_json(key, allow_stale=True) == {"v": 1}


def test_bytes_roundtrip_and_copyback(cache, fake_redis):
    key = make_key("render", "png")
    data = b"\x89PNG fake"
    cache.set_bytes(key, data, ttl=3600)
    assert cache.get_bytes(key) == data
    fake_redis.flushall()
    assert cache.get_bytes(key) == data
    assert fake_redis.get(key) == data
    assert cache.get_bytes(make_key("render", "missing")) is None


def test_redis_down_falls_back_to_disk(disk_cache):
    assert disk_cache.redis_status() == "down"
    key = make_key("catalog", "y")
    disk_cache.set_json(key, {"ok": True}, ttl=60)
    disk_cache.set_bytes(make_key("render", "z"), b"abc", ttl=60)
    assert disk_cache.get_json(key) == {"ok": True}
    assert disk_cache.get_bytes(make_key("render", "z")) == b"abc"
    s = disk_cache.stats()
    assert s["redis"]["status"] == "down"
    assert s["counters"]["disk_hits"] == 2
    assert s["counters"]["redis_errors"] >= 1


def test_redis_down_retries_at_most_every_30s(disk_cache, monkeypatch):
    import redis

    attempts = []
    real = redis.Redis.from_url

    def counting(*a, **k):
        attempts.append(1)
        return real(*a, **k)

    monkeypatch.setattr(redis.Redis, "from_url", counting)
    disk_cache._next_retry = 0
    for _ in range(5):
        disk_cache.get_json(make_key("catalog", "q"))
    assert len(attempts) == 1


def test_redis_disabled(tmp_path):
    c = Cache(cache_dir=tmp_path, redis_url="none")
    assert c.redis_status() == "disabled"
    k = make_key("catalog", 1)
    c.set_json(k, [1, 2], ttl=None)
    assert c.get_json(k) == [1, 2]


def test_arrays_roundtrip(cache):
    key = make_key("cutout", "url", 1)
    img = np.arange(12, dtype=np.float32).reshape(3, 4)
    img[0, 0] = np.nan
    cache.save_arrays(key, {"image": img, "flags": np.zeros((3, 4), np.uint32)},
                      meta={"mjd": 60800.5, "x": float("inf")})
    assert cache.has_arrays(key)
    arrays, meta = cache.load_arrays(key)
    assert np.isnan(arrays["image"][0, 0])
    np.testing.assert_array_equal(arrays["image"][1], img[1])
    assert arrays["flags"].dtype == np.uint32
    assert meta == {"mjd": 60800.5, "x": None}


def test_corrupt_arrays_removed(cache):
    key = make_key("cutout", "bad")
    p = cache.array_path(key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"not a zip")
    assert cache.load_arrays(key) is None
    assert not p.exists()


def test_clear_scopes(cache):
    r = make_key("render", "a")
    s = make_key("irsa_search", "b")
    cache.set_bytes(r, b"x", ttl=60)
    cache.set_json(s, {"a": 1}, ttl=60)
    out = cache.clear("renders")
    assert out["redis_keys_deleted"] == 1 and out["disk_files_deleted"] == 1
    assert cache.get_bytes(r) is None
    assert cache.get_json(s) == {"a": 1}
    cache.clear("all")
    assert cache.get_json(s) is None
    with pytest.raises(ValueError):
        cache.clear("bogus")


def test_get_cache_singleton():
    cache_mod.set_cache(None)
    try:
        c1 = cache_mod.get_cache()
        assert cache_mod.get_cache() is c1
    finally:
        cache_mod.set_cache(None)
