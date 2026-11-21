"""在隔离 SQLite 上验证 P0-3 聊天流增量迁移的建表与回滚。"""

from pathlib import Path

from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from alembic import command
from app.core.config import settings


def test_chat_stream_migration_round_trip(tmp_path: Path, monkeypatch) -> None:
    url = f"sqlite:///{(tmp_path / 'p0c_migration.sqlite').as_posix()}"
    monkeypatch.setattr(settings, "database_url", url)
    config = Config("alembic.ini")
    command.stamp(config, "p0a_agent_slot_leases")
    command.upgrade(config, "p0c_chat_streams")

    engine = create_engine(url)
    tables = set(inspect(engine).get_table_names())
    assert {"agent_chat_streams", "agent_chat_stream_events"} <= tables
    indexes = {item["name"] for item in inspect(engine).get_indexes("agent_chat_streams")}
    assert {
        "ix_agent_chat_streams_user_id",
        "ix_agent_chat_streams_request_id",
        "ix_agent_chat_streams_status",
        "ix_agent_chat_streams_expires_at",
    } <= indexes
    with engine.begin() as connection:
        assert (
            connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            == "p0c_chat_streams"
        )

    command.downgrade(config, "p0a_agent_slot_leases")
    remaining = set(inspect(engine).get_table_names())
    assert not {"agent_chat_streams", "agent_chat_stream_events"} & remaining
