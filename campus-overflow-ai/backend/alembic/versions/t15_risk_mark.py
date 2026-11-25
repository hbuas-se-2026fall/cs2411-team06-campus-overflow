"""低风险内容打标（T-15-F）：moderation_marks 按目标唯一，保留最新评估。

不改变内容可见性与编辑时间；仅 Agent 内部写入、管理员只读。
"""

from alembic import op
import sqlalchemy as sa

revision = "t15_risk_mark"
down_revision = "t15_edit_action"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "moderation_marks",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("target_type", sa.String(16), nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("risk_level", sa.String(8), nullable=False, server_default="low"),
        sa.Column("reason", sa.String(200), nullable=False, server_default=""),
        sa.Column("agent_run_id", sa.String(64), nullable=False),
        sa.Column("trace_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("target_type", "target_id", name="uq_moderation_mark_target"),
    )


def downgrade():
    op.drop_table("moderation_marks")
