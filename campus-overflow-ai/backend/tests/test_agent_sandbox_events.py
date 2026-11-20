"""P0-4 沙箱审计持久化：系统级事件、契约校验与 trace 回落。"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.modules.governance.models import AgentSandboxEvent

SERVICE = {"X-Service-Token": settings.agent_service_token}


def payload(**overrides) -> dict:
    body = {
        "event": "sandbox_exec",
        "outcome": "completed",
        "tool": "agent-browser",
        "executable": "agent-browser-win32-x64.exe",
        "command_digest": "0123456789abcdef",
        "arg_count": 7,
        "action_class": "read",
        "network_mode": "loopback",
        "trace_id": None,
        "duration_ms": 42,
        "output_bytes": 1024,
    }
    body.update(overrides)
    return body


def post_event(client: TestClient, headers: dict | None = None, **overrides):
    return client.post(
        "/internal/agent/sandbox/events",
        headers=SERVICE if headers is None else headers,
        json=payload(**overrides),
    )


def test_event_is_persisted_with_header_trace(client: TestClient, db_session: Session) -> None:
    headers = {**SERVICE, "X-Trace-Id": "trace-sandbox"}
    response = post_event(client, headers)
    assert response.status_code == 200
    assert response.json()["data"]["id"] > 0
    row = db_session.query(AgentSandboxEvent).one()
    assert row.outcome == "completed"
    assert row.tool == "agent-browser"
    assert row.executable == "agent-browser-win32-x64.exe"
    assert row.command_digest == "0123456789abcdef"
    assert row.arg_count == 7
    assert row.network_mode == "loopback"
    assert row.reason_code is None
    assert row.trace_id == "trace-sandbox"


def test_body_trace_wins_over_header(client: TestClient, db_session: Session) -> None:
    headers = {**SERVICE, "X-Trace-Id": "header-trace"}
    assert post_event(client, headers, trace_id="body-trace").status_code == 200
    assert db_session.query(AgentSandboxEvent).one().trace_id == "body-trace"


def test_denied_event_keeps_reason_code(client: TestClient, db_session: Session) -> None:
    response = post_event(
        client, outcome="denied", reason_code="executable_denied",
        executable="bash", duration_ms=0, output_bytes=0,
    )
    assert response.status_code == 200
    row = db_session.query(AgentSandboxEvent).one()
    assert (row.outcome, row.reason_code) == ("denied", "executable_denied")


def test_service_token_is_required(client: TestClient, db_session: Session) -> None:
    assert post_event(client, headers={}).status_code == 401
    assert post_event(client, headers={"X-Service-Token": "wrong"}).status_code == 401
    assert db_session.query(AgentSandboxEvent).count() == 0


@pytest.mark.parametrize(
    "overrides",
    [
        {"user_id": 1},
        {"role": "admin"},
        {"outcome": "completed", "reason_code": "timeout"},
        {"outcome": "failed", "reason_code": None},
        {"outcome": "skipped"},
        {"executable": "C:\\Windows\\system32\\cmd.exe"},
        {"executable": "/usr/bin/bash"},
        {"command_digest": "not-a-digest"},
        {"command_digest": "0123456789ABCDEF"},
        {"arg_count": -1},
        {"duration_ms": -1},
        {"network_mode": "open"},
        {"action_class": "delete"},
        {"reason_code": "unknown_reason"},
        {"trace_id": ""},
        {"trace_id": "t" * 65},
    ],
)
def test_contract_rejects_invalid_events(
    client: TestClient, db_session: Session, overrides: dict,
) -> None:
    assert post_event(client, **overrides).status_code == 400
    assert db_session.query(AgentSandboxEvent).count() == 0
