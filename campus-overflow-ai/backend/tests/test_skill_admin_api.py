# T-22B：工作流 skill 管理接口（SK-R01～R04）——权限、版本递增、发布回滚与归档。
import logging

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.modules.identity.models import User

SKILLS_URL = "/api/governance/skills"


def _user(db: Session, username: str, role: str = "admin", status: str = "active") -> User:
    user = User(
        username=username,
        email=f"{username}@example.com",
        password_hash="unused",
        role=role,
        status=status,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _auth(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id, user.role)}"}


def _create(client: TestClient, admin: User, **patch) -> dict:
    body = {
        "name": "治理巡检复用路径",
        "task_type": "moderation_scan",
        "content": {"steps": ["读取现状"], "checks": ["工单不重复"]},
    }
    body.update(patch)
    resp = client.post(SKILLS_URL, headers=_auth(admin), json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def test_only_active_admin_can_manage(
    client: TestClient, db_session: Session,
) -> None:
    student = _user(db_session, "skill_student", role="student")
    banned = _user(db_session, "skill_banned_admin", status="banned")
    assert client.get(SKILLS_URL, headers=_auth(student)).status_code == 403
    assert client.post(
        SKILLS_URL, headers=_auth(student),
        json={"name": "x", "task_type": "moderation_scan", "content": {"steps": ["a"]}},
    ).status_code == 403
    assert client.get(SKILLS_URL, headers=_auth(banned)).status_code == 403


def test_create_makes_draft_and_logs_audit(
    client: TestClient, db_session: Session, caplog: pytest.LogCaptureFixture,
) -> None:
    admin = _user(db_session, "skill_admin_create")
    with caplog.at_level(logging.INFO, logger="app.action"):
        skill = _create(client, admin, course_id=7)

    assert skill["status"] == "draft"
    assert skill["current_version"] is None
    assert skill["course_id"] == 7
    detail = client.get(f"{SKILLS_URL}/{skill['id']}", headers=_auth(admin)).json()["data"]
    assert [(row["version"], row["status"]) for row in detail["versions"]] == [(1, "draft")]
    assert "skill action=create" in caplog.text


def test_publish_and_edit_increments_version(
    client: TestClient, db_session: Session,
) -> None:
    admin = _user(db_session, "skill_admin_version")
    skill = _create(client, admin)

    published = client.post(
        f"{SKILLS_URL}/{skill['id']}/publish", headers=_auth(admin), json={},
    ).json()["data"]
    assert published["status"] == "active"
    assert published["current_version"] == 1

    edited = client.put(
        f"{SKILLS_URL}/{skill['id']}", headers=_auth(admin),
        json={"content": {"steps": ["读取现状", "复核"], "checks": ["工单不重复"]}},
    ).json()["data"]
    # 编辑只改草稿，当前注入版本不变
    assert edited["current_version"] == 1
    detail = client.get(f"{SKILLS_URL}/{skill['id']}", headers=_auth(admin)).json()["data"]
    versions = {row["version"]: row for row in detail["versions"]}
    assert versions[1]["status"] == "published"
    assert versions[2]["status"] == "draft"
    assert versions[2]["content"]["steps"] == ["读取现状", "复核"]

    republished = client.post(
        f"{SKILLS_URL}/{skill['id']}/publish", headers=_auth(admin), json={},
    ).json()["data"]
    assert republished["current_version"] == 2


def test_publish_explicit_draft_version_is_rejected(
    client: TestClient, db_session: Session,
) -> None:
    admin = _user(db_session, "skill_admin_draft_publish")
    skill = _create(client, admin)
    resp = client.post(
        f"{SKILLS_URL}/{skill['id']}/publish", headers=_auth(admin), json={"version": 1},
    )
    assert resp.status_code == 400
    assert resp.json()["message"] == "只能回滚到已发布版本"


def test_rollback_to_previous_published_version(
    client: TestClient, db_session: Session,
) -> None:
    admin = _user(db_session, "skill_admin_rollback")
    skill = _create(client, admin)
    url = f"{SKILLS_URL}/{skill['id']}"
    client.post(f"{url}/publish", headers=_auth(admin), json={})
    client.put(
        url, headers=_auth(admin), json={"content": {"steps": ["新路径"]}},
    )
    assert client.post(f"{url}/publish", headers=_auth(admin), json={}).json()[
        "data"
    ]["current_version"] == 2

    rolled = client.post(
        f"{url}/publish", headers=_auth(admin), json={"version": 1},
    ).json()["data"]
    assert rolled["current_version"] == 1
    assert rolled["status"] == "active"


def test_archive_keeps_versions_and_blocks_changes(
    client: TestClient, db_session: Session,
) -> None:
    admin = _user(db_session, "skill_admin_archive")
    skill = _create(client, admin)
    url = f"{SKILLS_URL}/{skill['id']}"
    client.post(f"{url}/publish", headers=_auth(admin), json={})

    archived = client.delete(url, headers=_auth(admin)).json()["data"]
    assert archived["status"] == "archived"
    versions = client.get(f"{url}/versions", headers=_auth(admin)).json()["data"]
    assert versions["total"] == 1
    assert versions["items"][0]["status"] == "published"

    assert client.put(
        url, headers=_auth(admin), json={"content": {"steps": ["不应写入"]}},
    ).status_code == 400
    assert client.post(
        f"{url}/status", headers=_auth(admin), json={"status": "active"},
    ).status_code == 400
    assert client.post(f"{url}/publish", headers=_auth(admin), json={}).status_code == 400


def test_enable_requires_published_version(
    client: TestClient, db_session: Session,
) -> None:
    admin = _user(db_session, "skill_admin_status")
    skill = _create(client, admin)
    url = f"{SKILLS_URL}/{skill['id']}"

    assert client.post(
        f"{url}/status", headers=_auth(admin), json={"status": "active"},
    ).status_code == 400

    client.post(f"{url}/publish", headers=_auth(admin), json={})
    disabled = client.post(
        f"{url}/status", headers=_auth(admin), json={"status": "disabled"},
    ).json()["data"]
    assert disabled["status"] == "disabled"
    enabled = client.post(
        f"{url}/status", headers=_auth(admin), json={"status": "active"},
    ).json()["data"]
    assert enabled["status"] == "active"


def test_skill_not_found_and_list_filter(
    client: TestClient, db_session: Session,
) -> None:
    admin = _user(db_session, "skill_admin_list")
    assert client.get(f"{SKILLS_URL}/999", headers=_auth(admin)).status_code == 404
    assert client.put(
        f"{SKILLS_URL}/999", headers=_auth(admin), json={"name": "x"},
    ).status_code == 404

    _create(client, admin, name="草稿 skill")
    published = _create(client, admin, name="启用 skill")
    client.post(
        f"{SKILLS_URL}/{published['id']}/publish", headers=_auth(admin), json={},
    )

    active = client.get(
        SKILLS_URL, headers=_auth(admin), params={"status": "active"},
    ).json()["data"]
    assert [item["name"] for item in active["items"]] == ["启用 skill"]
    assert active["total"] == 1
