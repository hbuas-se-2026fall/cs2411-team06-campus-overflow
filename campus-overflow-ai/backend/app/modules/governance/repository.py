# governance 数据访问：agent_runs / tool_call_logs / agent_memory / moderation_cases
# 分层基线 D-2：本文件是模块内唯一允许 import models 的地方；出参一律 schemas。
# 事务约定 D-8：本层只 flush 不 commit，事务边界（commit）在 service 用例层。
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import and_, case, delete, desc, func, or_, select, update
from sqlalchemy.orm import Session

from app.modules.governance import domain
from app.modules.governance.models import (
    AgentChatStream,
    AgentChatStreamEvent,
    AgentExperience,
    AgentMemory,
    AgentRun,
    AgentRunEvent,
    AgentSandboxEvent,
    AgentSlotLease,
    AgentSlotWaiter,
    AnonymousLearningEvent,
    Appeal,
    ApprovalWait,
    ClassChangeRequest,
    CourseTagSource,
    GovernanceApprovalRequest,
    GovernanceExecutionJob,
    ModerationCase,
    PatrolNote,
    PatrolScanJob,
    PatrolWorkflowScan,
    PatrolWorkflowTask,
    ToolCallLog,
)
from app.modules.governance.schemas import (
    AgentRunOut,
    AppealOut,
    ApprovalWaitOut,
    ChatStreamEventAck,
    ChatStreamEventItem,
    ChatStreamOut,
    MemoryItemOut,
    ModerationCaseOut,
    PatrolNoteOut,
    RunEventOut,
    SandboxEventCreateRequest,
    SandboxEventOut,
    ToolCallOut,
)
from app.modules.governance.schemas_executions import GovernanceApprovalRecord, GovernanceJobRecord
from app.modules.governance.schemas_experiences import ExperienceOut
from app.modules.governance.schemas_learning import LearningEventOut, TrustedTagSourceOut
from app.modules.governance.schemas_roles import ClassChangeOut
from app.modules.governance.schemas_workflow import PatrolWorkflowOut


def get_governance_approval(
    db: Session, request_id: str | None = None, *, case_id: int | None = None,
    for_update: bool = False,
) -> GovernanceApprovalRecord | None:
    query = db.query(GovernanceApprovalRequest)
    if request_id:
        query = query.filter(GovernanceApprovalRequest.request_id == request_id)
    else:
        query = query.filter(GovernanceApprovalRequest.case_id == case_id)
    if for_update:
        query = query.with_for_update().populate_existing()
    row = query.first()
    if row is None:
        return None
    jobs = db.query(GovernanceExecutionJob).filter_by(request_id=row.request_id)
    if for_update:
        jobs = jobs.with_for_update().populate_existing()
    job = jobs.first()
    result = GovernanceApprovalRecord.model_validate(row)
    return result.model_copy(update={"execution_id": job.execution_id if job else None,
                                     "execution_state": job.state if job else None,
                                     "continuation": job.continuation if job else None,
                                     "executed": row.status == "executed"})


def create_governance_approval(db: Session, **values) -> GovernanceApprovalRecord:
    db.add(GovernanceApprovalRequest(**values))
    db.flush()
    return get_governance_approval(db, values["request_id"])


def decide_governance_approval(
    db: Session, request_id: str, status: str, reviewer_id: int, note: str,
) -> GovernanceApprovalRecord:
    row = db.get(GovernanceApprovalRequest, request_id)
    row.status, row.review_note = status, note
    if status == "approved":
        row.approved_by, row.approved_at = reviewer_id, datetime.now(UTC).replace(tzinfo=None)
        db.add(GovernanceExecutionJob(execution_id=str(uuid4()), request_id=request_id))
    elif status == "expired":
        case = db.get(ModerationCase, row.case_id, with_for_update=True)
        if case.status == "pending":
            case.status, case.resolved_at = "rejected", datetime.now()
            case.decision_trace = (case.decision_trace or "") + f"\nrequest={request_id} expired"
    db.flush()
    return get_governance_approval(db, request_id)


def get_governance_job(
    db: Session, execution_id: str, *, for_update: bool = False,
) -> GovernanceJobRecord | None:
    query = db.query(GovernanceExecutionJob).filter_by(execution_id=execution_id)
    if for_update:
        query = query.with_for_update().populate_existing()
    row = query.first()
    return GovernanceJobRecord.model_validate(row) if row else None


def finish_governance_execution(db: Session, execution_id: str, receipt: dict) -> None:
    job = db.get(GovernanceExecutionJob, execution_id)
    approval = db.get(GovernanceApprovalRequest, job.request_id)
    job.state, job.result = "completed", receipt
    approval.status = "executed"
    db.flush()


def claim_candidates(db: Session) -> list[str]:
    rows = db.query(GovernanceExecutionJob.execution_id).join(
        GovernanceApprovalRequest,
        GovernanceExecutionJob.request_id == GovernanceApprovalRequest.request_id,
    ).filter(
        GovernanceApprovalRequest.source_kind != "system_patrol",
        GovernanceExecutionJob.state.in_(["queued", "claimed", "completed"]),
        GovernanceExecutionJob.continuation.is_(None),
    ).order_by(
        GovernanceExecutionJob.created_at, GovernanceExecutionJob.execution_id,
    ).limit(100).all()
    return [row.execution_id for row in rows]


def save_execution_lease(db: Session, execution_id: str, digest: str, epoch: int, until: datetime):
    job = db.get(GovernanceExecutionJob, execution_id)
    job.lease_hash, job.lease_epoch, job.lease_expires_at = digest, epoch, until
    if job.result is None:
        job.state = "claimed"
    db.flush()


