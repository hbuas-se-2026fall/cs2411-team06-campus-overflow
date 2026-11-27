"""固定并发压测：统计成功率、状态码分布、P50/P95/P99 与 RPS。

用法（在 campus-overflow-ai 目录）：
  uv run --project backend python scripts/load_test.py \
    --url http://127.0.0.1:8000/api/courses --token-file "$env:TEMP/bench_token.txt" \
    --concurrency 100 --duration 60 --timeout 30

退出码：达到 --min-success-rate 与 --max-p95-ms 时为 0，否则为 1。
"""

import argparse
import math
import statistics
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(p / 100 * len(ordered)) - 1))
    return ordered[index]


def run(args: argparse.Namespace) -> int:
    token = Path(args.token_file).read_text(encoding="utf-8").strip() if args.token_file else ""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    deadline = time.perf_counter() + args.duration
    lock = threading.Lock()
    latencies: list[float] = []
    statuses: Counter[int] = Counter()
    errors: Counter[str] = Counter()

    def worker() -> None:
        while time.perf_counter() < deadline:
            started = time.perf_counter()
            status = 0
            try:
                request = urllib.request.Request(args.url, headers=headers)
                with urllib.request.urlopen(request, timeout=args.timeout) as response:
                    response.read()
                    status = response.status
            except urllib.error.HTTPError as exc:
                status = exc.code
                try:
                    exc.read()
                except OSError:
                    pass
            except Exception as exc:  # noqa: BLE001 - 压测脚本需要统计所有客户端失败
                status = 0
                with lock:
                    errors[type(exc).__name__] += 1
            elapsed_ms = (time.perf_counter() - started) * 1000
            with lock:
                statuses[status] += 1
                latencies.append(elapsed_ms)

    started_at = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for _ in range(args.concurrency):
            pool.submit(worker)
    elapsed = time.perf_counter() - started_at

    total = len(latencies)
    success = sum(count for status, count in statuses.items() if 200 <= status < 300)
    success_rate = success / total * 100 if total else 0.0
    p95 = percentile(latencies, 95)
    print(f"url={args.url}")
    print(f"concurrency={args.concurrency} duration={elapsed:.1f}s total={total} rps={total / elapsed:.1f}")
    print(f"success={success} success_rate={success_rate:.2f}%")
    print(
        "latency_ms "
        f"p50={percentile(latencies, 50):.1f} p95={p95:.1f} "
        f"p99={percentile(latencies, 99):.1f} max={max(latencies, default=0):.1f} "
        f"mean={statistics.fmean(latencies) if latencies else 0:.1f}"
    )
    print("statuses=" + ", ".join(f"{status or 'network_error'}:{count}" for status, count in sorted(statuses.items())))
    if errors:
        print("errors=" + ", ".join(f"{name}:{count}" for name, count in errors.most_common()))

    failed = success_rate < args.min_success_rate or (args.max_p95_ms > 0 and p95 > args.max_p95_ms)
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="固定并发 HTTP 压测")
    parser.add_argument("--url", required=True)
    parser.add_argument("--token-file", default="")
    parser.add_argument("--concurrency", type=int, default=100)
    parser.add_argument("--duration", type=int, default=60, help="持续秒数")
    parser.add_argument("--timeout", type=float, default=30.0, help="单请求超时秒数")
    parser.add_argument("--min-success-rate", type=float, default=0.0)
    parser.add_argument("--max-p95-ms", type=float, default=0.0, help="0 表示不校验")
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
