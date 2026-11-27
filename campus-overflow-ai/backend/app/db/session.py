# 数据库会话：同步 SQLAlchemy + PyMySQL（决策见 docs/依赖说明.md）
from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, settings


def build_engine(config: Settings):
    """按配置构建连接池；多 worker 时每个进程独立持有一份（ADR-012）。"""
    return create_engine(
        config.database_url,
        pool_pre_ping=True,
        pool_recycle=config.db_pool_recycle,
        pool_size=config.db_pool_size,
        max_overflow=config.db_pool_max_overflow,
        pool_timeout=config.db_pool_timeout,
    )


engine = build_engine(settings)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖：请求级数据库会话。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
