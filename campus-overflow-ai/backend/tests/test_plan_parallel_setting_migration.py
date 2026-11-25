"""在隔离 SQLite 上验证 SA-07C 系统设置表的增量迁移与回滚。"""

from pathlib import Path

from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from alembic import command
from app.core.config import settings


def test_system_settings_migration_round_trip(tmp_path: Path, monkeypatch) -> None:
    url = f"sqlite:///{(tmp_path / 'sa07c_migration.sqlite').as_posix()}"
    monkeypatch.setattr(settings, "database_url", url)
    config = Config("alembic.ini")
    command.stamp(config, "p0f_slot_retry_budget")
    command.upgrade(config, "sa07c_system_settings")

    engine = create_engine(url)
    assert "system_settings" in inspect(engine).get_table_names()
    columns = {item["name"] for item in inspect(engine).get_columns("system_settings")}
    assert {"key", "value", "updated_by", "updated_at"} <= columns
    with engine.begin() as connection:
        assert (
            connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            == "sa07c_system_settings"
        )

    command.downgrade(config, "p0f_slot_retry_budget")
    assert "system_settings" not in inspect(engine).get_table_names()
