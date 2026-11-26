# governance 系统运行开关（SA-07C / ADR-010）：管理员读写 + Agent 只读运行配置。
# 分层基线 D-2/D-5：ORM 只在 repository；本层只做字符串化布尔映射与事务提交。
from sqlalchemy.orm import Session

from app.modules.governance import repository
from app.modules.governance.schemas import PlanParallelSettingOut

# 设置表 key：计划内并行执行全局开关
PLAN_PARALLEL_KEY = "plan_parallel_enabled"


def _to_bool(value: str) -> bool:
    return value == "true"


def get_plan_parallel(db: Session) -> PlanParallelSettingOut:
    """读取计划内并行开关；无记录时默认关闭（ADR-010）。"""
    setting = repository.get_system_setting(db, PLAN_PARALLEL_KEY)
    if setting is None:
        return PlanParallelSettingOut(plan_parallel_enabled=False)
    return PlanParallelSettingOut(
        plan_parallel_enabled=_to_bool(setting.value),
        updated_at=setting.updated_at,
    )


def update_plan_parallel(
    db: Session, plan_parallel_enabled: bool, actor_id: int,
) -> PlanParallelSettingOut:
    """管理员切换开关；字符串化布尔与审计字段同事务落库。"""
    setting = repository.save_system_setting(
        db, PLAN_PARALLEL_KEY, "true" if plan_parallel_enabled else "false", actor_id,
    )
    db.commit()
    return PlanParallelSettingOut(
        plan_parallel_enabled=plan_parallel_enabled,
        updated_at=setting.updated_at,
    )
