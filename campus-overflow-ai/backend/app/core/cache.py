# 进程内只读 TTL 缓存：线程安全、LRU 淘汰、无第三方依赖
# 仅用于低频变化的读接口（课程/标签/榜单）；多 worker 各自独立，不跨进程共享。
# 约束：只缓存普通 Python 对象或 Pydantic 响应对象，绝不缓存 SQLAlchemy ORM 实例。
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable
from typing import Any, TypeVar

T = TypeVar("T")


class TTLCache:
    """固定 TTL 的进程内缓存，容量超限时淘汰最久未使用的键。"""

    def __init__(
        self,
        ttl_seconds: float,
        max_entries: int = 256,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl = float(ttl_seconds)
        self._max_entries = max(1, int(max_entries))
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()
        self._hits = 0
        self._misses = 0

    def get_or_set(self, key: Hashable, factory: Callable[[], T]) -> T:
        """命中未过期条目直接返回；否则调用 factory 取值并写入。

        factory 在锁外执行，数据库查询不会阻塞其他线程；并发未命中时允许重复取值。
        ttl_seconds <= 0 视为关闭缓存，只取值不写入。
        """
        if self._ttl <= 0:
            with self._lock:
                self._misses += 1
            return factory()
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                expires_at, value = entry
                if now < expires_at:
                    self._hits += 1
                    self._entries.move_to_end(key)
                    return value
                del self._entries[key]
            self._misses += 1
        value = factory()
        with self._lock:
            self._entries[key] = (self._clock() + self._ttl, value)
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
        return value

    def clear(self) -> None:
        """清空全部条目（容量与累计统计保留）。"""
        with self._lock:
            self._entries.clear()

    def stats(self) -> dict[str, int]:
        """返回 hits/misses/entries；entries 只统计未过期条目。"""
        now = self._clock()
        with self._lock:
            expired = [
                key for key, (expires_at, _) in self._entries.items() if now >= expires_at
            ]
            for key in expired:
                del self._entries[key]
            return {
                "hits": self._hits,
                "misses": self._misses,
                "entries": len(self._entries),
            }
