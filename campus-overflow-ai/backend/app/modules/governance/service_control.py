# 运行控制服务（T-21B / RC-R01～R05）：管理端下发命令 + 内部 Agent 拉取与 ack。
# 权威状态与 revision 在 repository_control；本层负责启用开关、范围校验与审计。
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import action_logger
from app.modules.governance import domain, repository, repository_control
from app.modules.governance.schemas_control import (
    InternalRunControlOut,
    RunCommandOut,
    RunControlOut,
)
from app.modules.identity import service as identity_service

# 可被人工控制的治理任务；学生/教师问答与教学任务不可干预（RC-R05）
GOVERNANCE_TASK_TYPES = ("moderation_scan",)
ADMIN_CHAT_TASK_TYPE = "chat"
# 审批等待中的运行不允许暂停（R-002 已确认默认值）
APPROVAL_WAIT_CASE_STATUSES = ("pending", "agent_proposed", "manager_directed")


def _ensure_enabled() -> None:
    if not settings.run_control_enabled:
        raise domain.RunControlDisabledError("运行控制功能未启用")


def _require_run(db: Session, run_id: str):
    run = repository.get_run_by_agent_run_id(db, run_id)
    if run is None:
        raise domain.RunNotFoundError()
    return run


def _ensure_target(db: Session, run) -> None:
    """只允许治理任务与管理员聊天；运行结束后不可再控制。"""
    if run.status != domain.RUN_STATUS_RUNNING:
        raise domain.RunControlStateError("运行已结束，不能控制")
    if run.task_type in GOVERNANCE_TASK_TYPES:
        return
    if run.task_type == ADMIN_CHAT_TASK_TYPE and run.user_id is not None:
        if identity_service.get_by_id(db, run.user_id).role == "admin":
            return
    raise domain.RunControlStateError("仅治理任务与管理员聊天支持运行控制")


def _ensure_not_waiting_approval(db: Session, run_id: str) -> None:
    case = repository.get_case_by_run_id(db, run_id)
    if case is not None and case.status in APPROVAL_WAIT_CASE_STATUSES:
        raise domain.RunControlStateError("审批等待中的运行不能暂停")


def get_admin_control(db: Session, run_id: str) -> RunControlOut:
    """管理端回显当前控制状态；无记录时按运行中、版本 0 返回。"""
    _require_run(db, run_id)
    control = repository_control.get_control(db, run_id)
    if control is None:
        return RunControlOut(agent_run_id=run_id, state="running", revision=0)
    return RunControlOut.model_validate(control)


def apply_control(
    db: Session, run_id: str, action: str, expected_revision: int, admin_id: int,
) -> RunControlOut:
    """暂停 / 继续 / 取消：revision 不匹配返回 409，成功后写审计。"""
    _ensure_enabled()
    run = _require_run(db, run_id)
    _ensure_target(db, run)
    if action == "pause":
        _ensure_not_waiting_approval(db, run_id)
    result = _apply(db, run_id, action, expected_revision, admin_id)
    action_logger.info(
        "run_control action=%s run_id=%s revision=%s admin_id=%s",
        action, run_id, result["control"]["revision"], admin_id,
    )
    return RunControlOut.model_validate(result["control"])


def add_guidance(
    db: Session, run_id: str, guidance_text: str, expected_revision: int, admin_id: int,
) -> RunControlOut:
    """暂停期间追加引导词；正文只在下发前保留，ack 后仅留 digest。"""
    _ensure_enabled()
    run = _require_run(db, run_id)
    _ensure_target(db, run)
    control = repository_control.get_control(db, run_id)
    if control is None or control["state"] != "paused":
        raise domain.RunControlStateError("仅暂停中的运行可以追加引导词")
    result = _apply(
        db, run_id, "guidance", expected_revision, admin_id, guidance_text=guidance_text,
    )
    action_logger.info(
        "run_control action=guidance run_id=%s revision=%s admin_id=%s digest=%s",
        run_id, result["control"]["revision"], admin_id,
        result["command"]["guidance_digest"],
    )
    return RunControlOut.model_validate(result["control"])


def _apply(
    db: Session, run_id: str, action: str, expected_revision: int, admin_id: int,
    guidance_text: str | None = None,
) -> dict:
    try:
        result = repository_control.apply_action(
            db,
            run_id=run_id,
            action=action,
            expected_revision=expected_revision,
            requested_by=admin_id,
            trace_id=f"admin-{admin_id}",
            guidance_text=guidance_text,
        )
    except repository_control.RevisionConflict as exc:
        db.rollback()
        raise domain.RunControlConflictError(exc.current_revision) from exc
    db.commit()
    return result


def read_internal_control(
    db: Session, run_id: str, since_revision: int = 0,
) -> InternalRunControlOut:
    """Agent 拉取控制状态与未消费命令；关闭时返回空命令，保持现状继续。"""
    _require_run(db, run_id)
    control = repository_control.get_control(db, run_id)
    enabled = settings.run_control_enabled
    commands: list[RunCommandOut] = []
    if enabled:
        commands = [
            RunCommandOut.model_validate(row)
            for row in repository_control.list_pending_commands(db, run_id, since_revision)
        ]
    return InternalRunControlOut(
        enabled=enabled,
        state=control["state"] if control else "running",
        revision=control["revision"] if control else 0,
        pause_deadline=control["pause_deadline"] if control else None,
        commands=commands,
    )


def ack_internal_control(db: Session, run_id: str, command_ids: list[int]) -> int:
    """Agent 已消费确认；关闭时直接返回 0，重复 ack 幂等。"""
    _require_run(db, run_id)
    if not settings.run_control_enabled:
        return 0
    applied = repository_control.ack_commands(db, run_id, command_ids)
    db.commit()
    return applied