def save_execution_report(db: Session, execution_id: str, outcome: str) -> None:
    job = db.get(GovernanceExecutionJob, execution_id)
    job.continuation = {"version": 1,
                        "stage": "done" if outcome == "completed" else "manual_review",
                        "outcome": outcome, "execution_call_limit": 1, "proposal_limit": 1,
                        "lease_attempt_limit": 3, "result_check_limit": 3,
                        "lease_attempts": job.lease_epoch}
    if job.result is None:
        job.state = outcome
    db.flush()


def close_governance_approval(
    db: Session, request_id: str, status: str, actor_id: int | None, note: str,
) -> GovernanceApprovalRecord:
    row = db.get(GovernanceApprovalRequest, request_id)
    row.status, row.review_note = status, note
    job = db.query(GovernanceExecutionJob).filter_by(
        request_id=request_id,
    ).with_for_update().first()
    if job:
        job.state = "blocked"
        job.continuation = {"version": 1, "stage": "done", "outcome": status}
    case = db.get(ModerationCase, row.case_id, with_for_update=True, populate_existing=True)
    if case.status == "pending":
        case.status, case.resolved_by, case.resolved_at = "rejected", actor_id, datetime.now()
        case.decision_trace = (case.decision_trace or "") + f"\nactor={actor_id} {status}"
    db.flush()
    return get_governance_approval(db, request_id, for_update=True)


def block_governance_execution(db: Session, execution_id: str, status: str) -> None:
    job = db.get(GovernanceExecutionJob, execution_id)
    approval = db.get(GovernanceApprovalRequest, job.request_id)
    job.state = "blocked"
    if approval.status == "approved":
        approval.status = status
        case = db.get(
            ModerationCase, approval.case_id, with_for_update=True, populate_existing=True,
        )
        if case.status == "pending":
            case.status, case.resolved_at = "rejected", datetime.now()
            case.decision_trace = (
                (case.decision_trace or "") + f"\nexecution={execution_id} {status}"
            )
    db.flush()


def get_class_change(db: Session, request_id: str) -> ClassChangeOut | None:
    row = db.get(ClassChangeRequest, request_id, with_for_update=True, populate_existing=True)
    return ClassChangeOut.model_validate(row) if row else None


def create_class_change(db: Session, **values) -> ClassChangeOut:
    row = ClassChangeRequest(**values)
    db.add(row)
    db.flush()
    return ClassChangeOut.model_validate(row)


def finish_class_change(db: Session, request_id: str, status: str) -> ClassChangeOut:
    row = db.get(ClassChangeRequest, request_id)
    row.status = status
    db.flush()
    return ClassChangeOut.model_validate(row)


def list_trusted_tag_sources(
    db: Session, course_id: int | None = None,
) -> list[TrustedTagSourceOut]:
    query = db.query(CourseTagSource)
    if course_id is not None:
        query = query.filter(CourseTagSource.course_id == course_id)
    rows = query.all()
    return [TrustedTagSourceOut.model_validate(row) for row in rows]


def save_trusted_tag_source(
    db: Session, course_id: int, tag_id: int, source: str, active: bool,
    source_ref: str | None, actor_id: int,
) -> TrustedTagSourceOut:
    row = db.query(CourseTagSource).filter_by(course_id=course_id, tag_id=tag_id).first()
    if row is None:
        row = CourseTagSource(course_id=course_id, tag_id=tag_id, maintained_by=actor_id)
        db.add(row)
    row.source, row.active, row.source_ref, row.maintained_by = source, active, source_ref, actor_id
    db.flush()
    return TrustedTagSourceOut.model_validate(row)


def get_learning_event(db: Session, event_id: str) -> LearningEventOut | None:
    row = db.query(AnonymousLearningEvent).filter_by(event_id=event_id).first()
    return LearningEventOut.model_validate(row) if row else None


def create_learning_event(
    db: Session, event_id: str, course_id: int, tag_ids: list[int],
    node_ids: list[int], question_id: int | None,
) -> LearningEventOut:
    row = AnonymousLearningEvent(event_id=event_id, course_id=course_id, tag_ids=tag_ids,
                                 knowledge_node_ids=node_ids, question_id=question_id)
    db.add(row)
    db.flush()
    return LearningEventOut.model_validate(row)


def list_learning_events(db: Session, course_id: int, since: datetime) -> list[LearningEventOut]:
    rows = db.query(AnonymousLearningEvent).filter(
        AnonymousLearningEvent.course_id == course_id, AnonymousLearningEvent.created_at >= since,
    ).all()
    return [LearningEventOut.model_validate(row) for row in rows]

# ---------- Agent 运行（agent_runs） ----------


def create_approval_wait(
    db: Session, request_id: str, case_id: int, user_id: int, trace_id: str,
    expires_at: datetime | None,
) -> None:
    db.add(ApprovalWait(request_id=request_id, case_id=case_id, user_id=user_id,
                        trace_id=trace_id, expires_at=expires_at, state="waiting"))
    db.flush()


def get_approval_wait(db: Session, request_id: str) -> ApprovalWaitOut | None:
    row = db.get(ApprovalWait, request_id, with_for_update=True, populate_existing=True)
    return ApprovalWaitOut.model_validate(row) if row else None


def finish_approval_wait(db: Session, request_id: str, state: str, result: dict) -> None:
    row = db.get(ApprovalWait, request_id)
    row.state, row.result = state, result
    db.flush()


def get_patrol_workflow_task(
    db: Session, *, source_key: str | None = None, task_id: str | None = None,
    for_update: bool = False,
) -> PatrolWorkflowOut | None:
    query = db.query(PatrolWorkflowTask)
    query = (query.filter_by(source_key=source_key) if source_key
             else query.filter_by(task_id=task_id))
    if for_update:
        query = query.with_for_update().populate_existing()
    row = query.first()
    return PatrolWorkflowOut.model_validate(row) if row else None


