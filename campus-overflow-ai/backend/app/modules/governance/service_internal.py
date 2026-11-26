# governance 内部业务层：/internal/agent/* 白名单接口的用例编排（T-12）
# 分层基线 D-2/D-5：ORM 留在 repository；课程/问题检索经 courses/qa 公开 service 只读复用，
# 用户存在性经 identity 公开 service 校验；本层不 import models、不依赖 Web 框架。
# 事务约定 D-8：写用例末尾显式 db.commit()。
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.logging import action_logger
from app.modules.courses import domain as courses_domain
from app.modules.courses import service as courses_service
from app.modules.courses.schemas import (
    CourseListItemResponse,
    KnowledgeTreeCourseItem,
    KnowledgeTreeResponse,
    WeeklyReportResponse,
)
from app.modules.governance import domain, repository, service_approvals, service_notify
from app.modules.governance.schemas import (
    AgentRunOut,
    ChatStreamEventAck,
    ChatStreamEventCreateRequest,
    ChatStreamOut,
    ChatStreamReadOut,
    McpCallCreateRequest,
    McpCallOut,
    ModerationCaseOut,
    PatrolFeedbackItem,
    PatrolMarkCreateRequest,
    PatrolMarkOut,
    PatrolNoteCreateItem,
    PatrolNoteOut,
    ReportSaveRequest,
    RunEventOut,
    SandboxEventCreateRequest,
    SandboxEventOut,
    SlotLeaseClaimRequest,
    SlotLeaseOut,
    SlotWaitOut,
    SlotWaitRequest,
    ToolCallOut,
)
from app.modules.identity import service as identity_service
from app.modules.qa import service as qa_service
from app.modules.qa.schemas import (
    ModerationContentData,
    PatrolContentItem,
    QuestionListItemResponse,
    RecentQuestionContent,
    TagBrief,
)

# 问题检索排序口径：复用 qa 列表 latest（vote_score 之外的默认序）
QUESTION_SORT_LATEST = "latest"

# 封禁原因列宽（identity.users.ban_reason = String(200)）
BAN_REASON_MAX_LEN = 200


# ---------- 决策轨迹（追加式纯文本，每行一个事件，UTC 时间戳可追溯定位） ----------

#返回UTC时间戳
def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

#返回决策轨迹中的操作者标识
def _trace_actor(
    caller_is_admin: bool, principal_id: int | None, agent_run_id: str | None,
) -> str:
    if caller_is_admin:
        return f"admin(id={principal_id})"
    return f"agent(run={agent_run_id or 'unknown'})"

#追加决策轨迹中的事件
def _append_trace(previous: str | None, line: str) -> str:
    return f"{previous}\n{line}" if previous else line

#返回决策轨迹中的事件摘要
def _summarize(text: str | None, limit: int = 120) -> str:
    """轨迹摘要：压平换行并截断，避免单条反馈冲垮轨迹可读性。"""
    flattened = (text or "").replace("\n", " ").strip()
    return flattened if len(flattened) <= limit else flattened[:limit] + "…"

#构建决策轨迹中的创建事件
def _build_create_trace(
    action_type: str, risk_level: str, agent_run_id: str | None,
) -> str:
    return (
        f"[{_utc_stamp()}] create action={action_type} risk={risk_level} "
        f"by={_trace_actor(False, None, agent_run_id)}"
    )

#构建决策轨迹中的处置事件
def _build_decision_trace(
    *, from_status: str, to_status: str, decision: str,
    caller_is_admin: bool, principal_id: int | None, agent_run_id: str | None,
    manager_feedback: str, skip_reason: str | None,
) -> str:
    actor = _trace_actor(caller_is_admin, principal_id, agent_run_id)
    detail = f"feedback={_summarize(manager_feedback)}"
    if skip_reason:
        detail += f" skip_reason={_summarize(skip_reason)}"
    return (
        f"[{_utc_stamp()}] {actor} {from_status}→{to_status} "
        f"decision={decision} | {detail}"
    )


# ---------- Agent 运行（US-18） ----------


