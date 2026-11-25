# T-15-E：edit（要求修改）动作——置标记/通知、作者编辑清除、评论拒绝、申诉撤销清除。
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.modules.governance.models import ModerationCase
from app.modules.identity.models import User
from app.modules.qa.models import Answer, Comment, Question


def _admin(db: Session) -> User:
    user = User(
        username="t15e_admin", email="t15e_admin@example.com",
        password_hash="unused", role="admin",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _student(db: Session) -> User:
    user = User(
        username="t15e_student", email="t15e_student@example.com",
        password_hash="unused", role="student",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _auth(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id, user.role)}"}


def _case(db: Session, target_type: str, target_id: int) -> ModerationCase:
    case = ModerationCase(
        target_type=target_type, target_id=target_id, risk_level="medium",
        source="admin", reason="要求作者修改", snapshot="{}", status="pending",
    )
    db.add(case)
    db.commit()
    db.refresh(case)
    return case


def _question(db: Session, author: User) -> Question:
    question = Question(
        title="待修改标题", body="待修改正文", course_id=1, author_id=author.id,
    )
    db.add(question)
    db.commit()
    db.refresh(question)
    return question


def test_edit_marks_question_and_author_edit_clears(
    client: TestClient, db_session: Session,
) -> None:
    """管理员要求修改：工单 executed、内容仍可见、标记置位；作者编辑后自动清除。"""
    admin, student = _admin(db_session), _student(db_session)
    question = _question(db_session, student)
    case = _case(db_session, "question", question.id)

    resp = client.post(
        f"/api/governance/moderation/cases/{case.id}/resolve",
        headers=_auth(admin),
        json={"decision": "edit", "manager_feedback": "请补充来源并修改措辞"},
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["status"] == "executed"
    assert data["resolution"] == "edit"

    db_session.expire_all()
    stored = db_session.query(Question).filter(Question.id == question.id).one()
    assert stored.needs_revision is True
    assert stored.is_hidden is False and stored.deleted_at is None

    edited = client.patch(
        f"/api/questions/{question.id}", headers=_auth(student),
        json={"body": "已按要求修改后的正文"},
    )
    assert edited.status_code == 200
    db_session.expire_all()
    stored = db_session.query(Question).filter(Question.id == question.id).one()
    assert stored.needs_revision is False


def test_edit_answer_sets_flag(client: TestClient, db_session: Session) -> None:
    """回答目标同样支持要求修改。"""
    admin, student = _admin(db_session), _student(db_session)
    question = _question(db_session, student)
    answer = Answer(body="待修改回答", question_id=question.id, author_id=student.id)
    db_session.add(answer)
    db_session.commit()
    db_session.refresh(answer)
    case = _case(db_session, "answer", answer.id)

    resp = client.post(
        f"/api/governance/moderation/cases/{case.id}/resolve",
        headers=_auth(admin),
        json={"decision": "edit", "manager_feedback": "请修改回答"},
    )
    assert resp.status_code == 200
    db_session.expire_all()
    assert db_session.query(Answer).filter(Answer.id == answer.id).one().needs_revision is True


def test_edit_rejects_comment_target(client: TestClient, db_session: Session) -> None:
    """评论无作者编辑流程，要求修改返回 400。"""
    admin, student = _admin(db_session), _student(db_session)
    question = _question(db_session, student)
    comment = Comment(body="待修改评论", question_id=question.id, author_id=student.id)
    db_session.add(comment)
    db_session.commit()
    db_session.refresh(comment)
    case = _case(db_session, "comment", comment.id)

    resp = client.post(
        f"/api/governance/moderation/cases/{case.id}/resolve",
        headers=_auth(admin),
        json={"decision": "edit", "manager_feedback": "请修改评论"},
    )
    assert resp.status_code == 400
    db_session.expire_all()
    assert db_session.query(ModerationCase).filter(
        ModerationCase.id == case.id,
    ).one().status == "pending"


def test_appeal_accepted_clears_edit_flag(
    client: TestClient, db_session: Session,
) -> None:
    """申诉复核撤销 edit：清除 needs_revision，工单保持 executed 终态。"""
    admin, student = _admin(db_session), _student(db_session)
    question = _question(db_session, student)
    case = _case(db_session, "question", question.id)
    client.post(
        f"/api/governance/moderation/cases/{case.id}/resolve",
        headers=_auth(admin),
        json={"decision": "edit", "manager_feedback": "请修改"},
    )
    db_session.expire_all()
    stored = db_session.query(Question).filter(Question.id == question.id).one()
    assert stored.needs_revision is True

    appeal = client.post(
        "/api/appeals", headers=_auth(student),
        json={"reason": "我已按管理员要求修改了标题与正文内容，请复核并撤销要求修改标记"},
    )
    assert appeal.status_code == 200, appeal.text
    appeal_id = appeal.json()["data"]["id"]

    resolved = client.post(
        f"/api/governance/appeals/{appeal_id}/resolve",
        headers=_auth(admin),
        json={"resolution": "accepted", "resolution_note": "撤销要求修改"},
    )
    assert resolved.status_code == 200
    db_session.expire_all()
    stored = db_session.query(Question).filter(Question.id == question.id).one()
    assert stored.needs_revision is False
    assert db_session.query(ModerationCase).filter(
        ModerationCase.id == case.id,
    ).one().status == "executed"
