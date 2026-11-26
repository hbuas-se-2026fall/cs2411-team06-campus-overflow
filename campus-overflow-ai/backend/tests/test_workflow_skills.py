# T-22A 工作流 skill 存储：版本唯一、归档不破坏历史引用、迁移可执行
from pathlib import Path

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from alembic import command
from app.core.config import settings
from app.modules.governance.models import WorkflowSkill, WorkflowSkillVersion


def _create_skill(db_session: Session, *, task_type: str = "moderation_scan") -> WorkflowSkill:
    skill = WorkflowSkill(name="治理巡检复用路径", task_type=task_type, status="active")
    db_session.add(skill)
    db_session.flush()
    return skill


def test_skill_version_is_unique_per_skill(db_session: Session):
    skill = _create_skill(db_session)
    db_session.add(
        WorkflowSkillVersion(
            skill_id=skill.id, version=1, content={"steps": ["读取现状"]}, status="published",
        )
    )
    db_session.commit()

    db_session.add(
        WorkflowSkillVersion(
            skill_id=skill.id, version=1, content={"steps": ["重复版本"]}, status="draft",
        )
    )
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()

    rows = db_session.execute(select(WorkflowSkillVersion)).scalars().all()
    assert [row.content for row in rows] == [{"steps": ["读取现状"]}]


def test_same_version_allowed_across_skills(db_session: Session):
    first = _create_skill(db_session, task_type="moderation_scan")
    second = _create_skill(db_session, task_type="patrol_scan")
    db_session.add_all(
        [
            WorkflowSkillVersion(skill_id=first.id, version=1, content={"steps": ["a"]}),
            WorkflowSkillVersion(skill_id=second.id, version=1, content={"steps": ["b"]}),
        ]
    )
    db_session.commit()

    rows = db_session.execute(select(WorkflowSkillVersion)).scalars().all()
    assert {(row.skill_id, row.version) for row in rows} == {
        (first.id, 1),
        (second.id, 1),
    }


def test_archive_keeps_versions_readable(db_session: Session):
    skill = _create_skill(db_session)
    skill.current_version = 1
    db_session.add_all(
        [
            WorkflowSkillVersion(
                skill_id=skill.id,
                version=1,
                content={"steps": ["读取现状", "复核"]},
                status="published",
                source_run_id="run-legacy",
            ),
            WorkflowSkillVersion(
                skill_id=skill.id, version=2, content={"steps": ["草稿"]}, status="draft",
            ),
        ]
    )
    db_session.commit()

    skill.status = "archived"
    db_session.commit()

    stored = db_session.get(WorkflowSkill, skill.id)
    assert stored.status == "archived"
    # 归档不删除版本，仍指向已发布版本，历史运行引用的内容可读
    assert stored.current_version == 1
    versions = db_session.execute(
        select(WorkflowSkillVersion).order_by(WorkflowSkillVersion.version)
    ).scalars().all()
    assert [(row.version, row.status) for row in versions] == [
        (1, "published"),
        (2, "draft"),
    ]
    assert versions[0].content == {"steps": ["读取现状", "复核"]}
    assert versions[0].source_run_id == "run-legacy"


def test_skill_migration_creates_and_drops_tables(tmp_path: Path, monkeypatch) -> None:
    url = f"sqlite:///{(tmp_path / 'sk01_migration.sqlite').as_posix()}"
    monkeypatch.setattr(settings, "database_url", url)
    engine = create_engine(url)
    config = Config("alembic.ini")

    command.stamp(config, "rc02_system_commands")
    command.upgrade(config, "sk01_workflow_skills")

    tables = set(inspect(engine).get_table_names())
    assert {"workflow_skills", "workflow_skill_versions"} <= tables
    primary_key = inspect(engine).get_pk_constraint("workflow_skill_versions")
    assert set(primary_key["constrained_columns"]) == {"skill_id", "version"}

    command.downgrade(config, "rc02_system_commands")
    assert "workflow_skills" not in set(inspect(engine).get_table_names())
    engine.dispose()
