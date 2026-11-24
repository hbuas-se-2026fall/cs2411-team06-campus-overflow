# T-17 N-05：增量同步接口——服务 token、id 游标、更新时间过滤、软删/隐藏排除。
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.modules.identity.models import User
from app.modules.qa.models import Question

SERVICE = {"X-Service-Token": settings.agent_service_token}
PAST = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()


def _user(db: Session, username: str) -> User:
    user = User(
        username=username, email=f"{username}@example.com",
        password_hash="unused", role="student",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _question(db: Session, author: User, title: str, **fields: object) -> Question:
    question = Question(title=title, body="正文", course_id=1, author_id=author.id, **fields)
    db.add(question)
    db.commit()
    db.refresh(question)
    return question


def test_sync_requires_service_token(client: TestClient) -> None:
    assert client.get(
        "/internal/agent/sync/questions", params={"updated_after": PAST},
    ).status_code == 401


def test_sync_excludes_hidden_and_deleted_with_cursor(
    client: TestClient, db_session: Session,
) -> None:
    author = _user(db_session, "n05_student")
    first = _question(db_session, author, "问题一")
    second = _question(db_session, author, "问题二")
    _question(db_session, author, "已隐藏", is_hidden=True)
    _question(
        db_session, author, "已删除",
        deleted_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )

    page1 = client.get(
        "/internal/agent/sync/questions",
        params={"updated_after": PAST, "limit": 1}, headers=SERVICE,
    )
    assert page1.status_code == 200
    data1 = page1.json()["data"]
    assert [item["id"] for item in data1["items"]] == [first.id]
    assert data1["has_more"] is True
    assert data1["next_cursor"] == first.id
    assert "body" not in data1["items"][0]

    page2 = client.get(
        "/internal/agent/sync/questions",
        params={"updated_after": PAST, "cursor": data1["next_cursor"], "limit": 10},
        headers=SERVICE,
    )
    data2 = page2.json()["data"]
    assert [item["id"] for item in data2["items"]] == [second.id]
    assert data2["has_more"] is False


def test_sync_filters_by_updated_after(client: TestClient, db_session: Session) -> None:
    author = _user(db_session, "n05_time")
    _question(db_session, author, "旧问题")
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    result = client.get(
        "/internal/agent/sync/questions",
        params={"updated_after": future}, headers=SERVICE,
    )
    assert result.status_code == 200
    assert result.json()["data"]["items"] == []
