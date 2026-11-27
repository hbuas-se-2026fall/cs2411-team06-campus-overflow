# 应用配置：环境变量优先，默认值仅用于本地开发
from urllib.parse import unquote, urlsplit

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_JWT_SECRET = "dev-jwt-secret-change-in-production"


def _database_password(url: str) -> str:
    """取数据库连接里的密码；解析失败按空密码处理，交由生产态校验拒绝。"""
    try:
        netloc = urlsplit(url).netloc
    except ValueError:
        return ""
    if "@" not in netloc:
        return ""
    userinfo = netloc.rsplit("@", 1)[0]
    return unquote(userinfo.split(":", 1)[1]) if ":" in userinfo else ""


class Settings(BaseSettings):
    app_name: str = "CampusOverflow AI Backend"
    debug: bool = True

    # CORS 白名单：逗号分隔来源列表（偏离参考设计 #7：不全开）
    cors_origins: str = "http://localhost:3000"

    # MySQL 连接（同步 SQLAlchemy + PyMySQL）
    database_url: str = "mysql+pymysql://root:root@localhost:3306/campus_overflow?charset=utf8mb4"
    # 连接池（ADR-012）：单 worker 容量；多 worker 总量 = workers × (pool_size + max_overflow)
    db_pool_size: int = 10
    db_pool_max_overflow: int = 10
    db_pool_timeout: float = 5.0
    db_pool_recycle: int = 1800

    # 服务间调用凭证（Agent 调用 /internal/agent/* 时校验，T-12 启用）
    agent_service_token: str = "dev-agent-token"
    # JSON：[{key_hash: SHA256, user_id: 管理员ID, enabled: true}]；无默认授权。
    external_agent_keys: str = "[]"
    # GL：只有显式启用才接收v2申请，不影响旧工单。
    governance_executor_enabled: bool = False
    governance_workflow_enabled: bool = False
    # 专用执行器凭证无默认授权；不得与普通服务凭证相同。
    governance_executor_token: str = ""
    private_context_root: str = ""

    # 维护读模式（S2）：夜间知识快照构建期间只允许浏览与问答，写操作统一拒绝；默认关闭
    maintenance_read_only_enabled: bool = False
    maintenance_read_only_start: str = "01:00"
    maintenance_read_only_end: str = "05:00"

    # 运行记录保留策略（T-16-D）：早于保留天数的已结束运行由运维脚本归档后清理
    agent_run_retention_days: int = 90
    agent_run_archive_dir: str = ""

    # 运行中人工控制（T-21 / RC-R01～R05）：暂停、继续、取消与引导注入；默认关闭
    run_control_enabled: bool = False
    # 暂停超时定时清理间隔（T-21D）；<=0 关闭定时清理，仅保留读时惰性判定
    run_control_cleanup_interval_seconds: int = 60

    # JWT 认证配置
    jwt_secret: str = DEFAULT_JWT_SECRET
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 1440  # 24 小时

    model_config = SettingsConfigDict(env_file=".env", env_prefix="BACKEND_", extra="ignore")

    @model_validator(mode="after")
    def _enforce_production_secrets(self) -> "Settings":
        """生产态密钥门禁：默认或过弱的密钥直接启动失败，避免伪造 JWT（ADR-012）。"""
        if self.debug:
            return self
        problems: list[str] = []
        if self.jwt_secret == DEFAULT_JWT_SECRET or len(self.jwt_secret.encode("utf-8")) < 32:
            problems.append("BACKEND_JWT_SECRET 必须是非默认值且至少 32 字节")
        password = _database_password(self.database_url)
        if password in {"", "root"} or len(password) < 12:
            problems.append("BACKEND_DATABASE_URL 必须使用非默认且至少 12 字符的数据库密码")
        if problems:
            raise ValueError("；".join(problems))
        return self


settings = Settings()
