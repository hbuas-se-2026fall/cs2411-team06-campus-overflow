"""本地/验收启动器：按 CPU 与数据库连接预算计算 worker，避免默认单 worker 压测失真。

用法（campus-overflow-ai/backend）：
  uv run python scripts/serve.py

环境变量：
  APP_HOST / APP_PORT（默认 127.0.0.1:8000）
  WEB_CONCURRENCY（显式覆盖 worker 数）
  BACKEND_DB_POOL_SIZE / BACKEND_DB_POOL_MAX_OVERFLOW / DB_CONNECTION_BUDGET
  WORKER_MAX（进一步封顶）
"""

import os

import uvicorn

from app.core.workers import compute_workers


def main() -> None:
    pool_per_worker = int(os.environ.get("BACKEND_DB_POOL_SIZE", "10")) + int(
        os.environ.get("BACKEND_DB_POOL_MAX_OVERFLOW", "10")
    )
    workers = int(
        os.environ.get("WEB_CONCURRENCY")
        or compute_workers(
            os.cpu_count() or 1,
            1024,
            pool_per_worker,
            int(os.environ.get("DB_CONNECTION_BUDGET", "100")),
            int(os.environ.get("WORKER_MAX", "0")),
        )
    )
    print(f"starting uvicorn with {workers} worker(s)", flush=True)
    uvicorn.run(
        "app.main:app",
        host=os.environ.get("APP_HOST", "127.0.0.1"),
        port=int(os.environ.get("APP_PORT", "8000")),
        workers=max(1, workers),
        backlog=4096,
    )


if __name__ == "__main__":
    main()
