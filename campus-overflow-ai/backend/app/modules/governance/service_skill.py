# 工作流 skill 管理服务（T-22B / SK-R01～R04）：管理员 CRUD、发布与回滚、启停、归档。
# AI 不直接调用本层发布；所有写操作由管理员接口触发并写审计摘要。
from sqlalchemy.orm import Session

from app.core.logging import action_logger
from app.modules.governance import domain, repository_skill
from app.modules.governance.schemas_skill import (
    SkillCreateRequest,
    SkillDetailOut,
    SkillOut,
    SkillPublishRequest,
    SkillUpdateRequest,
    SkillVersionOut,
)


def create_skill(db: Session, req: SkillCreateRequest, admin_id: int) -> SkillOut:
    """创建草稿：生成 version 1 草稿，发布前不参与注入。"""
    row = repository_skill.create_skill(
        db,
        name=req.name,
        task_type=req.task_type,
        course_id=req.course_id,
        content=req.content.model_dump(),
        created_by=admin_id,
    )
    db.commit()
    action_logger.info(
        "skill action=create skill_id=%s task_type=%s admin_id=%s",
        row["id"], row["task_type"], admin_id,
    )
    return SkillOut.model_validate(row)


def list_skills(
    db: Session,
    page: int,
    page_size: int,
    status: str | None = None,
    task_type: str | None = None,
    course_id: int | None = None,
) -> tuple[list[SkillOut], int]:
    rows, total = repository_skill.list_skills(
        db, page, page_size, status, task_type, course_id
    )
    return [SkillOut.model_validate(row) for row in rows], total


def get_skill_detail(db: Session, skill_id: int) -> SkillDetailOut:
    """详情含全部历史版本，便于管理员回看与回滚。"""
    skill = _require_skill(db, skill_id)
    versions = repository_skill.list_versions(db, skill_id)
    return SkillDetailOut.model_validate({**skill, "versions": versions})


def list_skill_versions(db: Session, skill_id: int) -> list[SkillVersionOut]:
    _require_skill(db, skill_id)
    return [
        SkillVersionOut.model_validate(row)
        for row in repository_skill.list_versions(db, skill_id)
    ]


def update_skill(
    db: Session, skill_id: int, req: SkillUpdateRequest, admin_id: int,
) -> SkillOut:
    """编辑元数据与草稿：已发布版本内容不变，改动落到草稿（无草稿则新建版本）。"""
    skill = _require_skill(db, skill_id)
    _ensure_not_archived(skill)

    changes: dict = {}
    if "name" in req.model_fields_set and req.name is not None:
        changes["name"] = req.name
    if "task_type" in req.model_fields_set and req.task_type is not None:
        changes["task_type"] = req.task_type
    if "course_id" in req.model_fields_set:
        changes["course_id"] = req.course_id
    repository_skill.update_skill(
        db, skill_id, changes=changes, updated_by=admin_id
    )
    version_row = None
    if req.content is not None:
        version_row = repository_skill.update_or_create_draft(
            db, skill_id, content=req.content.model_dump(), updated_by=admin_id
        )
    db.commit()
    action_logger.info(
        "skill action=update skill_id=%s fields=%s draft_version=%s admin_id=%s",
        skill_id, ",".join(sorted(changes)) or "none",
        version_row["version"] if version_row else "none", admin_id,
    )
    updated = repository_skill.get_skill(db, skill_id)
    return SkillOut.model_validate(updated)


def publish_skill(
    db: Session, skill_id: int, req: SkillPublishRequest, admin_id: int,
) -> SkillOut:
    """发布当前草稿；指定 version 时回滚到已发布版本（版本信息不改写）。"""
    skill = _require_skill(db, skill_id)
    _ensure_not_archived(skill)

    if req.version is not None:
        version = repository_skill.get_version(db, skill_id, req.version)
        if version is None:
            raise domain.SkillNotFoundError("skill 版本不存在")
        if version["status"] != "published":
            raise domain.SkillStateError("只能回滚到已发布版本")
        row = repository_skill.set_current_version(
            db, skill_id, req.version, updated_by=admin_id
        )
        action = "rollback"
        target_version = req.version
    else:
        draft = repository_skill.get_latest_draft(db, skill_id)
        if draft is None:
            raise domain.SkillStateError("没有待发布草稿")
        row = repository_skill.publish_version(
            db, skill_id, draft["version"], published_by=admin_id
        )
        action = "publish"
        target_version = draft["version"]

    db.commit()
    action_logger.info(
        "skill action=%s skill_id=%s version=%s admin_id=%s",
        action, skill_id, target_version, admin_id,
    )
    return SkillOut.model_validate(row)


def set_skill_status(
    db: Session, skill_id: int, status: str, admin_id: int,
) -> SkillOut:
    """启停：启用前必须已有发布版本，否则注入无内容可读。"""
    skill = _require_skill(db, skill_id)
    _ensure_not_archived(skill)
    if status == "active" and skill["current_version"] is None:
        raise domain.SkillStateError("尚未发布任何版本，不能启用")
    row = repository_skill.set_status(db, skill_id, status, updated_by=admin_id)
    db.commit()
    action_logger.info(
        "skill action=status skill_id=%s status=%s admin_id=%s",
        skill_id, status, admin_id,
    )
    return SkillOut.model_validate(row)


def archive_skill(db: Session, skill_id: int, admin_id: int) -> SkillOut:
    """归档代替删除：版本行与历史运行引用保留。"""
    _require_skill(db, skill_id)
    row = repository_skill.set_status(db, skill_id, "archived", updated_by=admin_id)
    db.commit()
    action_logger.info(
        "skill action=archive skill_id=%s admin_id=%s", skill_id, admin_id
    )
    return SkillOut.model_validate(row)


def _require_skill(db: Session, skill_id: int) -> dict:
    skill = repository_skill.get_skill(db, skill_id)
    if skill is None:
        raise domain.SkillNotFoundError("skill 不存在")
    return skill


def _ensure_not_archived(skill: dict) -> None:
    if skill["status"] == "archived":
        raise domain.SkillStateError("已归档 skill 不可再修改")


# ---------- 内部只读（T-22C / SK-R03）：Agent 规划前的历史有效路径 ----------


def list_injectable_skills(
    db: Session, *, task_type: str, course_id: int | None = None,
) -> list[dict]:
    """返回 active 且已发布固定版本的元数据与摘要；空结果表示无可注入 skill。"""
    rows = repository_skill.list_active_published(
        db, task_type=task_type, course_id=course_id
    )
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "task_type": row["task_type"],
            "course_id": row["course_id"],
            "version": row["version"],
            "summary": _skill_summary(row["content"]),
            "step_count": len(_steps(row["content"])),
        }
        for row in rows
    ]


def get_injectable_version(
    db: Session, skill_id: int, version: int,
) -> dict | None:
    """仅当前注入版本可读；skill 停用或已切换版本时返回 None。"""
    row = repository_skill.get_active_published_version(db, skill_id, version)
    if row is None:
        return None
    return {
        "skill_id": row["skill_id"],
        "version": row["version"],
        "content": row["content"],
    }


def _steps(content: object) -> list[str]:
    steps = content.get("steps") if isinstance(content, dict) else None
    if not isinstance(steps, list):
        return []
    return [str(step) for step in steps]


def _skill_summary(content: object) -> str:
    """摘要只取前两步，降低列表响应体积；完整步骤走版本详情接口。"""
    steps = _steps(content)
    return ("；".join(steps[:2]) if steps else "（无步骤摘要）")[:200]
