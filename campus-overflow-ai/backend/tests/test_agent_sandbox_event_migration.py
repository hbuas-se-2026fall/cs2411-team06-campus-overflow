"""在隔离 SQLite 上验证 P0-4 沙箱审计增量迁移的建表与回滚。"""

from pathlib import Path

from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from alembic import command
from app.core.config import settings


def test_sandbox_event_migration_round_trip(tmp_path: Path, monkeypatch) -> None:
    url = f"sqlite:///{(tmp_path / 'p0d_migration.sqlite').as_posix()}"
    monkeypatch.setattr(settings, "database_url", url)
    config = Config("alembic.ini")
    command.stamp(config, "p0c_chat_streams")
    command.upgrade(config, "p0d_sandbox_events")

    engine = create_engine(url)
    assert "agent_sandbox_events" in inspect(engine).get_table_names()
    indexes = {item["name"] for item in inspect(engine).get_indexes("agent_sandbox_events")}
    assert {
        "ix_agent_sandbox_events_outcome",
        "ix_agent_sandbox_events_trace_id",
        "ix_agent_sandbox_events_created_at",
    } <= indexes
    with engine.begin() as connection:
        assert (
            connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            == "p0d_sandbox_events"
        )

    command.downgrade(config, "p0c_chat_streams")
    assert "agent_sandbox_events" not in inspect(engine).get_table_names()
