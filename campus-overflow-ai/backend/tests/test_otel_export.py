# T-16-C OTLP/HTTP 导出：默认关闭、trace 映射、后台失败不影响业务
import pytest
from fastapi.testclient import TestClient

from app.core import otel
from app.main import app


def _capture(monkeypatch) -> list[tuple[str, dict]]:
    captured: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        otel, "_sender", lambda endpoint, payload: captured.append((endpoint, payload))
    )
    return captured


def test_disabled_without_endpoint(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    captured = _capture(monkeypatch)

    assert otel.is_enabled() is False
    otel.record_http_span(
        method="GET", path="/api/questions", status_code=200,
        duration_ms=5, trace_id="trace-demo",
    )
    otel.flush(1.0)
    assert captured == []


def test_standard_trace_id_is_preserved():
    trace_id = "0123456789abcdef0123456789abcdef"
    assert otel.normalize_trace_id(trace_id) == trace_id
    assert len(otel.normalize_trace_id("trace-demo")) == 32


def test_build_span_payload(monkeypatch):
    monkeypatch.setenv("OTEL_SERVICE_NAME", "campusoverflow-test")
    payload = otel.build_span_payload(
        name="GET /api/questions",
        trace_id="trace-demo",
        start_ns=1_000,
        end_ns=2_000,
        attributes={"http.method": "GET", "http.status_code": 503, "retry": True},
        is_error=True,
    )
    span = payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    assert span["traceId"] == otel.normalize_trace_id("trace-demo")
    assert len(span["traceId"]) == 32 and len(span["spanId"]) == 16
    assert span["status"]["code"] == otel.STATUS_ERROR
    attributes = {item["key"]: item["value"] for item in span["attributes"]}
    assert attributes["http.method"] == {"stringValue": "GET"}
    assert attributes["retry"] == {"boolValue": True}
    resource = payload["resourceSpans"][0]["resource"]["attributes"][0]
    assert resource == {"key": "service.name", "value": {"stringValue": "campusoverflow-test"}}


def test_export_enqueues_single_span(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    captured = _capture(monkeypatch)

    otel.record_http_span(
        method="POST", path="/api/questions", status_code=200,
        duration_ms=12, trace_id="trace-demo", agent_run_id="run-1",
    )

    assert otel.flush(3.0) is True
    assert len(captured) == 1
    endpoint, payload = captured[0]
    assert endpoint == "http://collector:4318"
    span = payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    attributes = {item["key"]: item["value"] for item in span["attributes"]}
    assert attributes["agent_run.id"] == {"stringValue": "run-1"}
    assert span["status"]["code"] == otel.STATUS_OK


def test_sender_failure_is_swallowed(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")

    def boom(endpoint: str, payload: dict) -> None:
        raise RuntimeError("collector down")

    monkeypatch.setattr(otel, "_sender", boom)
    otel.record_http_span(
        method="GET", path="/api/questions", status_code=200,
        duration_ms=1, trace_id="trace-demo",
    )
    # 导出线程吞掉异常，队列仍能正常清空
    assert otel.flush(3.0) is True


def test_middleware_exports_request_and_skips_health(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    captured = _capture(monkeypatch)
    client = TestClient(app)

    client.get("/health", headers={"x-trace-id": "trace-health"})
    client.get(
        "/api/questions",
        headers={"x-trace-id": "trace-questions", "x-agent-run-id": "run-9"},
    )

    assert otel.flush(3.0) is True
    names = [item[1]["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["name"] for item in captured]
    assert names == ["GET /api/questions"]


@pytest.fixture(autouse=True)
def _reset_env(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    yield
