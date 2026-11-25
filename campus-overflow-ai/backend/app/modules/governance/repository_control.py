"""运行控制状态与命令（T-21A / RC-R01～R04）。

权威状态在后端：管理员操作递增 revision 并追加命令，Agent 按 revision 拉取并 ack。
仓储层只返回普通字典，不向服务层暴露 ORM 实体。
"""

import hashlib
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.governance.models import AgentRunCommand, AgentRunControl

PAUSE_TIMEOUT_MINUTES = 30
VALID_ACTIONS = ("pause", "resume", "cancel", "guidance")


class RevisionConflict(Exception):
    """revision 不匹配：并发控制命令只能有一个生效。"""

    def __init__(self, current_revision: int):
        self.current_revision = current_revision
        super().__init__(f"revision 冲突，当前为 {current_revision}")


def get_or_create_control(db: Session, run_id: str) -> AgentRunControl:
    control = db.get(AgentRunControl, run_id)
    if control is None:
        control = AgentRunControl(agent_run_id=run_id, state="running", revision=0)
        db.add(control)
        db.flush()
    return control


def get_control(db: Session, run_id: str) -> dict | None:
    control = db.get(AgentRunControl, run_id)
    if control is None:
        return None
    return _control_row(control)


def apply_action(
    db: Session,
    *,
    run_id: str,
    action: str,
    expected_revision: int,
    requested_by: int,
    trace_id: str = "",
    guidance_text: str | None = None,
    now: datetime | None = None,
) -> dict:
    """应用一次控制命令；revision 不匹配抛 RevisionConflict，调用方负责回滚。"""
    if action not in VALID_ACTIONS:
        raise ValueError(f"不支持的控制动作：{action}")
    current = now or datetime.now()
    control = (
        db.execute(
            select(AgentRunControl)
            .where(AgentRunControl.agent_run_id == run_id)
            .with_for_update()
        )
        .scalars()
        .first()
    )
    if control is None:
        control = AgentRunControl(agent_run_id=run_id, state="running", revision=0)
        db.add(control)
        db.flush()
    if control.revision != expected_revision:
        raise RevisionConflict(control.revision)

    if action == "pause":
        control.state = "paused"
        control.pause_deadline = current + timedelta(minutes=PAUSE_TIMEOUT_MINUTES)
    elif action == "resume":
        control.state = "running"
        control.pause_deadline = None
    elif action == "cancel":
        control.state = "cancelled"
        control.pause_deadline = None

    control.revision += 1
    control.updated_by = requested_by
    control.updated_at = current
    digest = None
    if action == "guidance" and guidance_text:
        digest = hashlib.sha256(guidance_text.encode("utf-8")).hexdigest()[:16]
    command = AgentRunCommand(
        agent_run_id=run_id,
        revision=control.revision,
        action=action,
        guidance_text=guidance_text,
        guidance_digest=digest,
        status="pending",
        requested_by=requested_by,
        trace_id=trace_id,
    )
    db.add(command)
    db.flush()
    return {"control": _control_row(control), "command": _command_row(command)}


def list_pending_commands(db: Session, run_id: str, since_revision: int = 0) -> list[dict]:
    rows = db.execute(
        select(AgentRunCommand)
        .where(
            AgentRunCommand.agent_run_id == run_id,
            AgentRunCommand.status == "pending",
            AgentRunCommand.revision > since_revision,
        )
        .order_by(AgentRunCommand.revision)
    ).scalars().all()
    return [_command_row(row) for row in rows]


def ack_commands(db: Session, run_id: str, command_ids: list[int]) -> int:
    """标记已消费并清空引导正文；重复 ack 不报错，返回本次实际更新数。"""
    if not command_ids:
        return 0
    rows = db.execute(
        select(AgentRunCommand).where(
            AgentRunCommand.agent_run_id == run_id,
            AgentRunCommand.id.in_(command_ids),
            AgentRunCommand.status == "pending",
        )
    ).scalars().all()
    now = datetime.now()
    for row in rows:
        row.status = "applied"
        row.applied_at = now
        row.guidance_text = None
    db.flush()
    return len(rows)


def expire_paused_runs(db: Session, now: datetime | None = None) -> int:
    """超过暂停期限的运行自动取消；返回受影响数量，命令由后续接口补齐。"""
    current = now or datetime.now()
    rows = db.execute(
        select(AgentRunControl).where(
            AgentRunControl.state == "paused",
            AgentRunControl.pause_deadline.is_not(None),
            AgentRunControl.pause_deadline < current,
        )
    ).scalars().all()
    for row in rows:
        row.state = "cancelled"
        row.pause_deadline = None
        row.revision += 1
        row.updated_at = current
    db.flush()
    return len(rows)


def _control_row(control: AgentRunControl) -> dict:
    return {
        "agent_run_id": control.agent_run_id,
        "state": control.state,
        "revision": control.revision,
        "pause_deadline": control.pause_deadline,
        "updated_by": control.updated_by,
        "updated_at": control.updated_at,
    }


def _command_row(command: AgentRunCommand) -> dict:
    return {
        "id": command.id,
        "agent_run_id": command.agent_run_id,
        "revision": command.revision,
        "action": command.action,
        "guidance_text": command.guidance_text,
        "guidance_digest": command.guidance_digest,
        "status": command.status,
        "requested_by": command.requested_by,
        "trace_id": command.trace_id,
        "created_at": command.created_at,
        "applied_at": command.applied_at,
    }
