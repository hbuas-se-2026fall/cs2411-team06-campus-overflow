# 运行记录归档与清理的数据访问（T-16-D）：只返回普通字典，不向运维脚本暴露 ORM 实体
from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.modules.governance.models import AgentRun, AgentRunEvent, ToolCallLog

# 只清理已结束的运行；running 可能仍在执行，必须保留
FINISHED_RUN_STATUSES = ("succeeded", "failed")


def count_expired_runs(db: Session, before: datetime) -> int:
    """统计创建时间早于 before 的已结束运行数量（dry-run 用）。"""
    stmt = select(func.count()).select_from(AgentRun).where(
        AgentRun.status.in_(FINISHED_RUN_STATUSES),
        AgentRun.created_at < before,
    )
    return int(db.execute(stmt).scalar_one())


def list_expired_run_ids(db: Session, before: datetime, limit: int) -> list[str]:
    """按创建时间升序取一批待清理运行标识。"""
    stmt = (
        select(AgentRun.agent_run_id)
        .where(AgentRun.status.in_(FINISHED_RUN_STATUSES), AgentRun.created_at < before)
        .order_by(AgentRun.created_at, AgentRun.id)
        .limit(limit)
    )
    return list(db.execute(stmt).scalars().all())


def collect_archive_rows(db: Session, run_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """读取一批运行的原始行，供归档脚本序列化（datetime 由调用方转字符串）。"""
    if not run_ids:
        return {"runs": [], "events": [], "tool_calls": []}
    runs = db.execute(
        select(AgentRun.__table__).where(AgentRun.agent_run_id.in_(run_ids))
    ).mappings().all()
    events = db.execute(
        select(AgentRunEvent.__table__)
        .where(AgentRunEvent.agent_run_id.in_(run_ids))
        .order_by(AgentRunEvent.agent_run_id, AgentRunEvent.sequence_no)
    ).mappings().all()
    tool_calls = db.execute(
        select(ToolCallLog.__table__)
        .where(ToolCallLog.agent_run_id.in_(run_ids))
        .order_by(ToolCallLog.agent_run_id, ToolCallLog.id)
    ).mappings().all()
    return {
        "runs": [dict(row) for row in runs],
        "events": [dict(row) for row in events],
        "tool_calls": [dict(row) for row in tool_calls],
    }


def delete_run_batch(db: Session, run_ids: list[str]) -> tuple[int, int, int]:
    """按外键顺序删除一批运行及其事件/工具调用，返回 (runs, events, tool_calls) 行数。"""
    if not run_ids:
        return (0, 0, 0)
    events = db.execute(
        delete(AgentRunEvent).where(AgentRunEvent.agent_run_id.in_(run_ids))
    ).rowcount or 0
    tool_calls = db.execute(
        delete(ToolCallLog).where(ToolCallLog.agent_run_id.in_(run_ids))
    ).rowcount or 0
    runs = db.execute(
        delete(AgentRun).where(AgentRun.agent_run_id.in_(run_ids))
    ).rowcount or 0
    return (runs, events, tool_calls)
