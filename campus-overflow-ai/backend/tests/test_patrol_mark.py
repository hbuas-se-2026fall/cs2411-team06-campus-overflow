# T-15-F：低风险内容级打标——内部写入幂等、管理员只读、缺失目标拒绝。
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.modules.identity.models import User
from app.modules.qa.models import Question

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


def _question(db: Session, author: User) -> Question:
    question = Question(title="低风险内容", body="正常讨论正文", course_id=1, author_id=author.id)
    db.add(question)
    db.commit()
    db.refresh(question)
    return question


def _mark(target_id: int, reason: str = "内容无风险") -> dict:
    return {
        "target_type": "question", "target_id": target_id,
        "risk_level": "low", "reason": reason, "agent_run_id": "patrol-run-1",
    }


def test_mark_requires_service_token(client: TestClient, db_session: Session) -> None:
    author = _user(db_session, "t15f_student")
    question = _question(db_session, author)
    assert client.post("/internal/agent/patrol/marks", json=_mark(question.id)).status_code == 401


def test_mark_upserts_and_admin_can_list(client: TestClient, db_session: Session) -> None:
    """同一目标重复打标只保留最新一条；管理员可读取。"""
    author = _user(db_session, "t15f_student")
    admin = _user(db_session, "t15f_admin", role="admin")
    question = _question(db_session, author)

    first = client.post("/internal/agent/patrol/marks", headers=SERVICE, json=_mark(question.id))
    assert first.status_code == 200
    assert first.json()["data"]["risk_level"] == "low"

    second = client.post(
        "/internal/agent/patrol/marks", headers=SERVICE,
        json=_mark(question.id, "复核后仍为低风险"),
    )
    assert second.status_code == 200
    assert second.json()["data"]["id"] == first.json()["data"]["id"]
    assert second.json()["data"]["reason"] == "复核后仍为低风险"

    listed = client.get("/api/governance/moderation/marks", headers=_auth(admin))
    assert listed.status_code == 200
    data = listed.json()["data"]
    assert data["total"] == 1
    assert data["items"][0]["target_id"] == question.id
    assert data["items"][0]["reason"] == "复核后仍为低风险"


def test_mark_rejects_missing_target(client: TestClient, db_session: Session) -> None:
    """目标不存在或不可见：409，不落标记。"""
    resp = client.post("/internal/agent/patrol/marks", headers=SERVICE, json=_mark(9999))
    assert resp.status_code == 409


def test_marks_list_requires_admin(client: TestClient, db_session: Session) -> None:
    student = _user(db_session, "t15f_student")
    assert client.get(
        "/api/governance/moderation/marks", headers=_auth(student),
    ).status_code == 403
