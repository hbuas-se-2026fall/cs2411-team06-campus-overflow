# 工作流 skill 数据访问（T-22B / SK-R01～R04）。
# 分层基线 D-2：本文件是 skill 表允许 import models 的仓储；出参只暴露普通字典。
# 版本递增与发布在同一 skill 行锁内完成，避免并发覆盖；归档只改 status，不删版本。
from datetime import datetime

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.modules.governance.models import WorkflowSkill, WorkflowSkillVersion


def create_skill(
    db: Session,
    *,
    name: str,
    task_type: str,
    course_id: int | None,
    content: dict,
    created_by: int,
) -> dict:
    """创建 skill 与 version 1 草稿。"""
    skill = WorkflowSkill(
        name=name,
        task_type=task_type,
        course_id=course_id,
        status="draft",
        current_version=None,
        created_by=created_by,
        updated_by=created_by,
    )
    db.add(skill)
    db.flush()
    db.add(
        WorkflowSkillVersion(
            skill_id=skill.id,
            version=1,
            content=content,
            status="draft",
            created_by=created_by,
        )
    )
    db.flush()
    return _skill_row(skill)


def get_skill(db: Session, skill_id: int) -> dict | None:
    skill = db.get(WorkflowSkill, skill_id)
    return _skill_row(skill) if skill else None


