# T-21A 运行控制仓储：revision fencing、命令追加/消费、暂停超时收敛
from datetime import datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.modules.governance import repository_control as repo


def test_pause_sets_state_deadline_and_pending_command(db_session: Session):
    now = datetime(2026, 11, 25, 10, 0, 0)

    result = repo.apply_action(
        db_session, run_id="run-1", action="pause", expected_revision=0,
        requested_by=9, trace_id="trace-1", now=now,
    )

    control = result["control"]
    assert control["state"] == "paused"
    assert control["revision"] == 1
    assert control["pause_deadline"] == now + timedelta(minutes=30)
    assert result["command"]["action"] == "pause"
    assert result["command"]["status"] == "pending"


def test_revision_conflict_reports_current_revision(db_session: Session):
    repo.apply_action(
        db_session, run_id="run-1", action="pause", expected_revision=0, requested_by=9,
    )

    with pytest.raises(repo.RevisionConflict) as exc:
        repo.apply_action(
            db_session, run_id="run-1", action="resume", expected_revision=0, requested_by=9,
        )

    assert exc.value.current_revision == 1


def test_guidance_keeps_state_and_records_digest(db_session: Session):
    repo.apply_action(
        db_session, run_id="run-1", action="pause", expected_revision=0, requested_by=9,
    )

    result = repo.apply_action(
        db_session, run_id="run-1", action="guidance", expected_revision=1,
        requested_by=9, guidance_text="优先复核课程公告",
    )

    assert result["control"]["state"] == "paused"
    assert result["control"]["revision"] == 2
    assert len(result["command"]["guidance_digest"]) == 16
    assert result["command"]["guidance_text"] == "优先复核课程公告"


def test_list_and_ack_commands_is_idempotent(db_session: Session):
    first = repo.apply_action(
        db_session, run_id="run-1", action="pause", expected_revision=0, requested_by=9,
    )
    second = repo.apply_action(
        db_session, run_id="run-1", action="guidance", expected_revision=1,
        requested_by=9, guidance_text="先看置顶帖",
    )

    pending = repo.list_pending_commands(db_session, "run-1", since_revision=0)
    assert [row["revision"] for row in pending] == [1, 2]
    assert repo.list_pending_commands(db_session, "run-1", since_revision=1)[0]["revision"] == 2

    ids = [first["command"]["id"], second["command"]["id"]]
    assert repo.ack_commands(db_session, "run-1", ids) == 2
    assert repo.ack_commands(db_session, "run-1", ids) == 0
    assert repo.list_pending_commands(db_session, "run-1") == []

    rows = repo.list_pending_commands(db_session, "run-1")
    assert rows == []
    # 消费后正文清空，只留 digest
    from app.modules.governance.models import AgentRunCommand
    stored = db_session.get(AgentRunCommand, second["command"]["id"])
    assert stored.guidance_text is None
    assert stored.guidance_digest


def test_expire_paused_runs_only_cancels_overdue(db_session: Session):
    now = datetime(2026, 11, 25, 10, 0, 0)
    repo.apply_action(
        db_session, run_id="overdue", action="pause", expected_revision=0,
        requested_by=9, now=now,
    )
    repo.apply_action(
        db_session, run_id="fresh", action="pause", expected_revision=0,
        requested_by=9, now=now + timedelta(minutes=29),
    )

    changed = repo.expire_paused_runs(db_session, now=now + timedelta(minutes=31))

    assert changed == ["overdue"]
    assert repo.get_control(db_session, "overdue")["state"] == "cancelled"
    assert repo.get_control(db_session, "overdue")["pause_deadline"] is None
    assert repo.get_control(db_session, "fresh")["state"] == "paused"
    # 系统取消命令 requested_by 为空，Agent 据此把运行记录标记 pause_timeout
    commands = repo.list_pending_commands(db_session, "overdue", 0)
    assert [(row["action"], row["requested_by"], row["trace_id"]) for row in commands] == [
        ("pause", 9, ""),
        ("cancel", None, "system:pause_timeout"),
    ]
    assert repo.expire_paused_runs(db_session, now=now + timedelta(minutes=32)) == []


def test_two_instances_ack_same_batch_only_once(db_session: Session):
    """双实例共享状态：同一批命令只被一方消费（原子条件更新）。"""
    first = repo.apply_action(
        db_session, run_id="run-shared", action="pause", expected_revision=0, requested_by=9,
    )
    second = repo.apply_action(
        db_session, run_id="run-shared", action="guidance", expected_revision=1,
        requested_by=9, guidance_text="先看置顶帖",
    )
    db_session.commit()
    ids = [first["command"]["id"], second["command"]["id"]]
    engine = db_session.get_bind()
    with Session(bind=engine) as worker_a, Session(bind=engine) as worker_b:
        assert repo.ack_commands(worker_a, "run-shared", ids) == 2
        worker_a.commit()
        assert repo.ack_commands(worker_b, "run-shared", ids) == 0
        worker_b.commit()
    assert repo.list_pending_commands(db_session, "run-shared") == []