def list_unbound_patrol_tasks(db: Session) -> list[PatrolWorkflowOut]:
    rows = db.query(PatrolWorkflowTask).filter_by(status="active", workflow_run_id=None).limit(100)
    return [PatrolWorkflowOut.model_validate(row) for row in rows]


def update_patrol_task(db: Session, task_id: str, **values) -> PatrolWorkflowOut:
    row = db.get(PatrolWorkflowTask, task_id)
    for name, value in values.items():
        setattr(row, name, value)
    db.flush()
    return PatrolWorkflowOut.model_validate(row)


def create_patrol_workflow_task(
    db: Session, source_key: str, task: PatrolWorkflowOut,
) -> PatrolWorkflowOut:
    row = PatrolWorkflowTask(
        **task.model_dump(exclude={"repeat", "task_id"}), task_id=str(task.task_id),
        source_key=source_key,
    )
    db.add(row)
    db.flush()
    return PatrolWorkflowOut.model_validate(row)


def create_run(
    db: Session, task_type: str, trace_id: str, agent_run_id: str, input_summary: str,
    user_id: int | None = None,
    actor_kind: str | None = None,
    parent_run_id: str | None = None,
    slot_kind: str | None = None,
    slot_id: str | None = None,
) -> AgentRunOut:
    """新建运行记录，初始状态 running；agent_run_id 冲突由唯一索引兜底。"""
    run = AgentRun(
        user_id=user_id,
        task_type=task_type,
        trace_id=trace_id,
        agent_run_id=agent_run_id,
        input_summary=input_summary,
        status=domain.RUN_STATUS_RUNNING,
        actor_kind=actor_kind,
        parent_run_id=parent_run_id,
        slot_kind=slot_kind,
        slot_id=slot_id,
    )
    db.add(run)
    db.flush()
    return AgentRunOut.model_validate(run)


def get_run_by_agent_run_id(
    db: Session, agent_run_id: str, *, for_update: bool = False,
) -> AgentRunOut | None:
    """按运行标识查询（内部接口以 agent_run_id 字符串为定位键）。"""
    query = db.query(AgentRun).filter(AgentRun.agent_run_id == agent_run_id)
    if for_update:
        query = query.with_for_update()
    run = query.first()
    return AgentRunOut.model_validate(run) if run else None


def update_run(
    db: Session, agent_run_id: str, status: str,
    output_summary: str | None, error_summary: str | None,
) -> AgentRunOut:
    """迁移运行状态并补输出/失败摘要（状态机校验在 service/domain）。"""
    run = db.query(AgentRun).filter(AgentRun.agent_run_id == agent_run_id).one()
    run.status = status
    if output_summary is not None:
        run.output_summary = output_summary
    if error_summary is not None:
        run.error_summary = error_summary
    db.flush()
    return AgentRunOut.model_validate(run)


# ---------- 工具调用日志（tool_call_logs） ----------


def list_run_events(db: Session, agent_run_id: str) -> list[RunEventOut]:
    rows = db.query(AgentRunEvent).filter(
        AgentRunEvent.agent_run_id == agent_run_id,
    ).order_by(AgentRunEvent.sequence_no).all()
    return [RunEventOut.model_validate(row) for row in rows]