def list_skills(
    db: Session,
    page: int,
    page_size: int,
    status: str | None = None,
    task_type: str | None = None,
    course_id: int | None = None,
) -> tuple[list[dict], int]:
    conditions = []
    if status is not None:
        conditions.append(WorkflowSkill.status == status)
    if task_type is not None:
        conditions.append(WorkflowSkill.task_type == task_type)
    if course_id is not None:
        conditions.append(WorkflowSkill.course_id == course_id)
    total = db.execute(
        select(func.count()).select_from(WorkflowSkill).where(*conditions)
    ).scalar_one()
    rows = (
        db.execute(
            select(WorkflowSkill)
            .where(*conditions)
            .order_by(WorkflowSkill.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    return [_skill_row(row) for row in rows], int(total)


def update_skill(
    db: Session, skill_id: int, *, changes: dict, updated_by: int,
) -> dict | None:
    skill = _lock_skill(db, skill_id)
    if skill is None:
        return None
    for field, value in changes.items():
        setattr(skill, field, value)
    skill.updated_by = updated_by
    db.flush()
    return _skill_row(skill)


def get_latest_draft(db: Session, skill_id: int) -> dict | None:
    row = (
        db.execute(
            select(WorkflowSkillVersion)
            .where(
                WorkflowSkillVersion.skill_id == skill_id,
                WorkflowSkillVersion.status == "draft",
            )
            .order_by(WorkflowSkillVersion.version.desc())
        )
        .scalars()
        .first()
    )
    return _version_row(row) if row else None


def update_or_create_draft(
    db: Session, skill_id: int, *, content: dict, updated_by: int,
) -> dict | None:
    """有草稿则原地更新，没有草稿则新建 max+1 版本；锁 skill 行串行化版本递增。"""
    skill = _lock_skill(db, skill_id)
    if skill is None:
        return None
    draft = (
        db.execute(
            select(WorkflowSkillVersion)
            .where(
                WorkflowSkillVersion.skill_id == skill_id,
                WorkflowSkillVersion.status == "draft",
            )
            .order_by(WorkflowSkillVersion.version.desc())
        )
        .scalars()
        .first()
    )
    if draft is None:
        latest = db.execute(
            select(func.max(WorkflowSkillVersion.version)).where(
                WorkflowSkillVersion.skill_id == skill_id
            )
        ).scalar()
        draft = WorkflowSkillVersion(
            skill_id=skill_id,
            version=int(latest or 0) + 1,
            content=content,
            status="draft",
            created_by=updated_by,
        )
        db.add(draft)
    else:
        draft.content = content
    skill.updated_by = updated_by
    db.flush()
    return _version_row(draft)


def get_version(db: Session, skill_id: int, version: int) -> dict | None:
    row = db.get(WorkflowSkillVersion, (skill_id, version))
    return _version_row(row) if row else None


def list_versions(db: Session, skill_id: int) -> list[dict]:
    rows = (
        db.execute(
            select(WorkflowSkillVersion)
            .where(WorkflowSkillVersion.skill_id == skill_id)
            .order_by(WorkflowSkillVersion.version.desc())
        )
        .scalars()
        .all()
    )
    return [_version_row(row) for row in rows]


def publish_version(
    db: Session,
    skill_id: int,
    version: int,
    *,
    published_by: int,
    now: datetime | None = None,
) -> dict | None:
    """发布草稿版本并置为 current_version；同一 skill 行锁内完成。"""
    skill = _lock_skill(db, skill_id)
    if skill is None:
        return None
    row = db.get(WorkflowSkillVersion, (skill_id, version))
    if row is None:
        return None
    current = now or datetime.now()
    row.status = "published"
    row.published_by = published_by
    row.published_at = current
    skill.current_version = version
    skill.status = "active"
    skill.updated_by = published_by
    db.flush()
    return _skill_row(skill)


def set_current_version(
    db: Session, skill_id: int, version: int, *, updated_by: int,
) -> dict | None:
    """回滚：切换 current_version 到已发布版本，不改写该版本发布信息。"""
    skill = _lock_skill(db, skill_id)
    if skill is None:
        return None
    skill.current_version = version
    skill.status = "active"
    skill.updated_by = updated_by
    db.flush()
    return _skill_row(skill)


def set_status(
    db: Session, skill_id: int, status: str, *, updated_by: int,
) -> dict | None:
    """启停与归档共用；归档不删除任何版本行。"""
    skill = _lock_skill(db, skill_id)
    if skill is None:
        return None
    skill.status = status
    skill.updated_by = updated_by
    db.flush()
    return _skill_row(skill)


def list_active_published(
    db: Session, *, task_type: str, course_id: int | None = None,
) -> list[dict]:
    """内部注入只读：active 且 current_version 已发布的固定版本。

    有 course_id 时返回「该课程 + 全局」，否则仅全局；不返回其他课程 skill。
    """
    conditions = [
        WorkflowSkill.status == "active",
        WorkflowSkill.current_version.is_not(None),
        WorkflowSkill.task_type == task_type,
        WorkflowSkillVersion.status == "published",
    ]
    if course_id is None:
        conditions.append(WorkflowSkill.course_id.is_(None))
    else:
        conditions.append(
            or_(WorkflowSkill.course_id.is_(None), WorkflowSkill.course_id == course_id)
        )
    rows = db.execute(
        select(WorkflowSkill, WorkflowSkillVersion)
        .join(
            WorkflowSkillVersion,
            and_(
                WorkflowSkillVersion.skill_id == WorkflowSkill.id,
                WorkflowSkillVersion.version == WorkflowSkill.current_version,
            ),
        )
        .where(*conditions)
        .order_by(WorkflowSkill.id.asc())
    ).all()
    return [
        {
            **_skill_row(skill),
            "version": version.version,
            "content": version.content,
        }
        for skill, version in rows
    ]


def get_active_published_version(
    db: Session, skill_id: int, version: int,
) -> dict | None:
    """内部详情只读：只允许读取当前注入版本，避免发布切换期间读到半更新内容。"""
    row = db.execute(
        select(WorkflowSkill, WorkflowSkillVersion)
        .join(
            WorkflowSkillVersion,
            and_(
                WorkflowSkillVersion.skill_id == WorkflowSkill.id,
                WorkflowSkillVersion.version == WorkflowSkill.current_version,
            ),
        )
        .where(
            WorkflowSkill.id == skill_id,
            WorkflowSkill.status == "active",
            WorkflowSkill.current_version == version,
            WorkflowSkillVersion.status == "published",
        )
    ).first()
    if row is None:
        return None
    _skill, stored = row
    return {
        "skill_id": stored.skill_id,
        "version": stored.version,
        "content": stored.content,
    }


def _lock_skill(db: Session, skill_id: int) -> WorkflowSkill | None:
    return (
        db.execute(
            select(WorkflowSkill)
            .where(WorkflowSkill.id == skill_id)
            .with_for_update()
        )
        .scalars()
        .first()
    )


def _skill_row(skill: WorkflowSkill) -> dict:
    return {
        "id": skill.id,
        "name": skill.name,
        "task_type": skill.task_type,
        "course_id": skill.course_id,
        "status": skill.status,
        "current_version": skill.current_version,
        "created_by": skill.created_by,
        "updated_by": skill.updated_by,
        "created_at": skill.created_at,
        "updated_at": skill.updated_at,
    }


def _version_row(row: WorkflowSkillVersion) -> dict:
    return {
        "skill_id": row.skill_id,
        "version": row.version,
        "content": row.content,
        "source_run_id": row.source_run_id,
        "status": row.status,
        "created_by": row.created_by,
        "published_by": row.published_by,
        "published_at": row.published_at,
        "created_at": row.created_at,
    }
