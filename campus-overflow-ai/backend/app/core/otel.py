"""OTLP/HTTP JSON 追踪导出（T-16-C），默认关闭。

设计取舍：不引入 OpenTelemetry SDK 依赖，只在配置了
OTEL_EXPORTER_OTLP_ENDPOINT 时把每个 HTTP 请求导出为单个 span。
导出走后台队列，失败只写结构化日志，不影响业务响应；未配置时零开销。
"""

import hashlib
import json
import logging
import os
import queue
import threading
import time
import urllib.request
from typing import Any
from uuid import uuid4

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger(__name__)

EXPORT_TIMEOUT_SECONDS = 2.0
QUEUE_MAXSIZE = 1024
# 健康检查高频且无追踪价值，默认不导出
SKIP_PATHS = frozenset({"/health", "/api/health"})
# OTLP SpanKind：2 = SERVER
SPAN_KIND_SERVER = 2
# OTLP StatusCode：1 = OK，2 = ERROR
STATUS_OK = 1
STATUS_ERROR = 2

_queue: "queue.Queue[tuple[str, dict[str, Any]] | None]" = queue.Queue(maxsize=QUEUE_MAXSIZE)
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()


def exporter_endpoint() -> str:
    return os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()


def is_enabled() -> bool:
    return bool(exporter_endpoint())


def normalize_trace_id(raw: str) -> str:
    """OTLP trace id 必须是 32 位小写十六进制；非标准 trace id 以 sha256 稳定映射。"""
    value = (raw or "").strip().lower()
    if len(value) == 32 and all(char in "0123456789abcdef" for char in value):
        return value
    return hashlib.sha256((value or uuid4().hex).encode("utf-8")).hexdigest()[:32]


def _attribute(key: str, value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    return {"key": key, "value": {"stringValue": str(value)}}


def build_span_payload(
    *,
    name: str,
    trace_id: str,
    start_ns: int,
    end_ns: int,
    attributes: dict[str, Any],
    is_error: bool = False,
) -> dict[str, Any]:
    """构造单 span 的 OTLP/HTTP JSON 结构，便于直接单测。"""
    span = {
        "traceId": normalize_trace_id(trace_id),
        "spanId": hashlib.sha256(f"{trace_id}:{start_ns}".encode("utf-8")).hexdigest()[:16],
        "name": name,
        "kind": SPAN_KIND_SERVER,
        "startTimeUnixNano": str(start_ns),
        "endTimeUnixNano": str(end_ns),
        "attributes": [_attribute(key, value) for key, value in attributes.items()],
        "status": {"code": STATUS_ERROR if is_error else STATUS_OK},
    }
    service_name = os.environ.get("OTEL_SERVICE_NAME", "campusoverflow-backend")
    return {
        "resourceSpans": [{
            "resource": {"attributes": [_attribute("service.name", service_name)]},
            "scopeSpans": [{
                "scope": {"name": "campusoverflow.backend", "version": "0.2.0"},
                "spans": [span],
            }],
        }],
    }


def _post_otlp(endpoint: str, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/v1/traces",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=EXPORT_TIMEOUT_SECONDS):
        pass


_sender = _post_otlp


def _worker_loop() -> None:
    while True:
        item = _queue.get()
        try:
            if item is None:
                return
            endpoint, payload = item
            _sender(endpoint, payload)
        except Exception as error:  # noqa: BLE001 - 导出失败不得影响业务
            logger.warning(json.dumps({
                "event": "otel_export_failed", "error": type(error).__name__,
            }))
        finally:
            _queue.task_done()


def _ensure_worker() -> None:
    global _worker
    if _worker is not None and _worker.is_alive():
        return
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_worker_loop, name="otel-exporter", daemon=True)
            _worker.start()


def enqueue_span(payload: dict[str, Any]) -> None:
    endpoint = exporter_endpoint()
    if not endpoint:
        return
    _ensure_worker()
    try:
        _queue.put_nowait((endpoint, payload))
    except queue.Full:
        logger.warning(json.dumps({"event": "otel_export_dropped", "reason": "queue_full"}))


def flush(timeout: float = 3.0) -> bool:
    """等待后台队列清空；主要供运维脚本与测试使用。"""
    if _worker is None:
        return True
    done = threading.Event()

    def _wait() -> None:
        _queue.join()
        done.set()

    threading.Thread(target=_wait, daemon=True).start()
    return done.wait(timeout)


def record_http_span(
    *,
    method: str,
    path: str,
    status_code: int,
    duration_ms: int,
    trace_id: str,
    agent_run_id: str | None = None,
    is_error: bool | None = None,
) -> None:
    if not is_enabled():
        return
    end_ns = time.time_ns()
    start_ns = end_ns - int(duration_ms * 1_000_000)
    attributes: dict[str, Any] = {
        "http.method": method,
        "http.route": path,
        "http.status_code": status_code,
        "trace.id": trace_id,
    }
    if agent_run_id:
        attributes["agent_run.id"] = agent_run_id
    enqueue_span(build_span_payload(
        name=f"{method} {path}",
        trace_id=trace_id,
        start_ns=start_ns,
        end_ns=end_ns,
        attributes=attributes,
        is_error=status_code >= 500 if is_error is None else is_error,
    ))


class OtelTraceMiddleware(BaseHTTPMiddleware):
    """按请求导出 span；未配置端点时直接透传。"""

    async def dispatch(self, request: Request, call_next) -> Response:
        if not is_enabled() or request.url.path in SKIP_PATHS:
            return await call_next(request)
        trace_id = request.headers.get("x-trace-id") or uuid4().hex
        agent_run_id = request.headers.get("x-agent-run-id")
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            record_http_span(
                method=request.method, path=request.url.path, status_code=500,
                duration_ms=int((time.perf_counter() - started) * 1000),
                trace_id=trace_id, agent_run_id=agent_run_id, is_error=True,
            )
            raise
        record_http_span(
            method=request.method, path=request.url.path, status_code=response.status_code,
            duration_ms=int((time.perf_counter() - started) * 1000),
            trace_id=trace_id, agent_run_id=agent_run_id,
        )
        return response
