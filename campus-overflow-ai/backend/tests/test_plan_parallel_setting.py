# SA-07C：计划内并行全局开关（ADR-010）——管理员读写 + Agent 内部只读。
import secrets

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.modules.identity.models import User

SERVICE = {"X-Service-Token": settings.agent_service_token}
TEST_PASSWORD = secrets.token_urlsafe(12)


def _create_user(db: Session, username: str, role: str = "student") -> User:
    user = User(
        username=username,
        email=f"{username}@example.com",
        password_hash="unused",
        role=role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _auth(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id, user.role)}"}


def _admin(db: Session) -> User:
    return _create_user(db, "admin_settings", role="admin")


def test_default_off_when_never_written(client: TestClient, db_session: Session) -> None:
    """无记录时管理员与 Agent 都看到关闭。"""
    admin = _admin(db_session)
    admin_view = client.get("/api/governance/settings/plan-parallel", headers=_auth(admin))
    assert admin_view.status_code == 200
    assert admin_view.json()["data"] == {"plan_parallel_enabled": False, "updated_at": None}

    internal = client.get("/internal/agent/runtime-config", headers=SERVICE)
    assert internal.status_code == 200
    assert internal.json()["data"]["plan_parallel_enabled"] is False


def test_admin_toggle_persists_and_agent_sees_it(
    client: TestClient, db_session: Session,
) -> None:
    """管理员开启后落库，Agent 运行配置读到同一值。"""
    admin = _admin(db_session)
    updated = client.put(
        "/api/governance/settings/plan-parallel",
        headers=_auth(admin), json={"plan_parallel_enabled": True},
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["plan_parallel_enabled"] is True
    assert updated.json()["data"]["updated_at"] is not None

    reread = client.get("/api/governance/settings/plan-parallel", headers=_auth(admin))
    assert reread.json()["data"]["plan_parallel_enabled"] is True

    internal = client.get("/internal/agent/runtime-config", headers=SERVICE)
    assert internal.json()["data"]["plan_parallel_enabled"] is True

    client.put(
        "/api/governance/settings/plan-parallel",
        headers=_auth(admin), json={"plan_parallel_enabled": False},
    )
    assert client.get(
        "/internal/agent/runtime-config", headers=SERVICE,
    ).json()["data"]["plan_parallel_enabled"] is False


def test_non_admin_cannot_change_setting(client: TestClient, db_session: Session) -> None:
    """学生无权写开关，且读取也按管理员权限拒绝。"""
    student = _create_user(db_session, "student_settings")
    denied_write = client.put(
        "/api/governance/settings/plan-parallel",
        headers=_auth(student), json={"plan_parallel_enabled": True},
    )
    assert denied_write.status_code == 403
    assert client.get(
        "/api/governance/settings/plan-parallel", headers=_auth(student),
    ).status_code == 403


def test_runtime_config_requires_service_token(client: TestClient) -> None:
    """内部运行配置只对服务 token 开放。"""
    assert client.get("/internal/agent/runtime-config").status_code == 401
    assert client.get(
        "/internal/agent/runtime-config", headers={"X-Service-Token": "bad-token"},
    ).status_code == 401
