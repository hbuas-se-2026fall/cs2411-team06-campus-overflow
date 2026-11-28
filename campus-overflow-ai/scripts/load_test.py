"""固定并发压测（asyncio + HTTP keep-alive）：模拟真实浏览器连接复用。

用法（在 campus-overflow-ai 目录）：
  uv run --project backend python scripts/load_test.py \
    --url http://127.0.0.1:8000/api/courses --token-file "$env:TEMP/bench_token.txt" \
    --concurrency 1000 --duration 60 --timeout 30 --warmup 3

每个 worker 复用一条 TCP 连接；响应解析 Content-Length 或 chunked。
超时/连接异常时关闭并重连。退出码：达到阈值 0，否则 1。
"""

import argparse
import asyncio
import math
import statistics
import time
import urllib.parse
from collections import Counter
from pathlib import Path


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(p / 100 * len(ordered)) - 1))
    return ordered[index]


class KeepAliveConnection:
    """单条 keep-alive 连接：按 Content-Length / chunked 读完响应才能复用。"""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer
        self.closed = False

    @classmethod
    async def open(cls, host: str, port: int, timeout: float) -> "KeepAliveConnection":
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
        return cls(reader, writer)

    async def request(
        self, host: str, path: str, authorization: str, timeout: float,
    ) -> tuple[int, float]:
        started = time.perf_counter()
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {host}",
            "Connection: keep-alive",
            "Accept: */*",
        ]
        if authorization:
            lines.append(f"Authorization: {authorization}")
        self._writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
        await asyncio.wait_for(self._writer.drain(), timeout)
        status_line = await asyncio.wait_for(self._reader.readline(), timeout)
        parts = status_line.split()
        status = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0

        headers: dict[str, str] = {}
        while True:
            line = await asyncio.wait_for(self._reader.readline(), timeout)
            if line in (b"\r\n", b"\n", b""):
                break
            key, _, value = line.decode("latin-1").partition(":")
            headers[key.strip().lower()] = value.strip()
        if headers.get("connection", "").lower() == "close":
            self.closed = True

        self.closed = self.closed or await self._drain_body(headers, timeout)
        return status, (time.perf_counter() - started) * 1000

    async def _drain_body(self, headers: dict[str, str], timeout: float) -> bool:
        """读完响应体；返回连接是否已不可复用。"""
        if headers.get("transfer-encoding", "").lower() == "chunked":
            while True:
                size_line = await asyncio.wait_for(self._reader.readline(), timeout)
                size = int(size_line.strip().split(b";")[0] or b"0", 16)
                if size == 0:
                    await asyncio.wait_for(self._reader.readline(), timeout)
                    return False
                await asyncio.wait_for(self._reader.readexactly(size), timeout)
                await asyncio.wait_for(self._reader.readline(), timeout)
        length = headers.get("content-length")
        if length is not None:
            await asyncio.wait_for(self._reader.readexactly(int(length)), timeout)
            return False
        # 无长度信息（如 204 或服务端关闭）：读到 EOF，连接不可复用
        await asyncio.wait_for(self._reader.read(), timeout)
        return True

    def close(self) -> None:
        self._writer.close()
        self.closed = True


async def worker(
    host: str, port: int, targets: list[str], authorization: str, timeout: float, deadline: float,
    latencies: list[float], latencies_by_target: dict[str, list[float]],
    statuses: Counter[int], errors: Counter[str], reconnects: Counter[int],
) -> None:
    connection: KeepAliveConnection | None = None
    index = 0
    while time.perf_counter() < deadline:
        try:
            if connection is None:
                connection = await KeepAliveConnection.open(host, port, timeout)
                reconnects[1] += 1
            target = targets[index % len(targets)]
            index += 1
            status, elapsed = await connection.request(host, target, authorization, timeout)
            statuses[status] += 1
            latencies.append(elapsed)
            latencies_by_target[target].append(elapsed)
        except asyncio.TimeoutError:
            errors["TimeoutError"] += 1
            if connection is not None:
                connection.close()
            connection = None
        except Exception as exc:  # noqa: BLE001 - 压测需要统计所有客户端失败
            errors[type(exc).__name__] += 1
            if connection is not None:
                connection.close()
            connection = None
        if connection is not None and connection.closed:
            connection.close()
            connection = None
    if connection is not None:
        connection.close()


async def run_load(args: argparse.Namespace) -> int:
    parsed = urllib.parse.urlsplit(args.url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    targets = [item.strip() for item in (args.paths or path).split(",") if item.strip()]
    authorization = ""
    if args.token_file:
        authorization = f"Bearer {Path(args.token_file).read_text(encoding='utf-8').strip()}"

    latencies: list[float] = []
    latencies_by_target: dict[str, list[float]] = {target: [] for target in targets}
    statuses: Counter[int] = Counter()
    errors: Counter[str] = Counter()
    reconnects: Counter[int] = Counter()

    if args.warmup > 0:
        warmup_deadline = time.perf_counter() + args.warmup
        await asyncio.gather(*(
            worker(host, port, targets, authorization, args.timeout, warmup_deadline,
                   [], {target: [] for target in targets}, Counter(), Counter(), Counter())
            for _ in range(min(args.concurrency, 50))
        ))

    deadline = time.perf_counter() + args.duration
    started_at = time.perf_counter()
    await asyncio.gather(*(
        worker(host, port, targets, authorization, args.timeout, deadline,
               latencies, latencies_by_target, statuses, errors, reconnects)
        for _ in range(args.concurrency)
    ))
    elapsed = time.perf_counter() - started_at

    total = len(latencies)
    success = sum(count for status, count in statuses.items() if 200 <= status < 300)
    success_rate = success / total * 100 if total else 0.0
    p95 = percentile(latencies, 95)
    print(f"url={args.url}")
    print(
        f"concurrency={args.concurrency} duration={elapsed:.1f}s total={total} "
        f"rps={total / elapsed:.1f} reconnects={reconnects[1]}"
    )
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
    if len(targets) > 1:
        for target in targets:
            values = latencies_by_target[target]
            print(
                f"target={target} total={len(values)} "
                f"p50={percentile(values, 50):.1f} p95={percentile(values, 95):.1f}"
            )

    failed = success_rate < args.min_success_rate or (args.max_p95_ms > 0 and p95 > args.max_p95_ms)
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="固定并发 HTTP 压测（keep-alive）")
    parser.add_argument("--url", required=True)
    parser.add_argument("--paths", default="", help="逗号分隔的混合路径，如 /api/courses,/api/questions")
    parser.add_argument("--token-file", default="")
    parser.add_argument("--concurrency", type=int, default=100)
    parser.add_argument("--duration", type=int, default=60, help="持续秒数")
    parser.add_argument("--timeout", type=float, default=30.0, help="单请求超时秒数")
    parser.add_argument("--warmup", type=int, default=0, help="预热秒数（不计入统计）")
    parser.add_argument("--min-success-rate", type=float, default=0.0)
    parser.add_argument("--max-p95-ms", type=float, default=0.0, help="0 表示不校验")
    return asyncio.run(run_load(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
