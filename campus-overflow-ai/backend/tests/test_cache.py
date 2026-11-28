# 进程内 TTL 缓存单元测试：命中、过期、LRU 淘汰与统计口径
from app.core.cache import TTLCache


class FakeClock:
    """可控单调时钟，避免测试依赖 sleep。"""

    def __init__(self, now: float = 100.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_hit_returns_cached_value() -> None:
    """相同 key 第二次调用不再执行 factory，统计 hits/misses/entries。"""
    cache: TTLCache = TTLCache(ttl_seconds=30, clock=FakeClock())
    calls: list[int] = []

    def factory() -> dict[str, int]:
        calls.append(1)
        return {"value": 1}

    assert cache.get_or_set("k", factory) == {"value": 1}
    assert cache.get_or_set("k", factory) == {"value": 1}
    assert calls == [1]
    assert cache.stats() == {"hits": 1, "misses": 1, "entries": 1}


def test_expires_after_ttl() -> None:
    """超过 TTL 后条目失效，重新执行 factory。"""
    clock = FakeClock()
    cache: TTLCache = TTLCache(ttl_seconds=5, clock=clock)
    values = iter(["old", "new"])

    assert cache.get_or_set("k", lambda: next(values)) == "old"
    clock.advance(5)
    assert cache.get_or_set("k", lambda: next(values)) == "new"
    stats = cache.stats()
    assert stats["hits"] == 0
    assert stats["misses"] == 2


def test_lru_eviction_keeps_recent() -> None:
    """容量超限时淘汰最久未使用的键，命中会刷新使用顺序。"""
    cache: TTLCache = TTLCache(ttl_seconds=30, max_entries=2, clock=FakeClock())
    cache.get_or_set("a", lambda: 1)
    cache.get_or_set("b", lambda: 2)
    assert cache.get_or_set("a", lambda: 99) == 1  # 命中，a 变为最近使用
    cache.get_or_set("c", lambda: 3)  # 超容量，淘汰最久未用的 b
    assert cache.stats()["entries"] == 2

    calls: list[int] = []
    assert cache.get_or_set("b", lambda: calls.append(1) or 4) == 4
    assert calls == [1]  # b 已被淘汰，重新取值
    assert cache.get_or_set("a", lambda: 99) == 99  # 写入 b 时把最久未用的 a 淘汰


def test_stats_excludes_expired_entries_and_clear() -> None:
    """stats 不统计过期条目；clear 后 entries 归零。"""
    clock = FakeClock()
    cache: TTLCache = TTLCache(ttl_seconds=10, clock=clock)
    cache.get_or_set("a", lambda: 1)
    cache.get_or_set("b", lambda: 2)
    assert cache.stats()["entries"] == 2

    clock.advance(10)
    assert cache.stats()["entries"] == 0

    cache.get_or_set("c", lambda: 3)
    cache.clear()
    assert cache.stats()["entries"] == 0


def test_non_positive_ttl_disables_cache() -> None:
    """ttl<=0 视为关闭缓存：每次都执行 factory，不写条目。"""
    cache: TTLCache = TTLCache(ttl_seconds=0, clock=FakeClock())
    calls: list[int] = []
    assert cache.get_or_set("k", lambda: calls.append(1) or "v") == "v"
    assert cache.get_or_set("k", lambda: calls.append(1) or "v") == "v"
    assert calls == [1, 1]
    assert cache.stats()["entries"] == 0