def create_run(
    db: Session, task_type: str, trace_id: str, input_summary: str,
    agent_run_id: str | None = None,
    user_id: int | None = None,
    actor_kind: str | None = None,
    parent_run_id: str | None = None,
    slot_kind: str | None = None,
    slot_id: str | None = None,
) -> AgentRunOut:
    """创建运行记录：agent_run_id 优先取 Agent 上报（T-11 生成），缺省后端兜底。"""
    run_id = agent_run_id or uuid.uuid4().hex
    try:
        run = repository.create_run(
            db, task_type, trace_id, run_id, domain.audit_summary(input_summary) or "",
            user_id=user_id,
            actor_kind=actor_kind,
            parent_run_id=parent_run_id,
            slot_kind=slot_kind,
            slot_id=slot_id,
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        if repository.get_run_by_agent_run_id(db, run_id) is not None:
            raise domain.RunConflictError() from None
        raise
    action_logger.info(
        "agent_run_created agent_run_id=%s task_type=%s trace_id=%s",
        run.agent_run_id, task_type, trace_id,
    )
    return run


def update_run(
    db: Session, agent_run_id: str, status: str,
    output_summary: str | None, error_summary: str | None,
    user_id: int | None = None,
) -> AgentRunOut:
    """更新运行结果：先读当前状态过状态机（D-1），非法迁移 400，记录不存在 404。"""
    current = repository.get_run_by_agent_run_id(db, agent_run_id, for_update=True)
    if current is None:
        raise domain.RunNotFoundError()
    domain.ensure_run_owner(current.user_id, user_id)
    domain.ensure_run_transition(current.status, status)
    if status == domain.RUN_STATUS_SUCCEEDED and domain.pending_audit_steps([
        event.model_dump() for event in repository.list_run_events(db, agent_run_id)
    ]):
        raise domain.RunStateError("仍有工具调用未完成记录，不能标记成功")
    run = repository.update_run(
        db, agent_run_id, status,
        domain.audit_summary(output_summary), domain.audit_summary(error_summary),
    )
    db.commit()
    return run


def record_tool_call(
    db: Session, agent_run_id: str, tool_name: str, args_summary: str | None,
    result_summary: str | None, status: str, duration_ms: int | None, trace_id: str,
    user_id: int | None = None,
) -> ToolCallOut:
    """记录工具摘要：沿用父运行 trace 并脱敏；trace_id 入参保留兼容旧调用。"""
    current = repository.get_run_by_agent_run_id(db, agent_run_id, for_update=True)
    if current is None:
        raise domain.RunNotFoundError()
    domain.ensure_run_owner(current.user_id, user_id)
    if current.status != domain.RUN_STATUS_RUNNING:
        raise domain.RunStateError()
    log = repository.create_tool_call(
        db, agent_run_id, tool_name, domain.audit_summary(args_summary),
        domain.audit_summary(result_summary), status, duration_ms, current.trace_id,
    )
    db.commit()
    return log


# ---------- 持久化记忆（US-17 / X-06） ----------


def record_run_event(
    db: Session, agent_run_id: str, user_id: int, event_type: str, plan_revision: int,
    steps: list[dict[str, str]] | None, step_id: str | None,
    tool_name: str | None, duration_ms: int | None,
) -> RunEventOut:
    current = repository.get_run_by_agent_run_id(db, agent_run_id, for_update=True)
    if current is None:
        raise domain.RunNotFoundError()
    domain.ensure_run_owner(current.user_id, user_id)
    if current.status != domain.RUN_STATUS_RUNNING:
        raise domain.RunStateError()
    history = repository.list_run_events(db, agent_run_id)
    event = dict(event_type=event_type, plan_revision=plan_revision, steps=steps,
                 step_id=step_id, tool_name=tool_name, duration_ms=duration_ms)
    domain.ensure_run_event([item.model_dump() for item in history], event)
    try:
        result = repository.create_run_event(
            db, agent_run_id, current.trace_id, len(history) + 1,
            event_type, plan_revision, steps, step_id, tool_name, duration_ms,
        )
        if event_type in ("step_succeeded", "step_failed"):
            repository.create_tool_call(
                db, agent_run_id, tool_name, f"plan={plan_revision} step={step_id}",
                "调用完成" if event_type == "step_succeeded" else "调用失败",
                "succeeded" if event_type == "step_succeeded" else "failed",
                duration_ms, current.trace_id,
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return result


# ---------- 审批工单（US-13 / US-14 / C-06：只建工单，绝不执行） ----------


def create_approval(
    db: Session, action_type: str, risk_level: str, payload_snapshot: str,
    trace_id: str, agent_run_id: str | None,
    target_type: str | None, target_id: int, reason: str | None,
) -> ModerationCaseOut:
    """高风险动作 → moderation_cases 工单（source=agent、status=pending）。

    红线（C-06）：本函数只落工单留痕，不隐藏/不删除/不封号/不写文件；
    处置由管理员经治理接口执行（T-15）。动作与风险等级经白名单校验。
    """
    domain.ensure_valid_approval(action_type, risk_level)
    case_reason = reason or f"Agent 高风险动作待人工审批：{action_type}（风险等级 {risk_level}）"
    initial_trace = _build_create_trace(action_type, risk_level, agent_run_id)
    case = repository.create_agent_case(
        db, target_type or "agent_action", target_id, risk_level,
        case_reason, payload_snapshot, trace_id, agent_run_id, initial_trace,
    )
    db.commit()
    action_logger.info(
        "agent_approval_ticket_created case_id=%s action_type=%s risk_level=%s "
        "trace_id=%s agent_run_id=%s",
        case.id, action_type, risk_level, trace_id, agent_run_id,
    )
    return case


# ---------- 站内检索（US-09 / US-10 / US-12：只读复用现有 service） ----------


def search_courses(
    db: Session, keyword: str, limit: int
) -> tuple[list[CourseListItemResponse], int]:
    """课程检索（plan §5）：复用 courses 公开列表查询，按关键词过滤。"""
    keyword = keyword.strip()
    if not keyword:
        raise domain.SearchKeywordError()
    return courses_service.list_courses(db, 1, limit, keyword, None)


def search_questions(
    db: Session, keyword: str, course_id: int | None, tags: str | None, limit: int
) -> tuple[list[QuestionListItemResponse], int]:
    """相似问题候选检索（plan §5）：复用 qa 公开列表查询（软删不可见 E-10）。

    tags 为逗号分隔标签名，任一标签命中即保留，计数与 limit 前由 qa 查询过滤；
    keyword 必填，命中标题或正文（与业务搜索同款转义）。
    """
    keyword = keyword.strip()
    if not keyword:
        raise domain.SearchKeywordError()
    wanted = sorted({t.strip() for t in tags.split(",") if t.strip()}) if tags else None
    return qa_service.list_questions(
        db, 1, limit, course_id, QUESTION_SORT_LATEST, False, keyword,
        tag_names=wanted,
    )


def get_moderation_content(
    db: Session, target_type: str, target_id: int
) -> ModerationContentData:
    """治理目标正文（US-13）：只读复用 qa 可见性规则，不可见目标统一 404。"""
    return qa_service.moderation_get_content(db, target_type, target_id)


def list_tags(db: Session, limit: int) -> list[TagBrief]:
    """站内标签词表（plan §5 / US-11 / E-09）：标签推荐的候选集，只读复用 qa 标签列表。

    全量按 id 升序取前 limit 个（词表只供候选与站内 id 映射，不附绑定计数）；
    E-09：仅提供词表，绑定仍须用户确认后经 qa 标签绑定接口写入。
    """
    return [
        TagBrief(id=t.id, name=t.name, type=t.type)
        for t in qa_service.list_tags(db, None, False)[:limit]
    ]


# ---------- 工单决策（双环工作流 + 真实处置，US-14 / C-06） ----------

# 探针状态 → 中文状况（409 响应直接面向管理员/Agent，必须自解释）
_CONTENT_PROBE_TEXT = {
    "missing": "目标内容不存在",
    "deleted": "目标内容已被删除",
    "hidden": "目标内容已被隐藏",
}
_USER_PROBE_TEXT = {
    "missing": "目标用户不存在",
    "banned": "目标用户已被封禁",
}


def _ensure_target_ready(
    db: Session, target_type: str, target_id: int, decision: str,
) -> None:
    """处置前探针：目标不在可处置状态 → 409，工单不允许写 executed。

    hide/ban 要求目标在位；delete 允许从 hidden 升级（隐藏后再决定删除是合法梯度），
    但已软删/不存在一律拦截。
    """
    if target_type in domain.CASE_CONTENT_TARGETS:
        state = qa_service.probe_moderation_target(db, target_type, target_id)
        if state == "ready":
            return
        if state == "hidden" and decision == domain.CASE_DECISION_DELETE:
            return
        raise domain.CaseTargetNotReadyError(
            f"{_CONTENT_PROBE_TEXT[state]}，处置未执行"
        )
    # user 目标
    state = identity_service.moderation_probe_user(db, target_id)
    if state != "ready":
        raise domain.CaseTargetNotReadyError(
            f"{_USER_PROBE_TEXT[state]}，处置未执行"
        )


def apply_moderation_action(
    db: Session, case: ModerationCaseOut, decision: str, admin_id: int,
    duration_days: int | None = None,
) -> None:
    """真实处置：调用下游治理执行器（只 flush），与工单留痕同事务提交。"""
    target_type, target_id = case.target_type, case.target_id
    if decision == domain.CASE_DECISION_HIDE:
        qa_service.moderation_hide(db, target_type, target_id)
    elif decision == domain.CASE_DECISION_DELETE:
        qa_service.moderation_soft_delete(db, target_type, target_id)
    elif decision == domain.CASE_DECISION_BAN:
        reason = f"治理工单 #{case.id} 永久封禁：{case.reason}"[:BAN_REASON_MAX_LEN]
        identity_service.moderation_ban_user(db, target_id, reason, admin_id)
    elif decision == domain.CASE_DECISION_BAN_TEMP:
        days = duration_days if duration_days is not None else domain.BAN_TEMP_DEFAULT_DAYS
        if not (1 <= days <= domain.BAN_TEMP_MAX_DAYS):
            raise domain.CaseDecisionError(
                f"限时封禁天数须在 1~{domain.BAN_TEMP_MAX_DAYS} 天"
            )
        reason = f"治理工单 #{case.id} 限时封禁 {days} 天：{case.reason}"[:BAN_REASON_MAX_LEN]
        identity_service.moderation_ban_user(db, target_id, reason, admin_id, days)
    elif decision == domain.CASE_DECISION_WARN:
        reason = f"治理工单 #{case.id} 警告：{case.reason}"[:BAN_REASON_MAX_LEN]
        identity_service.moderation_warn_user(db, target_id, reason, admin_id)
    elif decision == domain.CASE_DECISION_EDIT:
        qa_service.moderation_require_revision(db, target_type, target_id)
    else:  # pragma: no cover - 白名单已在入口保证
        raise domain.CaseDecisionError("不支持的处置动作")


def update_case_agent_decision(
    db: Session,
    case_id: int,
    manager_feedback: str,
    decision: str,
    *,
    caller_is_admin: bool,
    principal_id: int | None,
    trace_id: str,
    decision_source: str | None = None,
    skip_reason: str | None = None,
    agent_run_id: str | None = None,
    duration_days: int | None = None,
) -> ModerationCaseOut:
    """工单决策推进：按双环状态机迁移，executed 必须同步完成真实处置。

    双环工作流（US-14 / C-06，2026-10-12 修复）：
      pending ─skip→ rejected（Agent 与管理员同路径，一次结案）
      pending → (agent_proposed | manager_directed) → (executed | rejected)

    权限矩阵：
      - pending：Agent（服务 token）只能走 agent_proposed；
        manager_directed 通道仅管理员（JWT）可开启；skip 两边都直达 rejected。
      - agent_proposed → executed（hide/delete/ban）：仅管理员，人工确认后由后端
        代执行真实处置；Agent 只能以 skip 安全自终止为 rejected。
      - manager_directed 通道的关闭（执行/拒绝）：仅管理员。

    执行前探针未通过（目标不存在/已处置/已封禁）返回 409，工单停留中间态；
    真实处置与工单留痕在同一事务提交，失败整体回滚。
    """
    case = repository.get_case_by_id(db, case_id, for_update=True)
    if case is None:
        raise domain.DecisionNotFoundError()

    current_status = case.status
    if current_status in {domain.CASE_STATUS_EXECUTED, domain.CASE_STATUS_REJECTED}:
        raise domain.CaseTransitionError("终态工单不可变更")
    # 词汇白名单 + 动作-目标匹配（非法值/错配目标一律 400，不产生任何状态变更）
    domain.ensure_decision_allowed(decision)
    domain.ensure_decision_matches_target(decision, case.target_type)
    service_approvals.validate_frozen_request(db, case, decision, duration_days)

    is_execution = decision in domain.CASE_EXECUTION_DECISIONS
    frozen_source = case.decision_source

    if current_status == domain.CASE_STATUS_PENDING and not is_execution:
        # skip：安全自终止/管理员不予处置，一次请求直接 rejected，不落中间态
        target_status = domain.CASE_STATUS_REJECTED
        resolution = None
        resolved_by = principal_id if caller_is_admin else None
        resolved_at = datetime.now(timezone.utc)
        frozen_source = None
    elif current_status == domain.CASE_STATUS_PENDING:
        source = decision_source or domain.CASE_STATUS_AGENT_PROPOSED
        if source not in {
            domain.CASE_STATUS_AGENT_PROPOSED, domain.CASE_STATUS_MANAGER_DIRECTED
        }:
            raise domain.CaseDecisionError("decision_source 不合法")
        if source == domain.CASE_STATUS_MANAGER_DIRECTED and not caller_is_admin:
            raise domain.CaseActionForbiddenError("管理员直办通道只能由管理员开启")
        target_status = source
        resolution = None
        resolved_by = None
        resolved_at = None
        frozen_source = source
    elif current_status == domain.CASE_STATUS_AGENT_PROPOSED:
        if is_execution and not caller_is_admin:
            # C-06：Agent 不得凭服务 token 直接执行处置，必须等待管理员确认
            raise domain.CaseActionForbiddenError("处置执行必须经管理员人工确认")
        if is_execution:
            _ensure_target_ready(db, case.target_type, case.target_id, decision)
            target_status = domain.CASE_STATUS_EXECUTED
            resolution = decision
            resolved_by = principal_id
            resolved_at = datetime.now(timezone.utc)
        else:
            target_status = domain.CASE_STATUS_REJECTED
            resolution = None
            # Agent 自终止没有操作人；管理员拒绝时留管理员痕
            resolved_by = principal_id if caller_is_admin else None
            resolved_at = datetime.now(timezone.utc)
    elif current_status == domain.CASE_STATUS_MANAGER_DIRECTED:
        if not caller_is_admin:
            raise domain.CaseActionForbiddenError("管理员直办通道只能由管理员关闭")
        if is_execution:
            _ensure_target_ready(db, case.target_type, case.target_id, decision)
            target_status = domain.CASE_STATUS_EXECUTED
            resolution = decision
        else:
            target_status = domain.CASE_STATUS_REJECTED
            resolution = None
        resolved_by = principal_id
        resolved_at = datetime.now(timezone.utc)
    else:
        raise domain.CaseTransitionError(f"不支持的工单状态 {current_status}")

    # 防御性不变量：目标迁移必须在状态机白名单内
    domain.ensure_case_transition(current_status, target_status)

    # 真实处置放在工单写入前：处置失败（探针后竞态等）整体回滚，不留下空 executed
    if target_status == domain.CASE_STATUS_EXECUTED:
        apply_moderation_action(db, case, decision, resolved_by, duration_days)

    trace_line = _build_decision_trace(
        from_status=current_status, to_status=target_status, decision=decision,
        caller_is_admin=caller_is_admin, principal_id=principal_id,
        agent_run_id=case.agent_run_id or agent_run_id,
        manager_feedback=manager_feedback, skip_reason=skip_reason,
    )
    saved = repository.save_case_decision(
        db,
        case_id,
        status=target_status,
        manager_feedback=manager_feedback,
        agent_decision=decision,
        decision_source=frozen_source,
        decision_trace=_append_trace(case.decision_trace, trace_line),
        resolution=resolution,
        resolved_by=resolved_by,
        resolved_at=resolved_at,
    )
    db.commit()

    action_logger.info(
        "case_decided case_id=%s from=%s to=%s decision=%s is_execution=%s "
        "caller_is_admin=%s principal_id=%s skip_reason_present=%s "
        "agent_run_id=%s trace_id=%s",
        case_id, current_status, target_status, decision, is_execution,
        caller_is_admin, principal_id, bool(skip_reason), agent_run_id, trace_id,
    )

    return saved


# ---------- 知识树与周报（KN-R01/R02，K-02） ----------


def list_knowledge_tree_courses(db: Session) -> list[KnowledgeTreeCourseItem]:
    """有知识树的课程清单（调度扫描入口；E-19 无树课程不进清单）。"""
    return courses_service.list_knowledge_tree_courses(db)


def get_course_knowledge_tree(db: Session, course_id: int) -> KnowledgeTreeResponse:
    """课程知识树读取（内部只读复用；课程不存在 404）。"""
    return courses_service.get_knowledge_tree(db, course_id)


def list_recent_questions(
    db: Session, course_id: int, days: int, limit: int
) -> list[RecentQuestionContent]:
    """课程近期可见问题正文（周报分析依据）：只读，不更新浏览量。

    created_at 为数据库 naive UTC 口径（与 normalize_created_range 一致）。
    """
    if courses_service.get_course(db, course_id) is None:
        raise courses_domain.CourseNotFoundError()
    created_from = (
        datetime.now(timezone.utc) - timedelta(days=days)
    ).replace(tzinfo=None)
    return qa_service.list_recent_question_contents(db, course_id, created_from, limit)


def save_weekly_report(
    db: Session, req: ReportSaveRequest, trace_id: str
) -> WeeklyReportResponse:
    """保存周报（系统调度运行）：敏感词拦截后经 courses service 落库（E-18 幂等 409）。

    周报是模型归纳文本，不含学生正文原文；命中密钥类关键词即拒绝并留拦截日志
    （不含原文，C-07 精神），调度器按单课程失败继续（X-07）。
    """
    texts = [req.content]
    for topic in req.uncovered_topics:
        texts.extend((topic.topic, topic.suggestion))
    texts.extend(item.node_name for item in req.heatmap)
    if domain.is_sensitive_content("\n".join(texts)):
        action_logger.warning(
            "agent_report_intercepted course_id=%s trace_id=%s reason=sensitive_keyword",
            req.course_id, trace_id,
        )
        raise domain.ReportSensitiveError()
    return courses_service.save_weekly_report(
        db, req.course_id, req.week_start, req.week_end, req.content,
        [t.model_dump() for t in req.uncovered_topics],
        [h.model_dump() for h in req.heatmap],
        req.question_count, req.agent_run_id,
    )


# ---------- 静默巡检（US-13，T-15-B） ----------


def list_patrol_contents(
    db: Session, hours: int, limit: int
) -> list[PatrolContentItem]:
    """全站时间窗内新内容清单（巡检扫描依据）：只读，软删/隐藏排除。"""
    created_from = (
        datetime.now(timezone.utc) - timedelta(hours=hours)
    ).replace(tzinfo=None)
    return qa_service.list_patrol_contents(db, created_from, limit)


def create_patrol_case(
    db: Session, target_type: str, target_id: int, risk_level: str,
    reason: str, snapshot: str, trace_id: str, agent_run_id: str,
) -> ModerationCaseOut:
    """巡检建单（Agent 提交评估结果）：判重后落 pending 工单（C-06 只建单不处置）。

    同目标已有未结案工单时返回 None（幂等跳过，不算失败——巡检按单目标失败隔离）；
    动作固定 hide_content 语义但仅作为工单类型标识，真实处置仍由管理员决定。
    通知与建单同事务（T-15-C）：通知失败整体回滚，不出现"有单无通知"。
    """
    if repository.has_pending_case_for_target(db, target_type, target_id):
        return None
    initial_trace = _build_create_trace("hide_content", risk_level, agent_run_id)
    case = repository.create_agent_case(
        db, target_type, target_id, risk_level, reason, snapshot,
        trace_id, agent_run_id, initial_trace,
    )
    service_notify.notify_case_created(db, case.id, target_type, target_id)
    db.commit()
    action_logger.info(
        "patrol_case_created case_id=%s target=%s/%s risk=%s trace_id=%s",
        case.id, target_type, target_id, risk_level, trace_id,
    )
    return case


def mark_patrol_content(
    db: Session, req: PatrolMarkCreateRequest, trace_id: str,
) -> PatrolMarkOut:
    """低风险内容打标（T-15-F）：仅可见内容可打标，同目标覆盖最新评估。

    只写标记表，不修改内容行，因此不影响可见性与作者编辑时间。
    """
    if qa_service.probe_moderation_target(db, req.target_type, req.target_id) != "ready":
        raise domain.CaseTargetNotReadyError("目标内容不可见或已处置，跳过打标")
    mark = repository.upsert_moderation_mark(
        db, req.target_type, req.target_id, req.risk_level,
        req.reason, req.agent_run_id, trace_id,
    )
    db.commit()
    action_logger.info(
        "patrol_mark_saved target=%s/%s risk=%s trace_id=%s",
        req.target_type, req.target_id, req.risk_level, trace_id,
    )
    return mark


def list_moderation_marks(db: Session, limit: int = 100) -> list[PatrolMarkOut]:
    """管理员只读：最近低风险打标列表。"""
    return repository.list_moderation_marks(db, limit)


# ---------- MCP 调用审计（T-17 N-04 / US-18） ----------


def record_mcp_call(
    db: Session, req: McpCallCreateRequest, trace_id: str,
) -> McpCallOut:
    """追加 MCP 调用审计；只存脱敏摘要，不记录凭证与原始参数。"""
    record = repository.insert_mcp_call(
        db, client_name=req.client_name, tool_name=req.tool_name, status=req.status,
        args_summary=req.args_summary, result_summary=req.result_summary,
        error_summary=req.error_summary, duration_ms=req.duration_ms,
        trace_id=req.trace_id or trace_id,
    )
    db.commit()
    action_logger.info(
        "mcp_call_recorded client=%s tool=%s status=%s trace_id=%s",
        req.client_name, req.tool_name, req.status, req.trace_id or trace_id,
    )
    return record


def list_mcp_calls(
    db: Session, page: int = 1, page_size: int = 20,
    client_name: str | None = None, tool_name: str | None = None,
    status: str | None = None,
) -> tuple[list[McpCallOut], int]:
    """管理员分页检索 MCP 调用审计。"""
    return repository.list_mcp_calls(db, page, page_size, client_name, tool_name, status)


# ---------- 夜间离线整理（N-1/N-2） ----------


def list_moderation_feedback(
    db: Session, days: int, limit: int,
) -> list[PatrolFeedbackItem]:
    """读取时间窗内工单判定与最终处置，供离线整理分析；只读。"""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).replace(tzinfo=None)
    cases = repository.list_moderation_cases_since(db, since, limit)
    return [
        PatrolFeedbackItem(
            case_id=case.id, target_type=case.target_type, target_id=case.target_id,
            risk_level=case.risk_level, source=case.source, status=case.status,
            resolution=case.resolution, decision_source=case.decision_source,
            reason=case.reason, agent_run_id=case.agent_run_id,
            trace_id=case.trace_id, created_at=case.created_at,
            resolved_at=case.resolved_at,
        )
        for case in cases
    ]


def create_patrol_notes(
    db: Session, items: list[PatrolNoteCreateItem], trace_id: str,
    agent_run_id: str | None,
) -> tuple[list[PatrolNoteOut], int]:
    """批量写入巡检笔记：按 note_key 幂等，重复项返回既有记录。

    事务约定 D-8：全部处理完成后统一提交，避免半批成功。
    """
    notes: list[PatrolNoteOut] = []
    repeated = 0
    for item in items:
        existing = repository.get_patrol_note_by_key(db, item.note_key)
        if existing is not None:
            notes.append(existing)
            repeated += 1
            continue
        notes.append(repository.create_patrol_note(
            db, item.note_key, item.note_type, item.source_case_id,
            item.target_type, item.target_id, item.rule_version,
            item.model_version, item.summary, item.confidence,
            item.valid_until, trace_id, agent_run_id, item.evidence_count,
        ))
    db.commit()
    action_logger.info(
        "patrol_notes_written count=%s repeated=%s trace_id=%s",
        len(notes), repeated, trace_id,
    )
    return notes, repeated


def expire_patrol_notes(db: Session, trace_id: str) -> int:
    """过期降级：过期笔记只作参考，不单独作为建单依据（N-2）。"""
    expired = repository.expire_patrol_notes(db, datetime.now(timezone.utc).replace(tzinfo=None))
    db.commit()
    action_logger.info("patrol_notes_expired count=%s trace_id=%s", expired, trace_id)
    return expired


# 每条笔记在注入文本中的固定开销（类型、目标、来源标识等）估算
INJECT_NOTE_OVERHEAD = 40


def list_injectable_patrol_context(
    db: Session, min_confidence: int, max_chars: int, limit: int,
) -> tuple[list[PatrolNoteOut], bool]:
    """N-3 只读注入候选：按字符预算裁剪，返回选中项与是否被截断。

    只读取 active 且未过期的笔记；不修改任何记录，不进入巡检判定。
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = repository.list_injectable_patrol_notes(db, now, min_confidence, limit)
    selected: list[PatrolNoteOut] = []
    used = 0
    for row in rows:
        cost = len(row.summary) + INJECT_NOTE_OVERHEAD
        if used + cost > max_chars:
            return selected, True
        selected.append(PatrolNoteOut.model_validate(row))
        used += cost
    return selected, False


def retract_patrol_note(db: Session, note_id: int, trace_id: str) -> PatrolNoteOut:
    """撤回笔记：立即从注入候选中移除，保留历史记录（N-3）。"""
    row = repository.get_patrol_note_row(db, note_id)
    if row is None:
        raise domain.DecisionNotFoundError("巡检笔记不存在")
    if row.status == "active":
        row.status = "retracted"
        db.flush()
    db.commit()
    action_logger.info("patrol_note_retracted note_id=%s trace_id=%s", note_id, trace_id)
    return PatrolNoteOut.model_validate(row)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _claim_available_slot(
    db: Session, *, kind: str, capacity: int, job_id: str, instance_id: str,
    ttl_seconds: int, now: datetime,
) -> tuple[int, str, datetime] | None:
    """在容量内原子占用一个槽位；容量已满返回 None。

    先尝试复用过期/本人持有的槽位，再在容量内插入新行；插入冲突由主键
    约束兜底，失败后重试，最多 5 次。插入使用 SAVEPOINT，冲突回滚不会
    破坏调用方已持有的队列锁。
    """
    for _ in range(5):
        token = uuid.uuid4().hex
        expires = now + timedelta(seconds=ttl_seconds)
        slot_no = repository.find_claimable_slot(db, kind, capacity, job_id, now)
        if slot_no is not None:
            if repository.claim_slot_row(
                db, kind, slot_no,
                owner_instance=instance_id, job_id=job_id,
                fencing_token=token, expires_at=expires, now=now,
            ):
                return slot_no, token, expires
            continue
        # 重试预算已用尽的 job 不得新开槽位绕过上限
        if repository.has_exhausted_job_lease(db, kind, job_id):
            return None
        if repository.count_kind_slots(db, kind, capacity) >= capacity:
            return None
        next_no = repository.next_free_slot_no(db, kind, capacity)
        if next_no is None:
            return None
        try:
            with db.begin_nested():
                repository.insert_slot_lease(
                    db, kind=kind, slot_no=next_no, owner_instance=instance_id,
                    job_id=job_id, fencing_token=token, expires_at=expires,
                )
            return next_no, token, expires
        except IntegrityError:
            continue
    return None


def claim_slot_lease(db: Session, req: SlotLeaseClaimRequest) -> SlotLeaseOut | None:
    """跨实例原子占用槽位；容量已满返回 None。"""
    acquired = _claim_available_slot(
        db, kind=req.kind, capacity=req.capacity, job_id=req.job_id,
        instance_id=req.instance_id, ttl_seconds=req.ttl_seconds, now=_now(),
    )
    if acquired is None:
        return None
    slot_no, token, expires = acquired
    db.commit()
    return SlotLeaseOut(
        kind=req.kind, slot_no=slot_no, job_id=req.job_id,
        fencing_token=token, lease_expires_at=expires,
    )


def renew_slot_lease(
    db: Session, kind: str, slot_no: int, fencing_token: str, ttl_seconds: int,
) -> bool:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    renewed = repository.renew_slot_lease(
        db, kind, slot_no, fencing_token,
        now + timedelta(seconds=ttl_seconds), now,
    )
    db.commit()
    return renewed


def release_slot_lease(
    db: Session, kind: str, slot_no: int, fencing_token: str,
) -> bool:
    released = repository.delete_slot_lease(db, kind, slot_no, fencing_token)
    db.commit()
    return released


# ---------- 全局问答排队（P0-5） ----------


def _lease_from_waiter(waiter) -> SlotLeaseOut:
    """授予票据转成租约出参：租期从授予时刻重新计算。"""
    return SlotLeaseOut(
        kind=waiter.kind, slot_no=waiter.slot_no, job_id=waiter.job_id,
        fencing_token=waiter.fencing_token,
        lease_expires_at=waiter.granted_at + timedelta(seconds=waiter.ttl_seconds),
    )


def _take_wait(db: Session, waiter, now: datetime) -> SlotWaitOut:
    """解析票据：granted 立即消费，waiting 报位置，过期作废。"""
    ticket_id, job_id = waiter.id, waiter.job_id
    if waiter.status == "granted":
        lease = _lease_from_waiter(waiter)
        if lease.lease_expires_at <= now:
            # 授予后长时间未被取走：回收槽位，票据作废
            repository.delete_slot_lease(
                db, lease.kind, lease.slot_no, lease.fencing_token,
            )
            repository.delete_slot_waiter(db, waiter)
            return SlotWaitOut(ticket_id=ticket_id, job_id=job_id, status="expired")
        result = SlotWaitOut(
            ticket_id=ticket_id, job_id=job_id, status="granted", lease=lease,
        )
        repository.delete_slot_waiter(db, waiter)
        return result
    if waiter.expires_at <= now:
        repository.delete_slot_waiter(db, waiter)
        return SlotWaitOut(ticket_id=ticket_id, job_id=job_id, status="expired")
    return SlotWaitOut(
        ticket_id=ticket_id, job_id=job_id, status="waiting",
        position=repository.count_waiting_position(db, waiter.kind, ticket_id),
    )


def _promote_waiters(db: Session, kind: str, now: datetime) -> None:
    """严格按 FIFO 晋升队首；容量不足即停止，过期的队首直接作废。"""
    for _ in range(128):
        head = repository.find_waiting_head(db, kind, for_update=True)
        if head is None:
            return
        if head.expires_at <= now:
            repository.delete_slot_waiter(db, head)
            continue
        acquired = _claim_available_slot(
            db, kind=head.kind, capacity=head.capacity, job_id=head.job_id,
            instance_id=head.instance_id, ttl_seconds=head.ttl_seconds, now=now,
        )
        if acquired is None:
            return
        slot_no, token, _expires = acquired
        repository.grant_slot_waiter(
            db, head, slot_no=slot_no, fencing_token=token, now=now,
        )


def enqueue_slot_wait(db: Session, req: SlotWaitRequest) -> SlotWaitOut:
    """入队并尝试晋升；队首且有空槽时直接返回租约，否则返回等待位置。"""
    now = _now()
    waiter = repository.insert_slot_waiter(
        db, kind=req.kind, job_id=req.job_id, instance_id=req.instance_id,
        capacity=req.capacity, ttl_seconds=req.ttl_seconds,
        enqueued_at=now, expires_at=now + timedelta(seconds=req.wait_seconds),
    )
    _promote_waiters(db, req.kind, now)
    result = _take_wait(db, waiter, now)
    db.commit()
    return result


def poll_slot_wait(db: Session, ticket_id: int) -> SlotWaitOut:
    """轮询票据：队首可能被本机晋升；已授予则取走租约，过期返回 expired。"""
    now = _now()
    waiter = repository.get_slot_waiter(db, ticket_id, for_update=True)
    if waiter is None:
        raise domain.DecisionNotFoundError("排队票据不存在或已过期")
    kind, job_id = waiter.kind, waiter.job_id
    _promote_waiters(db, kind, now)
    waiter = repository.get_slot_waiter(db, ticket_id)
    result = (
        SlotWaitOut(ticket_id=ticket_id, job_id=job_id, status="expired")
        if waiter is None else _take_wait(db, waiter, now)
    )
    db.commit()
    return result


def cancel_slot_wait(db: Session, ticket_id: int) -> None:
    """放弃排队：已授予但未取走的票据同时回收槽位。"""
    waiter = repository.get_slot_waiter(db, ticket_id, for_update=True)
    if waiter is None:
        raise domain.DecisionNotFoundError("排队票据不存在或已过期")
    if waiter.status == "granted" and waiter.slot_no is not None:
        repository.delete_slot_lease(
            db, waiter.kind, waiter.slot_no, waiter.fencing_token or "",
        )
    repository.delete_slot_waiter(db, waiter)
    db.commit()


# ---------- 聊天可恢复流（P0-3） ----------

# 流保留 30 分钟：足够断线续接与跨实例恢复，过期后读取一律 404。
CHAT_STREAM_TTL = timedelta(minutes=30)
CHAT_STREAM_TERMINAL = frozenset({"succeeded", "failed", "cancelled"})


def _chat_stream_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def ensure_chat_stream(
    db: Session, user_id: int, request_id: str,
    agent_run_id: str | None = None, trace_id: str | None = None,
) -> ChatStreamOut:
    """幂等登记：已有同用户同请求 id 的流直接返回，不覆盖原运行标识。"""
    now = _chat_stream_now()
    repository.delete_expired_chat_streams(db, user_id, now)
    existing = repository.get_chat_stream(db, user_id, request_id)
    if existing is not None:
        db.commit()
        return existing
    try:
        created = repository.create_chat_stream(
            db, user_id, request_id, agent_run_id, trace_id, now + CHAT_STREAM_TTL,
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = repository.get_chat_stream(db, user_id, request_id)
        if existing is None:
            raise
        return existing
    return created.model_copy(update={"created": True})


def append_chat_stream_event(
    db: Session, user_id: int, request_id: str, req: ChatStreamEventCreateRequest,
) -> ChatStreamEventAck:
    """追加事件：重复序号同内容幂等；序号必须连续；终止事件迁移状态。"""
    now = _chat_stream_now()
    repository.delete_expired_chat_streams(db, user_id, now)
    current = repository.get_chat_stream(db, user_id, request_id, for_update=True)
    if current is None:
        db.rollback()
        raise domain.ChatStreamNotFoundError()
    duplicate = repository.get_chat_stream_event(db, user_id, request_id, req.seq)
    if duplicate is not None:
        if duplicate.event_type != req.event_type or duplicate.data != req.data:
            db.rollback()
            raise domain.ChatStreamEventConflictError()
        db.commit()
        return repository.chat_stream_event_ack(req.seq, current.status, True)
    if current.status in CHAT_STREAM_TERMINAL:
        db.rollback()
        raise domain.ChatStreamStateError("聊天流已结束，不能继续追加事件")
    history = repository.list_chat_stream_events(db, user_id, request_id, 0)
    last_seq = history[-1].seq if history else 0
    if req.seq != last_seq + 1:
        db.rollback()
        raise domain.ChatStreamStateError("事件序号不连续")
    event = repository.create_chat_stream_event(
        db, user_id, request_id, req.seq, req.event_type, req.data,
    )
    if event is None:
        db.rollback()
        raise domain.ChatStreamNotFoundError()
    status = current.status
    if req.event_type == "done":
        status = "succeeded"
    elif req.event_type == "error":
        status = "cancelled" if current.cancel_requested else "failed"
    if status != current.status:
        repository.update_chat_stream_status(db, user_id, request_id, status)
    db.commit()
    return repository.chat_stream_event_ack(req.seq, status)


def read_chat_stream(
    db: Session, user_id: int, request_id: str, after: int,
) -> ChatStreamReadOut:
    """读取快照与 after 之后的事件；不存在、他人的或已过期一律 404。"""
    now = _chat_stream_now()
    repository.delete_expired_chat_streams(db, user_id, now)
    current = repository.get_chat_stream(db, user_id, request_id)
    if current is None:
        db.commit()
        raise domain.ChatStreamNotFoundError()
    events = repository.list_chat_stream_events(db, user_id, request_id, after)
    db.commit()
    return ChatStreamReadOut(**current.model_dump(), events=events)


def cancel_chat_stream(
    db: Session, user_id: int, request_id: str,
) -> ChatStreamOut:
    """仅 owner 可置取消标记；已终止的流保持终态，重复取消幂等。"""
    now = _chat_stream_now()
    repository.delete_expired_chat_streams(db, user_id, now)
    current = repository.get_chat_stream(db, user_id, request_id, for_update=True)
    if current is None:
        db.rollback()
        raise domain.ChatStreamNotFoundError()
    if current.status in CHAT_STREAM_TERMINAL:
        db.commit()
        return current
    repository.mark_chat_stream_cancelled_request(db, user_id, request_id)
    db.commit()
    updated = repository.get_chat_stream(db, user_id, request_id)
    return updated if updated is not None else current


# ---------- 沙箱执行审计（P0-4） ----------


def record_sandbox_event(
    db: Session, req: SandboxEventCreateRequest, trace_id: str,
) -> SandboxEventOut:
    """追加沙箱审计：系统级事件，不写用户归属；trace 缺省回落到请求头。"""
    event = repository.insert_sandbox_event(db, req, req.trace_id or trace_id)
    db.commit()
    action_logger.info(
        "sandbox_event_recorded outcome=%s tool=%s reason=%s trace_id=%s",
        req.outcome, req.tool, req.reason_code or "-", req.trace_id or trace_id,
    )
    return event
