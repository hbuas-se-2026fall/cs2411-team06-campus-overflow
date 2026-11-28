#!/bin/sh
# 生产入口：运行时探测可用 CPU/内存，结合数据库连接预算计算 worker（ADR-013）。
set -eu

if [ -z "${WEB_CONCURRENCY:-}" ]; then
  WEB_CONCURRENCY="$(python - <<'PY'
import os

from app.core.workers import compute_workers


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


pool_per_worker = int(os.environ.get("BACKEND_DB_POOL_SIZE", "10")) \
    + int(os.environ.get("BACKEND_DB_POOL_MAX_OVERFLOW", "10"))
connection_budget = int(os.environ.get("DB_CONNECTION_BUDGET", "100"))
max_workers = int(os.environ.get("WORKER_MAX", "0"))
print(compute_workers(cpu_count(), memory_gb(), pool_per_worker, connection_budget, max_workers))
PY
)"
fi

echo "starting uvicorn with ${WEB_CONCURRENCY} worker(s)"
alembic upgrade head
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers "$WEB_CONCURRENCY" --backlog 4096
