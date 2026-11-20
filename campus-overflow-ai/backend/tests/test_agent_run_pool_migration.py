"""在隔离 SQLite 前置表上验证 SA-03 增量迁移：新增槽位归属字段且保留既有运行记录。"""

from pathlib import Path

from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from alembic import command
from app.core.config import settings


def test_agent_run_pool_fields_migration_preserves_legacy_rows(
    tmp_path: Path, monkeypatch
) -> None:
    url = f"sqlite:///{(tmp_path / 'sa03_migration.sqlite').as_posix()}"
    monkeypatch.setattr(settings, "database_url", url)
    engine = create_engine(url)
    with engine.begin() as connection:
        connection.execute(
            text("""
            CREATE TABLE agent_runs (
                id INTEGER PRIMARY KEY,
                user_id INTEGER,
                task_type VARCHAR(50) NOT NULL,
                trace_id VARCHAR(64) NOT NULL,
                agent_run_id VARCHAR(64) NOT NULL UNIQUE,
                input_summary TEXT NOT NULL,
                output_summary TEXT,
                error_summary TEXT,
                status VARCHAR(20) NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        )
        connection.execute(
            text("""
            INSERT INTO agent_runs (task_type, trace_id, agent_run_id, input_summary, status)
            VALUES ('chat', 'legacy-trace', 'legacy-run', 'legacy summary', 'succeeded')
        """)
        )
    config = Config("alembic.ini")
    command.stamp(config, "p2_scan_worker_lease")
    command.upgrade(config, "sa03_agent_run_pool")

    with engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT actor_kind, parent_run_id, slot_kind, slot_id, status "
                "FROM agent_runs"
            )
        ).one()
        assert row == (None, None, None, None, "succeeded")
        assert (
            connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            == "sa03_agent_run_pool"
        )
    indexes = {item["name"] for item in inspect(engine).get_indexes("agent_runs")}
    assert {"ix_agent_runs_actor_kind", "ix_agent_runs_parent_run_id"} <= indexes

    command.downgrade(config, "p2_scan_worker_lease")
    columns = {item["name"] for item in inspect(engine).get_columns("agent_runs")}
    assert not {"actor_kind", "parent_run_id", "slot_kind", "slot_id"} & columns

    command.upgrade(config, "sa03_agent_run_pool")
    with engine.connect() as connection:
        assert (
            connection.execute(text("SELECT agent_run_id FROM agent_runs")).scalar_one()
            == "legacy-run"
        )
