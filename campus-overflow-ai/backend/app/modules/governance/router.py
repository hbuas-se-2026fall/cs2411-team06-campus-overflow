# governance 对外路由（T-15-A 审批中心与申诉，US-13/14/16）：
# 管理端治理接口（/api/governance/*，管理员）+ 学生申诉提交（/api/appeals，登录用户）。
# 处置动作复用 T-16 扩展的双环状态机与真实执行（hide/delete/ban/skip）；
# 分层基线 D-2/D-9：本层只收参调 service_admin，不 import models、不触碰 ORM。
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from app.core.permissions import (
    UserPrincipal,
    get_current_user_allow_banned,
    require_roles,
)
from app.core.response import ok
from app.db.session import get_db
from app.modules.governance import (
    service_admin,
    service_control,
    service_internal,
    service_settings,
    service_skill,
)
from app.modules.governance.schemas import (
    AppealCreateRequest,
    AppealResolveRequest,
    CaseResolveRequest,
    PlanParallelSettingUpdate,
)
from app.modules.governance.schemas_control import RunControlRequest, RunGuidanceRequest
from app.modules.governance.schemas_skill import (
    SkillCreateRequest,
    SkillPublishRequest,
    SkillStatusRequest,
    SkillUpdateRequest,
)

router = APIRouter(prefix="/api/governance", tags=["治理（审批中心）"])
# 学生申诉提交路径：与前端 AppealFormView 既有契约一致（/api/appeals，蛇形字段）
appeals_router = APIRouter(prefix="/api/appeals", tags=["申诉"])


@router.get("/moderation/cases")
def list_moderation_cases(
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str | None = Query(
        None, description="pending/agent_proposed/manager_directed/executed/rejected"
    ),
    source: str | None = Query(None, description="agent/admin"),
) -> dict:
    """管理员：审核工单队列（状态/来源筛选 + 分页）。"""
    items, total = service_admin.list_moderation_cases(db, page, page_size, status, source)
    return ok({
        "items": [item.model_dump() for item in items],
        "total": total, "page": page, "page_size": page_size,
    })


