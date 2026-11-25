# T-16-D 运行记录归档与清理：只清理已结束运行、默认先归档、dry-run 不写不删
import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.modules.governance.models import AgentRun, AgentRunEvent, ToolCallLog
from app.ops.agent_runs_retention import purge_expired_runs


def _add_run(db: Session, run_id: str, status: str, days_ago: int) -> None:
    created = datetime.now() - timedelta(days=days_ago)
    db.add(AgentRun(
        task_type="similar_questions",
        trace_id=f"trace-{run_id}",
        agent_run_id=run_id,
        input_summary="用户任务：similar_questions",
        status=status,
        created_at=created,
        updated_at=created,
    ))
    db.add(AgentRunEvent(
        agent_run_id=run_id, sequence_no=1, event_type="plan", plan_revision=1,
        trace_id=f"trace-{run_id}",
    ))
    db.add(ToolCallLog(
        agent_run_id=run_id, tool_name="search_questions", status="success",
        trace_id=f"trace-{run_id}",
    ))
    db.commit()


def _ids(db: Session) -> set[str]:
    return {row.agent_run_id for row in db.query(AgentRun).all()}


def test_purge_archives_then_deletes_expired_finished_runs(db_session: Session, tmp_path):
    _add_run(db_session, "old-ok", "succeeded", 120)
    _add_run(db_session, "old-failed", "failed", 100)
    _add_run(db_session, "recent", "succeeded", 3)
    _add_run(db_session, "still-running", "running", 100)

    before = datetime.now() - timedelta(days=90)
    result = purge_expired_runs(db_session, before=before, archive_dir=str(tmp_path))

    assert result["deleted"] == {"runs": 2, "events": 2, "tool_calls": 2}
    assert _ids(db_session) == {"recent", "still-running"}
    # 保留的 recent 与 still-running 各自的事件/工具调用仍在
    assert db_session.query(AgentRunEvent).count() == 2
    assert db_session.query(ToolCallLog).count() == 2

    files = list(tmp_path.glob("agent_runs_*.jsonl"))
    assert len(files) == 1
    lines = [json.loads(line) for line in files[0].read_text(encoding="utf-8").splitlines()]
    archived = {line["agent_run"]["agent_run_id"]: line for line in lines}
    assert set(archived) == {"old-ok", "old-failed"}
    assert archived["old-ok"]["events"][0]["event_type"] == "plan"
    assert archived["old-ok"]["tool_calls"][0]["tool_name"] == "search_questions"


def test_dry_run_counts_without_writing_or_deleting(db_session: Session, tmp_path):
    _add_run(db_session, "old-ok", "succeeded", 120)

    result = purge_expired_runs(
        db_session, before=datetime.now() - timedelta(days=90),
        archive_dir=str(tmp_path), dry_run=True,
    )

    assert result["dry_run"] is True
    assert result["expired_runs"] == 1
    assert _ids(db_session) == {"old-ok"}
    assert not list(tmp_path.glob("*.jsonl"))


def test_refuses_to_delete_without_archive_unless_explicitly_allowed(db_session: Session, tmp_path):
    _add_run(db_session, "old-ok", "succeeded", 120)
    before = datetime.now() - timedelta(days=90)

    with pytest.raises(RuntimeError):
        purge_expired_runs(db_session, before=before)
    assert _ids(db_session) == {"old-ok"}

    result = purge_expired_runs(db_session, before=before, purge_without_archive=True)
    assert result["deleted"]["runs"] == 1
    assert _ids(db_session) == set()
    assert not list(tmp_path.glob("*.jsonl"))


def test_second_purge_is_noop(db_session: Session, tmp_path):
    _add_run(db_session, "old-ok", "succeeded", 120)
    before = datetime.now() - timedelta(days=90)

    purge_expired_runs(db_session, before=before, archive_dir=str(tmp_path))
    again = purge_expired_runs(db_session, before=before, archive_dir=str(tmp_path))

    assert again["deleted"] == {"runs": 0, "events": 0, "tool_calls": 0}
