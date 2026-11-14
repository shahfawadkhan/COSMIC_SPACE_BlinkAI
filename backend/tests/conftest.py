import fakeredis
import pytest

from app import cache as cache_mod
from app.net import breaker


@pytest.fixture
def fake_redis():
    return fakeredis.FakeRedis()


@pytest.fixture
def cache(tmp_path, fake_redis):
    c = cache_mod.Cache(cache_dir=tmp_path / "cache", redis_client=fake_redis)
    cache_mod.set_cache(c)
    yield c
    cache_mod.set_cache(None)


@pytest.fixture
def disk_cache(tmp_path):
    """Cache with Redis pointing at a closed port: must fall back to disk."""
    c = cache_mod.Cache(cache_dir=tmp_path / "cache", redis_url="redis://127.0.0.1:1/0")
    cache_mod.set_cache(c)
    yield c
    cache_mod.set_cache(None)


@pytest.fixture(autouse=True)
def _reset_breaker():
    breaker.reset()
    yield
    breaker.reset()
