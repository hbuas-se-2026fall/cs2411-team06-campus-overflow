# 暂停超时定时清理（T-21D）：仅在运行控制开关开启时由应用生命周期启动。
# 多实例安全：仓储层按行条件更新，同一个运行只会被一方收敛。
import asyncio
import logging

from app.core.config import settings
from app.db.session import SessionLocal
from app.modules.governance.service_control import expire_paused_controls

logger = logging.getLogger("app.action")


async def run_control_cleanup_loop() -> None:
    interval = max(settings.run_control_cleanup_interval_seconds, 5)
    while True:
        await asyncio.sleep(interval)
        try:
            with SessionLocal() as db:
                count = expire_paused_controls(db)
            if count:
                logger.info("run_control_cleanup expired=%s", count)
        except Exception:
            # 清理失败不影响主流程，下一轮继续
            logger.warning("run_control_cleanup_failed", exc_info=True)
