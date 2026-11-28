from app.core.config import Settings
from app.db.session import build_engine

DB_URL = "mysql+pymysql://root:root@localhost:3306/campus_overflow?charset=utf8mb4"


def _settings(**overrides) -> Settings:
    values = {"_env_file": None, "debug": True, "database_url": DB_URL}
    values.update(overrides)
    return Settings(**values)


def test_build_engine_uses_configured_pool() -> None:
    engine = build_engine(
        _settings(
            db_pool_size=7, db_pool_max_overflow=9,
            db_pool_timeout=3.0, db_pool_recycle=1200,
        ),
    )
    try:
        assert engine.pool.size() == 7
        assert engine.pool._max_overflow == 9  # noqa: SLF001 - 校验池配置
        assert engine.pool._timeout == 3.0  # noqa: SLF001
    finally:
        engine.dispose()


def test_default_pool_matches_adr_012() -> None:
    engine = build_engine(_settings())
    try:
        assert engine.pool.size() == 10
        assert engine.pool._max_overflow == 10  # noqa: SLF001
        assert engine.pool._timeout == 5.0  # noqa: SLF001
    finally:
        engine.dispose()
