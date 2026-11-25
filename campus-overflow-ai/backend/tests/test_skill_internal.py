# T-22C 内部只读：Agent 拉取 active 且已发布固定版本的 skill（SK-R03）。
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.modules.governance.models import WorkflowSkill, WorkflowSkillVersion

AUTH = {"X-Service-Token": settings.agent_service_token}


def _skill(
    db: Session,
    *,
    name: str,
    task_type: str = "moderation_scan",
    status: str = "active",
    current_version: int | None = 1,
    course_id: int | None = None,
) -> WorkflowSkill:
    skill = WorkflowSkill(
        name=name,
        task_type=task_type,
        course_id=course_id,
        status=status,
        current_version=current_version,
    )
    db.add(skill)
    db.flush()
    db.add(
        WorkflowSkillVersion(
            skill_id=skill.id,
            version=1,
            content={
                "conditions": ["命中同一目标"],
                "steps": ["读取现状", "核对版本", "记录检查"],
                "tips": ["先复核工单"],
                "checks": ["不重复建单"],
                "max_tokens": 1200,
            },
            status="published",
        )
    )
    db.commit()
    db.refresh(skill)
    return skill


def test_internal_skill_requires_service_token(client: TestClient) -> None:
    resp = client.get(
        "/internal/agent/skills", params={"task_type": "moderation_scan"}
    )
    assert resp.status_code == 401


def test_list_only_active_published_and_scoped_by_course(
    client: TestClient, db_session: Session,
) -> None:
    _skill(db_session, name="全局路径", course_id=None)
    _skill(db_session, name="课程路径", course_id=7)
    _skill(db_session, name="其他课程", course_id=8)
    _skill(db_session, name="停用路径", status="disabled")
    _skill(db_session, name="草稿路径", status="draft", current_version=None)

    scoped = client.get(
        "/internal/agent/skills",
        params={"task_type": "moderation_scan", "course_id": 7},
        headers=AUTH,
    ).json()["data"]["items"]
    assert [item["name"] for item in scoped] == ["全局路径", "课程路径"]
    assert scoped[0]["summary"] == "读取现状；核对版本"
    assert scoped[0]["step_count"] == 3
    assert scoped[0]["version"] == 1

    global_only = client.get(
        "/internal/agent/skills",
        params={"task_type": "moderation_scan"},
        headers=AUTH,
    ).json()["data"]["items"]
    assert [item["name"] for item in global_only] == ["全局路径"]


def test_detail_only_serves_current_published_version(
    client: TestClient, db_session: Session,
) -> None:
    skill = _skill(db_session, name="详情路径")
    url = f"/internal/agent/skills/{skill.id}/versions/1"
    detail = client.get(url, headers=AUTH).json()["data"]
    assert detail["skill_id"] == skill.id
    assert detail["content"]["steps"] == ["读取现状", "核对版本", "记录检查"]

    assert client.get(
        f"/internal/agent/skills/{skill.id}/versions/2", headers=AUTH
    ).status_code == 404

    skill.status = "disabled"
    db_session.commit()
    assert client.get(url, headers=AUTH).status_code == 404