@router.post("/moderation/cases/{case_id}/resolve")
def resolve_moderation_case(
    case_id: int,
    req: CaseResolveRequest,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：处置审核工单（hide/delete/ban/skip；真实处置与留痕同事务）。"""
    case = service_admin.resolve_moderation_case(
        db, admin.id, case_id, req.decision, req.manager_feedback, req.duration_days
    )
    return ok(case.model_dump(), "工单处置完成")


@router.get("/appeals")
def list_appeals(
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str | None = Query(None, description="pending/accepted/rejected"),
) -> dict:
    """管理员：申诉列表。"""
    items, total = service_admin.list_appeals(db, page, page_size, status)
    return ok({
        "items": [item.model_dump() for item in items],
        "total": total, "page": page, "page_size": page_size,
    })


@router.post("/appeals/{appeal_id}/resolve")
def resolve_appeal(
    appeal_id: int,
    req: AppealResolveRequest,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：复核申诉（accepted 撤销处置 / rejected 维持；回退与留痕同事务）。"""
    appeal = service_admin.resolve_appeal(
        db, admin.id, appeal_id, req.resolution, req.resolution_note
    )
    return ok(appeal.model_dump(), "申诉复核完成")


@appeals_router.post("")
def submit_appeal(
    req: AppealCreateRequest,
    # US-16：被封禁用户保留申诉救济权，身份解析放行 banned 状态（其余校验不变）
    current_user: UserPrincipal = Depends(get_current_user_allow_banned),
    db: Session = Depends(get_db),
) -> dict:
    """学生提交申诉：自动关联本人最近被执行的处置工单（US-16）。"""
    appeal = service_admin.submit_appeal(db, current_user.id, req.reason)
    return ok(appeal.model_dump(), "申诉已提交，结果将在通知中告知")


# ---------- 观测与审计（T-16-A，US-18/C-08：管理员查看运行与失败原因） ----------


@router.get("/agent-runs")
def list_agent_runs(
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str | None = Query(None, description="running/succeeded/failed"),
    task_type: str | None = Query(None, max_length=50, description="任务类型"),
    user_id: int | None = Query(None, ge=1, description="归属用户"),
) -> dict:
    """管理员：Agent 运行列表（筛选分页；失败运行可定位）。"""
    items, total = service_admin.list_agent_runs(
        db, page, page_size, status, task_type, user_id
    )
    return ok({
        "items": [item.model_dump() for item in items],
        "total": total, "page": page, "page_size": page_size,
    })


@router.get("/agent-runs/{agent_run_id}")
def get_run_trace(
    agent_run_id: str,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：单运行完整调用链（运行 + 计划/步骤事件 + 工具调用 + 关联工单）。"""
    detail = service_admin.get_run_trace(db, agent_run_id)
    return ok(detail.model_dump())


@router.get("/agent-runs/{agent_run_id}/control")
def get_run_control(
    agent_run_id: str,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：读取运行控制状态（暂停/继续/取消与引导回显）。"""
    control = service_control.get_admin_control(db, agent_run_id)
    return ok(control.model_dump(mode="json"))


@router.post("/agent-runs/{agent_run_id}/control")
def control_agent_run(
    agent_run_id: str,
    req: RunControlRequest,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
    x_trace_id: str | None = Header(default=None, alias="X-Trace-Id"),
) -> dict:
    """管理员：暂停/继续/取消治理任务或管理员聊天（RC-R01/R02）。"""
    control = service_control.apply_control(
        db, agent_run_id, req.action, req.expected_revision, admin.id,
        trace_id=(x_trace_id or "").strip() or uuid4().hex,
    )
    return ok(control.model_dump(mode="json"), "控制命令已生效")


@router.post("/agent-runs/{agent_run_id}/guidance")
def add_agent_run_guidance(
    agent_run_id: str,
    req: RunGuidanceRequest,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
    x_trace_id: str | None = Header(default=None, alias="X-Trace-Id"),
) -> dict:
    """管理员：暂停期间追加引导词，继续后注入下一次模型调用（RC-R03）。"""
    control = service_control.add_guidance(
        db, agent_run_id, req.guidance_text, req.expected_revision, admin.id,
        trace_id=(x_trace_id or "").strip() or uuid4().hex,
    )
    return ok(control.model_dump(mode="json"), "引导词已追加")


# ---------- 系统运行开关（SA-07C / ADR-010） ----------


@router.get("/moderation/marks")
def list_moderation_marks(
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
    limit: int = Query(100, ge=1, le=200),
) -> dict:
    """管理员：最近低风险内容打标（T-15-F），仅元数据不含正文。"""
    items = service_internal.list_moderation_marks(db, limit)
    return ok({"items": [item.model_dump(mode="json") for item in items],
               "total": len(items)})


@router.get("/mcp/calls")
def list_mcp_calls(
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    client_name: str | None = Query(None, max_length=80, description="外部客户端名"),
    tool_name: str | None = Query(None, max_length=120, description="工具名"),
    status: str | None = Query(None, max_length=20, description="调用结果分类"),
) -> dict:
    """管理员：MCP 调用审计分页检索（T-17 N-04），仅脱敏摘要。"""
    items, total = service_internal.list_mcp_calls(
        db, page, page_size, client_name, tool_name, status,
    )
    return ok({
        "items": [item.model_dump(mode="json") for item in items],
        "total": total, "page": page, "page_size": page_size,
    })


@router.get("/settings/plan-parallel")
def get_plan_parallel_setting(
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：读取计划内并行开关（默认关闭）。"""
    return ok(service_settings.get_plan_parallel(db).model_dump(mode="json"))


@router.put("/settings/plan-parallel")
def update_plan_parallel_setting(
    req: PlanParallelSettingUpdate,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：切换计划内并行开关；Agent 下次配置刷新后生效。"""
    setting = service_settings.update_plan_parallel(db, req.plan_parallel_enabled, admin.id)
    return ok(setting.model_dump(mode="json"), "设置已更新")


# ---------- 工作流 skill 管理（T-22B / SK-R01～R04） ----------


@router.get("/skills")
def list_skills(
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str | None = Query(None, description="draft/active/disabled/archived"),
    task_type: str | None = Query(None, max_length=40, description="任务类型"),
    course_id: int | None = Query(None, ge=1, description="课程限定"),
) -> dict:
    """管理员：skill 列表（状态/任务类型/课程筛选 + 分页）。"""
    items, total = service_skill.list_skills(
        db, page, page_size, status, task_type, course_id
    )
    return ok({
        "items": [item.model_dump(mode="json") for item in items],
        "total": total, "page": page, "page_size": page_size,
    })


@router.post("/skills")
def create_skill(
    req: SkillCreateRequest,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：创建 skill 草稿（生成 version 1，发布前不注入）。"""
    skill = service_skill.create_skill(db, req, admin.id)
    return ok(skill.model_dump(mode="json"), "skill 草稿已创建")


@router.get("/skills/{skill_id}")
def get_skill_detail(
    skill_id: int,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：skill 详情与全部历史版本。"""
    detail = service_skill.get_skill_detail(db, skill_id)
    return ok(detail.model_dump(mode="json"))


@router.put("/skills/{skill_id}")
def update_skill(
    skill_id: int,
    req: SkillUpdateRequest,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：编辑元数据与草稿；已发布版本内容不变。"""
    skill = service_skill.update_skill(db, skill_id, req, admin.id)
    return ok(skill.model_dump(mode="json"), "skill 已更新")


@router.get("/skills/{skill_id}/versions")
def list_skill_versions(
    skill_id: int,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：历史版本（含草稿与发布信息）。"""
    versions = service_skill.list_skill_versions(db, skill_id)
    return ok({
        "items": [item.model_dump(mode="json") for item in versions],
        "total": len(versions),
    })


@router.post("/skills/{skill_id}/publish")
def publish_skill(
    skill_id: int,
    req: SkillPublishRequest,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：发布当前草稿；指定 version 时回滚到已发布版本。"""
    skill = service_skill.publish_skill(db, skill_id, req, admin.id)
    return ok(skill.model_dump(mode="json"), "skill 已发布")


@router.post("/skills/{skill_id}/status")
def set_skill_status(
    skill_id: int,
    req: SkillStatusRequest,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：启用或停用 skill（归档使用删除接口）。"""
    skill = service_skill.set_skill_status(db, skill_id, req.status, admin.id)
    return ok(skill.model_dump(mode="json"), "skill 状态已更新")


@router.delete("/skills/{skill_id}")
def archive_skill(
    skill_id: int,
    admin: UserPrincipal = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> dict:
    """管理员：归档 skill；历史版本与运行引用保留，不做物理删除。"""
    skill = service_skill.archive_skill(db, skill_id, admin.id)
    return ok(skill.model_dump(mode="json"), "skill 已归档")
