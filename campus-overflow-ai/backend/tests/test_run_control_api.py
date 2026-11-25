# T-21B：运行控制管理与内部接口（RC-R01～R05）——权限、revision 冲突、引导与 ack。
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.modules.governance import repository
from app.modules.identity.models import User

CONTROL_URL = "/api/governance/agent-runs/{}/control"
GUIDANCE_URL = "/api/governance/agent-runs/{}/guidance"
INTERNAL_URL = "/internal/agent/runs/{}/control"
ACK_URL = "/internal/agent/runs/{}/control/ack"


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


def _service() -> dict:
    return {"X-Service-Token": settings.agent_service_token}


def _run(db: Session, run_id: str, task_type: str = "moderation_scan", user_id: int | None = None):
    repository.create_run(db, task_type, f"trace-{run_id}", run_id, "摘要", user_id=user_id)
    db.commit()


@pytest.fixture(autouse=True)
def _enable_control(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "run_control_enabled", True)


def test_control_disabled_returns_409(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """开关关闭时管理端写接口明确不可用（T-21F 行为不变）。"""
    monkeypatch.setattr(settings, "run_control_enabled", False)
    admin = _create_user(db_session, "admin_off", role="admin")
    _run(db_session, "run-off")
    resp = client.post(
        CONTROL_URL.format("run-off"), headers=_auth(admin),
        json={"action": "pause", "expected_revision": 0},
    )
    assert resp.status_code == 409
    assert resp.json()["message"] == "运行控制功能未启用"


def test_non_admin_forbidden(client: TestClient, db_session: Session) -> None:
    """学生不能控制任何运行（RC-R05）。"""
    student = _create_user(db_session, "student_ctl")
    _run(db_session, "run-student-denied")
    resp = client.post(
        CONTROL_URL.format("run-student-denied"), headers=_auth(student),
        json={"action": "pause", "expected_revision": 0},
    )
    assert resp.status_code == 403


def test_run_not_found(client: TestClient, db_session: Session) -> None:
    admin = _create_user(db_session, "admin_404", role="admin")
    resp = client.post(
        CONTROL_URL.format("missing-run"), headers=_auth(admin),
        json={"action": "pause", "expected_revision": 0},
    )
    assert resp.status_code == 404


def test_internal_read_lazily_expires_overdue_pause(
    client: TestClient, db_session: Session,
) -> None:
    """暂停超过 30 分钟：Agent 拉取时惰性判定为 cancelled 并拿到系统取消命令。"""
    from datetime import datetime, timedelta

    from app.modules.governance import repository_control

    admin = _create_user(db_session, "admin_lazy", role="admin")
    _run(db_session, "run-lazy")
    repository_control.apply_action(
        db_session, run_id="run-lazy", action="pause", expected_revision=0,
        requested_by=admin.id, now=datetime.now() - timedelta(minutes=31),
    )
    db_session.commit()

    data = client.get(INTERNAL_URL.format("run-lazy"), headers=_service()).json()["data"]
    assert data["state"] == "cancelled"
    assert data["revision"] == 2
    assert [(item["action"], item["requested_by"]) for item in data["commands"]] == [
        ("pause", admin.id),
        ("cancel", None),
    ]


def test_student_chat_not_controllable(client: TestClient, db_session: Session) -> None:
    """学生聊天与教学任务不可被管理员干预（RC-R05）。"""
    admin = _create_user(db_session, "admin_scope", role="admin")
    student = _create_user(db_session, "student_chat")
    _run(db_session, "run-student-chat", task_type="chat", user_id=student.id)
    resp = client.post(
        CONTROL_URL.format("run-student-chat"), headers=_auth(admin),
        json={"action": "pause", "expected_revision": 0},
    )
    assert resp.status_code == 400
    assert "仅治理任务与管理员聊天" in resp.json()["message"]


def test_admin_chat_controllable(client: TestClient, db_session: Session) -> None:
    """管理员自己的聊天可以暂停（RC-R01 范围）。"""
    admin = _create_user(db_session, "admin_chat", role="admin")
    _run(db_session, "run-admin-chat", task_type="chat", user_id=admin.id)
    resp = client.post(
        CONTROL_URL.format("run-admin-chat"), headers=_auth(admin),
        json={"action": "pause", "expected_revision": 0},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["state"] == "paused"


def test_pause_guidance_ack_flow(client: TestClient, db_session: Session) -> None:
    """暂停 → 引导 → 内部拉取 → ack 幂等，正文消费后清空。"""
    admin = _create_user(db_session, "admin_flow", role="admin")
    _run(db_session, "run-flow")
    headers = _auth(admin)

    paused = client.post(
        CONTROL_URL.format("run-flow"), headers=headers,
        json={"action": "pause", "expected_revision": 0},
    )
    assert paused.status_code == 200
    assert paused.json()["data"]["state"] == "paused"
    assert paused.json()["data"]["revision"] == 1
    assert paused.json()["data"]["pause_deadline"] is not None

    guided = client.post(
        GUIDANCE_URL.format("run-flow"), headers=headers,
        json={"guidance_text": "先核对课程范围再处置", "expected_revision": 1},
    )
    assert guided.status_code == 200
    assert guided.json()["data"]["revision"] == 2

    pulled = client.get(
        INTERNAL_URL.format("run-flow"), headers=_service(),
        params={"since_revision": 0},
    )
    assert pulled.status_code == 200
    data = pulled.json()["data"]
    assert data["enabled"] is True and data["state"] == "paused"
    assert [cmd["action"] for cmd in data["commands"]] == ["pause", "guidance"]
    guidance = data["commands"][1]
    assert guidance["guidance_text"] == "先核对课程范围再处置"
    assert guidance["guidance_digest"]

    ids = [cmd["id"] for cmd in data["commands"]]
    acked = client.post(
        ACK_URL.format("run-flow"), headers=_service(), json={"command_ids": ids},
    )
    assert acked.status_code == 200
    assert acked.json()["data"]["applied"] == 2

    again = client.post(
        ACK_URL.format("run-flow"), headers=_service(), json={"command_ids": ids},
    )
    assert again.json()["data"]["applied"] == 0

    empty = client.get(
        INTERNAL_URL.format("run-flow"), headers=_service(),
        params={"since_revision": 0},
    )
    assert empty.json()["data"]["commands"] == []


def test_revision_conflict_returns_409(client: TestClient, db_session: Session) -> None:
    """并发控制命令只能有一个生效（RC-R02）。"""
    admin = _create_user(db_session, "admin_conflict", role="admin")
    _run(db_session, "run-conflict")
    resp = client.post(
        CONTROL_URL.format("run-conflict"), headers=_auth(admin),
        json={"action": "pause", "expected_revision": 7},
    )
    assert resp.status_code == 409
    assert "当前版本为 0" in resp.json()["message"]


def test_approval_waiting_run_cannot_pause(client: TestClient, db_session: Session) -> None:
    """审批等待中的运行不允许暂停（R-002 默认值）。"""
    admin = _create_user(db_session, "admin_wait", role="admin")
    _run(db_session, "run-wait")
    repository.create_agent_case(
        db_session, "question", 1, "high", "等待审批", "{}", "trace-wait",
        "run-wait", "[t] actor=agent status=pending",
    )
    db_session.commit()
    resp = client.post(
        CONTROL_URL.format("run-wait"), headers=_auth(admin),
        json={"action": "pause", "expected_revision": 0},
    )
    assert resp.status_code == 400
    assert "审批等待" in resp.json()["message"]


def test_guidance_requires_paused(client: TestClient, db_session: Session) -> None:
    admin = _create_user(db_session, "admin_running", role="admin")
    _run(db_session, "run-running")
    resp = client.post(
        GUIDANCE_URL.format("run-running"), headers=_auth(admin),
        json={"guidance_text": "补充说明", "expected_revision": 0},
    )
    assert resp.status_code == 400
    assert "仅暂停中的运行" in resp.json()["message"]


def test_internal_control_requires_service_token(client: TestClient, db_session: Session) -> None:
    _run(db_session, "run-token")
    assert client.get(INTERNAL_URL.format("run-token")).status_code == 401
    assert client.post(
        ACK_URL.format("run-token"), json={"command_ids": [1]},
    ).status_code == 401


def test_internal_empty_when_disabled(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """关闭时 Agent 拉取到 enabled=false 且无命令，保持现状继续。"""
    monkeypatch.setattr(settings, "run_control_enabled", False)
    _run(db_session, "run-disabled")
    resp = client.get(INTERNAL_URL.format("run-disabled"), headers=_service())
    assert resp.status_code == 200
    assert resp.json()["data"]["enabled"] is False
    assert resp.json()["data"]["commands"] == []


def test_missing_guidance_text_rejected(client: TestClient, db_session: Session) -> None:
    """空引导词由入参校验拒绝（422 归一为 400）。"""
    admin = _create_user(db_session, "admin_blank", role="admin")
    _run(db_session, "run-blank")
    client.post(
        CONTROL_URL.format("run-blank"), headers=_auth(admin),
        json={"action": "pause", "expected_revision": 0},
    )
    resp = client.post(
        GUIDANCE_URL.format("run-blank"), headers=_auth(admin),
        json={"guidance_text": " ", "expected_revision": 1},
    )
    assert resp.status_code == 400