def list_runs_filtered(
    db: Session, page: int, page_size: int,
    status: str | None, task_type: str | None, user_id: int | None,
) -> tuple[list[AgentRunOut], int]:
    """管理端运行列表（T-16-A）：状态/任务类型/用户筛选 + 分页，最新在前。"""
    query = db.query(AgentRun)
    if status is not None:
        query = query.filter(AgentRun.status == status)
    if task_type is not None:
        query = query.filter(AgentRun.task_type == task_type)
    if user_id is not None:
        query = query.filter(AgentRun.user_id == user_id)
    total = query.count()
    rows = (
        query.order_by(AgentRun.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return [AgentRunOut.model_validate(row) for row in rows], total


def list_tool_calls_by_run(db: Session, agent_run_id: str) -> list[ToolCallOut]:
    """某运行的工具调用日志（时间正序）。"""
    rows = (
        db.query(ToolCallLog)
        .filter(ToolCallLog.agent_run_id == agent_run_id)
        .order_by(ToolCallLog.id.asc())
        .all()
    )
    return [ToolCallOut.model_validate(row) for row in rows]


def list_cases_by_trace(db: Session, trace_id: str) -> list[ModerationCaseOut]:
    """同一 trace 关联的治理工单（观测调用链聚合：运行 → 工单溯源）。"""
    rows = (
        db.query(ModerationCase)
        .filter(ModerationCase.trace_id == trace_id)
        .order_by(ModerationCase.id.asc())
        .all()
    )
    return [ModerationCaseOut.model_validate(row) for row in rows]


def create_run_event(
    db: Session, agent_run_id: str, trace_id: str, sequence_no: int,
    event_type: str, plan_revision: int, steps: list[dict[str, str]] | None,
    step_id: str | None, tool_name: str | None, duration_ms: int | None,
) -> RunEventOut:
    row = AgentRunEvent(
        agent_run_id=agent_run_id, trace_id=trace_id, sequence_no=sequence_no,
        event_type=event_type, plan_revision=plan_revision, steps=steps,
        step_id=step_id, tool_name=tool_name, duration_ms=duration_ms,
    )
    db.add(row)
    db.flush()
    return RunEventOut.model_validate(row)


def create_tool_call(
    db: Session, agent_run_id: str, tool_name: str, args_summary: str | None,
    result_summary: str | None, status: str, duration_ms: int | None, trace_id: str,
) -> ToolCallOut:
    """落一条工具调用摘要日志（只存摘要，字段即摘要红线见模型注释）。"""
    log = ToolCallLog(
        agent_run_id=agent_run_id,
        tool_name=tool_name,
        args_summary=args_summary,
        result_summary=result_summary,
        status=status,
        duration_ms=duration_ms,
        trace_id=trace_id,
    )
    db.add(log)
    db.flush()
    return ToolCallOut.model_validate(log)


# ---------- 持久化记忆（agent_memory） ----------


def list_memories(
    db: Session, user_id: int, course_id: int | None, memory_types: list[str] | None
) -> list[MemoryItemOut]:
    """读取用户生效记忆（is_enabled=true），按类型/课程可选过滤，最近优先。"""
    query = db.query(AgentMemory).filter(
        AgentMemory.user_id == user_id, AgentMemory.is_enabled.is_(True)
    )
    if course_id is not None:
        query = query.filter(AgentMemory.course_id == course_id)
    if memory_types:
        query = query.filter(AgentMemory.memory_type.in_(memory_types))
    rows = (
        query.order_by(desc(AgentMemory.created_at), desc(AgentMemory.id))
        .limit(domain.MEMORY_LIST_LIMIT)
        .all()
    )
    return [MemoryItemOut.model_validate(row) for row in rows]


def create_memory(
    db: Session, user_id: int, memory_type: str, content: str,
    course_id: int | None, source_run_id: str | None,
) -> MemoryItemOut:
    """写入一条记忆（敏感信息过滤在 service 层，本层只落库）。"""
    item = AgentMemory(
        user_id=user_id,
        memory_type=memory_type,
        content=content,
        course_id=course_id,
        source_run_id=source_run_id,
        is_enabled=True,
    )
    db.add(item)
    db.flush()
    return MemoryItemOut.model_validate(item)


# ---------- 审批工单（moderation_cases，C-06：只建工单不执行） ----------


def create_agent_case(
    db: Session, target_type: str, target_id: int, risk_level: str, reason: str,
    snapshot: str, trace_id: str | None, agent_run_id: str | None,
    decision_trace: str,
) -> ModerationCaseOut:
    """Agent 来源工单落表：source=agent、status=pending，处置字段全部留空；
    decision_trace 写入建单首行（由 service 组装）。
    """
    case = ModerationCase(
        target_type=target_type,
        target_id=target_id,
        risk_level=risk_level,
        source=domain.CASE_SOURCE_AGENT,
        reason=reason,
        snapshot=snapshot,
        status=domain.CASE_STATUS_PENDING,
        trace_id=trace_id,
        agent_run_id=agent_run_id,
        decision_trace=decision_trace,
    )
    db.add(case)
    db.flush()
    return ModerationCaseOut.model_validate(case)


def get_case_by_id(
    db: Session, case_id: int, *, for_update: bool = False,
) -> ModerationCaseOut | None:
    """按 ID 查询工单。"""
    query = db.query(ModerationCase).filter(ModerationCase.id == case_id)
    if for_update:
        query = query.with_for_update().populate_existing()
    case = query.first()
    return ModerationCaseOut.model_validate(case) if case else None


def get_case_by_run_id(db: Session, run_id: str) -> ModerationCaseOut | None:
    case = db.query(ModerationCase).filter(ModerationCase.agent_run_id == run_id).first()
    return ModerationCaseOut.model_validate(case) if case else None


def save_case_decision(
    db: Session, case_id: int, *,
    status: str,
    manager_feedback: str,
    agent_decision: str,
    decision_source: str | None,
    decision_trace: str,
    resolution: str | None,
    resolved_by: int | None,
    resolved_at: datetime | None,
) -> ModerationCaseOut:
    """按状态机校验后的结果落库（状态机与权限校验在 service/domain 层完成）。

    决策双环字段（manager_feedback/agent_decision/decision_source）为"最新值"
    覆盖语义；完整历史由追加式 decision_trace 承担。
    """
    case = db.query(ModerationCase).filter(ModerationCase.id == case_id).one()
    case.status = status
    case.manager_feedback = manager_feedback
    case.agent_decision = agent_decision
    case.decision_source = decision_source
    case.decision_trace = decision_trace
    case.resolution = resolution
    case.resolved_by = resolved_by
    case.resolved_at = resolved_at
    db.flush()
    return ModerationCaseOut.model_validate(case)


# ---------- 审批中心与申诉（T-15-A，对外管理接口） ----------


def list_moderation_cases(
    db: Session, page: int, page_size: int, status: str | None, source: str | None,
) -> tuple[list[ModerationCaseOut], int]:
    """分页列出审核工单（最新在前；status/source 可选筛选）。"""
    query = db.query(ModerationCase)
    if status is not None:
        query = query.filter(ModerationCase.status == status)
    if source is not None:
        query = query.filter(ModerationCase.source == source)
    total = query.count()
    cases = (
        query.order_by(ModerationCase.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return [ModerationCaseOut.model_validate(case) for case in cases], total


def list_executed_cases_by_recency(db: Session, limit: int = 50) -> list[ModerationCase]:
    """最近已执行工单（申诉定位候选；作者归属由 service 判定）。"""
    return (
        db.query(ModerationCase)
        .filter(ModerationCase.status == domain.CASE_STATUS_EXECUTED)
        .order_by(ModerationCase.id.desc())
        .limit(limit)
        .all()
    )


def has_pending_appeal(db: Session, case_id: int, user_id: int) -> bool:
    """同一用户对同一工单是否已有待处理申诉。"""
    return (
        db.query(Appeal)
        .filter(
            Appeal.case_id == case_id,
            Appeal.user_id == user_id,
            Appeal.status == "pending",
        )
        .first()
        is not None
    )


def has_pending_case_for_target(
    db: Session, target_type: str, target_id: int
) -> bool:
    """同一目标是否已有未结案（pending/中间态）工单——静默巡检判重（US-13，T-15-B）。

    已执行/已拒绝的终态工单不阻止再次建单（处置后复发的新违规应重新扫描）。
    """
    return (
        db.query(ModerationCase)
        .filter(
            ModerationCase.target_type == target_type,
            ModerationCase.target_id == target_id,
            ModerationCase.status.in_((
                domain.CASE_STATUS_PENDING,
                domain.CASE_STATUS_AGENT_PROPOSED,
                domain.CASE_STATUS_MANAGER_DIRECTED,
            )),
        )
        .first()
        is not None
    )


def create_appeal(db: Session, case_id: int, user_id: int, reason: str) -> AppealOut:
    """新建申诉（pending；重复与无可申诉对象由 service 层先行拦截）。"""
    appeal = Appeal(case_id=case_id, user_id=user_id, reason=reason, status="pending")
    db.add(appeal)
    db.flush()
    return AppealOut.model_validate(appeal)


def get_appeal_by_id(db: Session, appeal_id: int) -> Appeal | None:
    """按主键取申诉 ORM 对象（复核前校验）。"""
    return db.get(Appeal, appeal_id)


def list_appeals(
    db: Session, page: int, page_size: int, status: str | None,
) -> tuple[list[AppealOut], int]:
    """分页列出申诉（最新在前；status 可选筛选）。"""
    query = db.query(Appeal)
    if status is not None:
        query = query.filter(Appeal.status == status)
    total = query.count()
    appeals = (
        query.order_by(Appeal.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return [AppealOut.model_validate(appeal) for appeal in appeals], total


def save_appeal_resolution(
    db: Session, appeal_id: int, *, status: str, resolution_note: str, resolved_by: int,
) -> AppealOut:
    """申诉复核结果落库（状态机与权限校验在 service 层完成）。"""
    appeal = db.query(Appeal).filter(Appeal.id == appeal_id).one()
    appeal.status = status
    appeal.resolution_note = resolution_note
    appeal.resolved_by = resolved_by
    appeal.resolved_at = datetime.now()
    db.flush()
    return AppealOut.model_validate(appeal)


def get_experience(
    db: Session, *, row_id: int | None = None, proposal_id: str | None = None,
    for_update: bool = False,
) -> ExperienceOut | None:
    query = db.query(AgentExperience)
    query = query.filter(AgentExperience.id == row_id) if row_id is not None else query.filter(
        AgentExperience.proposal_id == proposal_id,
    )
    if for_update:
        query = query.with_for_update().populate_existing()
    row = query.first()
    return ExperienceOut.model_validate(row) if row else None


def create_experience(
    db: Session, proposal_id: str, course_id: int, proposed_by: int, title: str,
    summary: str, steps: list[str], trace_id: str, agent_run_id: str,
) -> ExperienceOut:
    row = AgentExperience(
        proposal_id=proposal_id, course_id=course_id, proposed_by=proposed_by,
        title=title, summary=summary, steps=steps, status="pending", trace_id=trace_id,
        agent_run_id=agent_run_id,
    )
    db.add(row)
    db.flush()
    return ExperienceOut.model_validate(row)


def list_experiences(
    db: Session, course_id: int, *, published_only: bool = False,
) -> list[ExperienceOut]:
    query = db.query(AgentExperience).filter(AgentExperience.course_id == course_id)
    if published_only:
        query = query.filter(AgentExperience.status == "published")
    return [ExperienceOut.model_validate(row) for row in query.order_by(
        AgentExperience.id.desc(),
    ).limit(100).all()]


def decide_experience(db: Session, row_id: int, status: str, teacher_id: int) -> ExperienceOut:
    row = db.get(AgentExperience, row_id)
    row.status = status
    row.reviewed_by = teacher_id
    row.reviewed_at = datetime.now()
    db.flush()
    return ExperienceOut.model_validate(row)


def patrol_tasks_page(db: Session, after: str | None, limit: int, scope: str):
    query = db.query(PatrolWorkflowTask).filter_by(status="active")
    if scope == "unbound":
        query = query.filter(PatrolWorkflowTask.workflow_run_id.is_(None))
    if after:
        query = query.filter(PatrolWorkflowTask.task_id > after)
    rows = query.order_by(PatrolWorkflowTask.task_id).limit(limit + 1).all()
    return [PatrolWorkflowOut.model_validate(row) for row in rows[:limit]], len(rows) > limit



def get_patrol_scan(db: Session) -> dict:
    row = (db.query(PatrolWorkflowScan).filter_by(scan_id="contents")
           .with_for_update().populate_existing().first())
    if row is None:
        row = PatrolWorkflowScan(scan_id="contents", revision=0, state={"cursor": None})
        db.add(row)
        db.flush()
    return {"revision": row.revision, "state": row.state}



def save_patrol_scan(db: Session, state: dict, revision: int) -> None:
    row = db.get(PatrolWorkflowScan, "contents")
    row.state, row.revision = state, revision
    db.flush()


# ---------- 管理员全量扫描（P2） ----------


def get_active_patrol_scan_job(db: Session) -> PatrolScanJob | None:
    """同一时刻只允许一个排队中或运行中的全量扫描任务。"""
    return (
        db.query(PatrolScanJob)
        .filter(PatrolScanJob.status.in_(("queued", "running")))
        .first()
    )


def create_patrol_scan_job(
    db: Session, target_types: list[str], created_by: int | None, trace_id: str
) -> PatrolScanJob:
    row = PatrolScanJob(
        target_types=target_types,
        created_by=created_by,
        trace_id=trace_id,
        active_slot="patrol_scan",
    )
    db.add(row)
    db.flush()
    return row


def get_patrol_scan_job(
    db: Session, job_id: int, *, for_update: bool = False
) -> PatrolScanJob | None:
    query = db.query(PatrolScanJob).filter(PatrolScanJob.id == job_id)
    if for_update:
        query = query.with_for_update()
    return query.first()


def try_claim_patrol_scan_job(
    db: Session, job_id: int, worker_id: str, worker_token: str, expires_at: datetime,
) -> bool:
    """数据库级原子认领：条件更新同时完成"检查 + 占用"，跨实例只有一个能成功。

    可认领条件：任务仍在 queued/running，且没有有效租约（无 token / 无过期时间 / 已过期）。
    MySQL 的 UPDATE 会对命中行加锁并在锁等待后重新判断条件，因此并发认领只有一个 rowcount=1。
    """
    now = datetime.now(UTC).replace(tzinfo=None)
    stmt = (
        update(PatrolScanJob)
        .where(
            PatrolScanJob.id == job_id,
            PatrolScanJob.status.in_(("queued", "running")),
            or_(
                PatrolScanJob.worker_token.is_(None),
                PatrolScanJob.lease_expires_at.is_(None),
                PatrolScanJob.lease_expires_at <= now,
            ),
        )
        .values(
            status="running",
            started_at=func.coalesce(PatrolScanJob.started_at, now),
            worker_id=worker_id,
            worker_token=worker_token,
            lease_expires_at=expires_at,
        )
    )
    return db.execute(stmt).rowcount == 1


def renew_patrol_scan_lease(
    db: Session, job_id: int, worker_token: str, expires_at: datetime,
) -> bool:
    """续租：只有当前 token 且租约尚未过期才能延长，过期后旧 worker 不得复活。"""
    now = datetime.now(UTC).replace(tzinfo=None)
    stmt = (
        update(PatrolScanJob)
        .where(
            PatrolScanJob.id == job_id,
            PatrolScanJob.status == "running",
            PatrolScanJob.worker_token == worker_token,
            PatrolScanJob.lease_expires_at.isnot(None),
            PatrolScanJob.lease_expires_at > now,
        )
        .values(lease_expires_at=expires_at)
    )
    return db.execute(stmt).rowcount == 1


# ---------- 夜间离线整理（N-1/N-2） ----------


def list_moderation_cases_since(
    db: Session, since: datetime, limit: int = 200,
) -> list[ModerationCase]:
    """时间窗内工单（含判定与最终处置），供离线整理读取；只读。"""
    return (
        db.query(ModerationCase)
        .filter(ModerationCase.created_at >= since)
        .order_by(ModerationCase.id.desc())
        .limit(limit)
        .all()
    )


def get_patrol_note_by_key(db: Session, note_key: str) -> PatrolNoteOut | None:
    """按幂等键查询既有笔记。"""
    row = db.query(PatrolNote).filter(PatrolNote.note_key == note_key).first()
    return PatrolNoteOut.model_validate(row) if row is not None else None


def create_patrol_note(
    db: Session, note_key: str, note_type: str, source_case_id: int | None,
    target_type: str | None, target_id: int | None, rule_version: str,
    model_version: str, summary: str, confidence: int, valid_until: datetime,
    trace_id: str, agent_run_id: str | None, evidence_count: int = 1,
) -> PatrolNoteOut:
    """写入一条巡检笔记；本层只 flush，提交由 service 负责。"""
    row = PatrolNote(
        note_key=note_key, note_type=note_type, source_case_id=source_case_id,
        target_type=target_type, target_id=target_id, rule_version=rule_version,
        model_version=model_version, summary=summary, confidence=confidence,
        evidence_count=evidence_count, valid_until=valid_until, status="active",
        trace_id=trace_id, agent_run_id=agent_run_id,
    )
    db.add(row)
    db.flush()
    return PatrolNoteOut.model_validate(row)


def expire_patrol_notes(db: Session, now: datetime) -> int:
    """把已过有效期且仍为 active 的笔记置为 expired；只 flush。"""
    rows = (
        db.query(PatrolNote)
        .filter(PatrolNote.status == "active", PatrolNote.valid_until < now)
        .all()
    )
    for row in rows:
        row.status = "expired"
    db.flush()
    return len(rows)


def list_injectable_patrol_notes(
    db: Session, now: datetime, min_confidence: int, limit: int,
) -> list[PatrolNote]:
    """读取可注入的 active 笔记：未过期、置信度达标、证据 ≥2 且属于规则类。

    缺口与目标发现类笔记只交人工确认，不参与注入（C-06）。
    """
    return (
        db.query(PatrolNote)
        .filter(
            PatrolNote.status == "active",
            PatrolNote.valid_until >= now,
            PatrolNote.confidence >= min_confidence,
            PatrolNote.evidence_count >= 2,
            PatrolNote.note_type.in_(
                ("false_positive", "missed_case", "rule_degradation"),
            ),
        )
        .order_by(PatrolNote.confidence.desc(), PatrolNote.id.desc())
        .limit(limit)
        .all()
    )


def get_patrol_note_row(db: Session, note_id: int) -> PatrolNote | None:
    return db.get(PatrolNote, note_id)


def find_claimable_slot(
    db: Session, kind: str, capacity: int, job_id: str, now: datetime,
) -> int | None:
    """找同 kind 下可接管的槽位。

    规则（P0-6）：
    - 过期且属于其他 job：新任务接管，重试预算重置；
    - 属于同一 job：顶替/重试均可，但预算必须大于 0（每次 -1）。
    未过期的其他 job 槽位不可接管，否则全局容量会被绕过。
    """
    return db.scalar(
        select(AgentSlotLease.slot_no)
        .where(
            AgentSlotLease.kind == kind,
            AgentSlotLease.slot_no <= capacity,
            or_(
                and_(
                    AgentSlotLease.lease_expires_at <= now,
                    AgentSlotLease.job_id != job_id,
                ),
                and_(
                    AgentSlotLease.job_id == job_id,
                    AgentSlotLease.retry_count > 0,
                ),
            ),
        )
        .order_by(AgentSlotLease.slot_no)
        .limit(1)
    )


def claim_slot_row(
    db: Session, kind: str, slot_no: int, *,
    owner_instance: str, job_id: str, fencing_token: str,
    expires_at: datetime, now: datetime,
) -> bool:
    """条件更新接管槽位；并发下另一个实例先改则返回 False。

    同一 job 接管时重试预算 -1，其他 job 接管过期槽位时重置为初始预算。
    """
    same_job = AgentSlotLease.job_id == job_id
    result = db.execute(
        update(AgentSlotLease)
        .where(
            AgentSlotLease.kind == kind,
            AgentSlotLease.slot_no == slot_no,
            or_(
                and_(
                    AgentSlotLease.lease_expires_at <= now,
                    AgentSlotLease.job_id != job_id,
                ),
                and_(same_job, AgentSlotLease.retry_count > 0),
            ),
        )
        .values(
            owner_instance=owner_instance, job_id=job_id,
            fencing_token=fencing_token, lease_expires_at=expires_at,
            retry_count=case(
                (same_job, AgentSlotLease.retry_count - 1),
                else_=domain.SLOT_RETRY_BUDGET,
            ),
        )
    )
    return result.rowcount == 1


def has_exhausted_job_lease(db: Session, kind: str, job_id: str) -> bool:
    """该 job 的重试预算是否已用尽；用尽后不得新开槽位绕过上限。"""
    return int(db.scalar(
        select(func.count()).select_from(AgentSlotLease).where(
            AgentSlotLease.kind == kind,
            AgentSlotLease.job_id == job_id,
            AgentSlotLease.retry_count <= 0,
        )
    ) or 0) > 0


def count_kind_slots(db: Session, kind: str, capacity: int) -> int:
    """只统计当前容量内的槽位；容量下调后超出编号的旧行不占新配额。"""
    return int(db.scalar(
        select(func.count()).select_from(AgentSlotLease).where(
            AgentSlotLease.kind == kind,
            AgentSlotLease.slot_no <= capacity,
        )
    ) or 0)


def next_free_slot_no(db: Session, kind: str, capacity: int) -> int | None:
    """取容量内最小空闲编号，释放后立即复用，避免编号空洞导致容量失真。"""
    used = set(db.scalars(
        select(AgentSlotLease.slot_no).where(
            AgentSlotLease.kind == kind,
            AgentSlotLease.slot_no <= capacity,
        )
    ).all())
    for slot_no in range(1, capacity + 1):
        if slot_no not in used:
            return slot_no
    return None


def insert_slot_lease(
    db: Session, *, kind: str, slot_no: int, owner_instance: str, job_id: str,
    fencing_token: str, expires_at: datetime,
) -> None:
    db.add(AgentSlotLease(
        kind=kind, slot_no=slot_no, owner_instance=owner_instance,
        job_id=job_id, fencing_token=fencing_token, lease_expires_at=expires_at,
        retry_count=domain.SLOT_RETRY_BUDGET,
    ))
    db.flush()


def renew_slot_lease(
    db: Session, kind: str, slot_no: int, fencing_token: str,
    expires_at: datetime, now: datetime,
) -> bool:
    """仅未过期且 token 匹配时可续租；过期租约可能已被他人抢占。"""
    result = db.execute(
        update(AgentSlotLease)
        .where(
            AgentSlotLease.kind == kind,
            AgentSlotLease.slot_no == slot_no,
            AgentSlotLease.fencing_token == fencing_token,
            AgentSlotLease.lease_expires_at > now,
        )
        .values(lease_expires_at=expires_at)
    )
    return result.rowcount == 1


def delete_slot_lease(
    db: Session, kind: str, slot_no: int, fencing_token: str,
) -> bool:
    result = db.execute(
        delete(AgentSlotLease).where(
            AgentSlotLease.kind == kind,
            AgentSlotLease.slot_no == slot_no,
            AgentSlotLease.fencing_token == fencing_token,
        )
    )
    return result.rowcount == 1


# ---------- 全局问答排队（P0-5） ----------


def insert_slot_waiter(
    db: Session, *, kind: str, job_id: str, instance_id: str, capacity: int,
    ttl_seconds: int, enqueued_at: datetime, expires_at: datetime,
) -> AgentSlotWaiter:
    waiter = AgentSlotWaiter(
        kind=kind, job_id=job_id, instance_id=instance_id, capacity=capacity,
        ttl_seconds=ttl_seconds, status="waiting",
        enqueued_at=enqueued_at, expires_at=expires_at,
    )
    db.add(waiter)
    db.flush()
    return waiter


def get_slot_waiter(
    db: Session, ticket_id: int, for_update: bool = False,
) -> AgentSlotWaiter | None:
    query = db.query(AgentSlotWaiter).filter(AgentSlotWaiter.id == ticket_id)
    if for_update:
        query = query.with_for_update().populate_existing()
    return query.first()


def find_waiting_head(
    db: Session, kind: str, for_update: bool = False,
) -> AgentSlotWaiter | None:
    """队首：同 kind 中最早入队且仍在等待的票据（严格 FIFO）。"""
    query = db.query(AgentSlotWaiter).filter(
        AgentSlotWaiter.kind == kind, AgentSlotWaiter.status == "waiting",
    ).order_by(AgentSlotWaiter.id)
    if for_update:
        query = query.with_for_update()
    return query.first()


def grant_slot_waiter(
    db: Session, waiter: AgentSlotWaiter, *, slot_no: int, fencing_token: str,
    now: datetime,
) -> None:
    waiter.status = "granted"
    waiter.slot_no = slot_no
    waiter.fencing_token = fencing_token
    waiter.granted_at = now
    db.flush()


def count_waiting_position(db: Session, kind: str, ticket_id: int) -> int:
    """FIFO 位置：同 kind 中 id 不大于本票据的等待者数量（含自己）。"""
    return int(db.scalar(
        select(func.count()).select_from(AgentSlotWaiter).where(
            AgentSlotWaiter.kind == kind,
            AgentSlotWaiter.status == "waiting",
            AgentSlotWaiter.id <= ticket_id,
        )
    ) or 0)


def delete_slot_waiter(db: Session, waiter: AgentSlotWaiter) -> None:
    db.delete(waiter)
    db.flush()


# ---------- 聊天可恢复流（P0-3） ----------


def delete_expired_chat_streams(db: Session, user_id: int, now: datetime) -> None:
    """机会式清理该用户已过期流及其事件；过期数据不再对外可见。"""
    ids = [
        row.id
        for row in db.query(AgentChatStream.id).filter(
            AgentChatStream.user_id == user_id,
            AgentChatStream.expires_at <= now,
        ).all()
    ]
    if not ids:
        return
    db.query(AgentChatStreamEvent).filter(
        AgentChatStreamEvent.stream_id.in_(ids)
    ).delete(synchronize_session=False)
    db.query(AgentChatStream).filter(AgentChatStream.id.in_(ids)).delete(
        synchronize_session=False
    )
    db.flush()


def get_chat_stream(
    db: Session, user_id: int, request_id: str, *, for_update: bool = False,
) -> ChatStreamOut | None:
    query = db.query(AgentChatStream).filter(
        AgentChatStream.user_id == user_id,
        AgentChatStream.request_id == request_id,
    )
    if for_update:
        query = query.with_for_update().populate_existing()
    row = query.first()
    if row is None:
        return None
    return ChatStreamOut.model_validate(row)


def create_chat_stream(
    db: Session, user_id: int, request_id: str, agent_run_id: str | None,
    trace_id: str | None, expires_at: datetime,
) -> ChatStreamOut:
    row = AgentChatStream(
        user_id=user_id, request_id=request_id, agent_run_id=agent_run_id,
        trace_id=trace_id, status="running", cancel_requested=False,
        expires_at=expires_at,
    )
    db.add(row)
    db.flush()
    return ChatStreamOut.model_validate(row)


def list_chat_stream_events(
    db: Session, user_id: int, request_id: str, after: int,
) -> list[ChatStreamEventItem]:
    stream_id = db.query(AgentChatStream.id).filter(
        AgentChatStream.user_id == user_id,
        AgentChatStream.request_id == request_id,
    ).scalar()
    if stream_id is None:
        return []
    rows = db.query(AgentChatStreamEvent).filter(
        AgentChatStreamEvent.stream_id == stream_id,
        AgentChatStreamEvent.seq > after,
    ).order_by(AgentChatStreamEvent.seq).all()
    return [
        ChatStreamEventItem(seq=row.seq, event_type=row.event_type, data=row.payload)
        for row in rows
    ]


def get_chat_stream_event(
    db: Session, user_id: int, request_id: str, seq: int,
) -> ChatStreamEventItem | None:
    stream_id = db.query(AgentChatStream.id).filter(
        AgentChatStream.user_id == user_id,
        AgentChatStream.request_id == request_id,
    ).scalar()
    if stream_id is None:
        return None
    row = db.query(AgentChatStreamEvent).filter(
        AgentChatStreamEvent.stream_id == stream_id,
        AgentChatStreamEvent.seq == seq,
    ).first()
    if row is None:
        return None
    return ChatStreamEventItem(seq=row.seq, event_type=row.event_type, data=row.payload)


def create_chat_stream_event(
    db: Session, user_id: int, request_id: str, seq: int, event_type: str, data: str,
) -> ChatStreamEventItem | None:
    stream_id = db.query(AgentChatStream.id).filter(
        AgentChatStream.user_id == user_id,
        AgentChatStream.request_id == request_id,
    ).scalar()
    if stream_id is None:
        return None
    row = AgentChatStreamEvent(
        stream_id=stream_id, seq=seq, event_type=event_type, payload=data,
    )
    db.add(row)
    db.flush()
    return ChatStreamEventItem(
        seq=seq, event_type=event_type, data=data,
    )


def update_chat_stream_status(
    db: Session, user_id: int, request_id: str, status: str,
) -> None:
    db.query(AgentChatStream).filter(
        AgentChatStream.user_id == user_id,
        AgentChatStream.request_id == request_id,
    ).update({"status": status}, synchronize_session=False)
    db.flush()


def mark_chat_stream_cancelled_request(
    db: Session, user_id: int, request_id: str,
) -> None:
    db.query(AgentChatStream).filter(
        AgentChatStream.user_id == user_id,
        AgentChatStream.request_id == request_id,
    ).update({"cancel_requested": True}, synchronize_session=False)
    db.flush()


def chat_stream_event_ack(seq: int, status: str, duplicate: bool = False) -> ChatStreamEventAck:
    return ChatStreamEventAck(seq=seq, status=status, duplicate=duplicate)


# ---------- 沙箱执行审计（P0-4） ----------


def insert_sandbox_event(
    db: Session, req: SandboxEventCreateRequest, trace_id: str,
) -> SandboxEventOut:
    """追加一条沙箱审计；事件只增不改，trace 缺省用服务端透传值。"""
    row = AgentSandboxEvent(
        event=req.event, outcome=req.outcome, tool=req.tool,
        executable=req.executable, command_digest=req.command_digest,
        arg_count=req.arg_count, action_class=req.action_class,
        network_mode=req.network_mode, trace_id=trace_id,
        duration_ms=req.duration_ms, output_bytes=req.output_bytes,
        reason_code=req.reason_code,
    )
    db.add(row)
    db.flush()
    return SandboxEventOut.model_validate(row)
