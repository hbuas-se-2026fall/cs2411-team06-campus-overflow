"""在隔离 SQLite 上验证 P0-6 租约重试预算增量迁移的加列与回滚。"""

from pathlib import Path

from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from alembic import command
from app.core.config import settings


def test_retry_budget_migration_round_trip(tmp_path: Path, monkeypatch) -> None:
    url = f"sqlite:///{(tmp_path / 'p0f_migration.sqlite').as_posix()}"
    monkeypatch.setattr(settings, "database_url", url)
    config = Config("alembic.ini")
    command.stamp(config, "sa03_agent_run_pool")
    command.upgrade(config, "p0a_agent_slot_leases")
    command.upgrade(config, "p0f_slot_retry_budget")

    engine = create_engine(url)
    columns = {item["name"] for item in inspect(engine).get_columns("agent_slot_leases")}
    assert "retry_count" in columns
    with engine.begin() as connection:
        assert (
            connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            == "p0f_slot_retry_budget"
        )

    command.downgrade(config, "p0e_slot_waiters")
    columns = {item["name"] for item in inspect(engine).get_columns("agent_slot_leases")}
    assert "retry_count" not in columns
