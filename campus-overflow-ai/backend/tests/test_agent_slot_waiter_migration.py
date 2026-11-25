"""在隔离 SQLite 上验证 P0-5 排队票据增量迁移的建表与回滚。"""

from pathlib import Path

from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from alembic import command
from app.core.config import settings


def test_slot_waiter_migration_round_trip(tmp_path: Path, monkeypatch) -> None:
    url = f"sqlite:///{(tmp_path / 'p0e_migration.sqlite').as_posix()}"
    monkeypatch.setattr(settings, "database_url", url)
    config = Config("alembic.ini")
    command.stamp(config, "p0d_sandbox_events")
    command.upgrade(config, "p0e_slot_waiters")

    engine = create_engine(url)
    assert "agent_slot_waiters" in inspect(engine).get_table_names()
    indexes = {item["name"] for item in inspect(engine).get_indexes("agent_slot_waiters")}
    assert {
        "ix_agent_slot_waiters_kind",
        "ix_agent_slot_waiters_enqueued_at",
        "ix_agent_slot_waiters_expires_at",
    } <= indexes
    with engine.begin() as connection:
        assert (
            connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            == "p0e_slot_waiters"
        )

    command.downgrade(config, "p0d_sandbox_events")
    assert "agent_slot_waiters" not in inspect(engine).get_table_names()
