#!/bin/sh
# 生产入口：按 CPU/内存计算 worker 数，执行迁移后启动 uvicorn（ADR-012）。
set -eu

if [ -z "${WEB_CONCURRENCY:-}" ]; then
  WEB_CONCURRENCY="$(python - <<'PY'
import os


def cpu_count() -> int:
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:
        return os.cpu_count() or 1


def memory_gb() -> int:
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = open(path, encoding="utf-8").read().strip()
        except OSError:
            continue
        if raw == "max":
            return 1024
        value = int(raw)
        if value > (1 << 60):
            return 1024
        return max(1, value // (1024 ** 3))
    return 1


print(min(4, max(1, cpu_count() // 2), memory_gb()))
PY
)"
fi

alembic upgrade head
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers "$WEB_CONCURRENCY"
