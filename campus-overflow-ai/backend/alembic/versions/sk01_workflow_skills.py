"""工作流 skill 沉淀（T-22A / SK-R01～R04）：workflow_skills 与 workflow_skill_versions。

skill 版本以 (skill_id, version) 为唯一键；归档只改 skill 状态，不删除版本行，
历史运行对旧版本的引用仍可读。
"""

from alembic import op
import sqlalchemy as sa

revision = "sk01_workflow_skills"
down_revision = "rc02_system_commands"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "workflow_skills",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("task_type", sa.String(40), nullable=False),
        sa.Column("course_id", sa.Integer(), sa.ForeignKey("courses.id"), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("current_version", sa.Integer(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_workflow_skills_status", "workflow_skills", ["status"])
    op.create_index(
        "ix_workflow_skills_task_status", "workflow_skills", ["task_type", "status"]
    )
    op.create_index("ix_workflow_skills_course_id", "workflow_skills", ["course_id"])

    op.create_table(
        "workflow_skill_versions",
        sa.Column(
            "skill_id",
            sa.Integer(),
            sa.ForeignKey("workflow_skills.id"),
            primary_key=True,
        ),
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.Column("source_run_id", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("published_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_workflow_skill_versions_source_run_id",
        "workflow_skill_versions",
        ["source_run_id"],
    )


def downgrade():
    op.drop_index(
        "ix_workflow_skill_versions_source_run_id",
        table_name="workflow_skill_versions",
    )
    op.drop_table("workflow_skill_versions")
    op.drop_index("ix_workflow_skills_course_id", table_name="workflow_skills")
    op.drop_index("ix_workflow_skills_task_status", table_name="workflow_skills")
    op.drop_index("ix_workflow_skills_status", table_name="workflow_skills")
    op.drop_table("workflow_skills")
