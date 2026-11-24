# T-17 N-04：MCP 调用审计——服务 token 写入、管理员分页筛选、字段边界与越权。
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.modules.identity.models import User

SERVICE = {"X-Service-Token": settings.agent_service_token}


def _user(db: Session, username: str, role: str = "student") -> User:
    user = User(
        username=username, email=f"{username}@example.com",
        password_hash="unused", role=role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _auth(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id, user.role)}"}


def _record(**overrides: object) -> dict:
    body = {
        "client_name": "campus-portal", "tool_name": "search_questions",
        "status": "succeeded", "args_summary": '{"keyword":"死锁","limit":10}',
        "result_summary": "3 条结果", "duration_ms": 12, "trace_id": "mcp-trace-1",
    }
    body.update(overrides)
    return body


def test_mcp_call_requires_service_token(client: TestClient) -> None:
    assert client.post("/internal/agent/mcp/calls", json=_record()).status_code == 401


def test_record_and_admin_filter(client: TestClient, db_session: Session) -> None:
    admin = _user(db_session, "n04_admin", "admin")
    ok = client.post("/internal/agent/mcp/calls", json=_record(), headers=SERVICE)
    assert ok.status_code == 200
    assert ok.json()["data"]["status"] == "succeeded"
    client.post("/internal/agent/mcp/calls", json=_record(
        tool_name="list_tags", status="denied", error_summary="scope 不足",
    ), headers=SERVICE)

    listed = client.get(
        "/api/governance/mcp/calls", headers=_auth(admin),
        params={"tool_name": "list_tags", "status": "denied"},
    )
    assert listed.status_code == 200
    data = listed.json()["data"]
    assert data["total"] == 1
    assert data["items"][0]["tool_name"] == "list_tags"
    assert data["items"][0]["client_name"] == "campus-portal"
    assert data["items"][0]["error_summary"] == "scope 不足"


def test_admin_only_and_length_bounds(client: TestClient, db_session: Session) -> None:
    student = _user(db_session, "n04_student")
    assert client.get("/api/governance/mcp/calls", headers=_auth(student)).status_code == 403
    too_long = client.post(
        "/internal/agent/mcp/calls", json=_record(args_summary="x" * 201), headers=SERVICE,
    )
    assert too_long.status_code == 400
