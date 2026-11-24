"""系统运行开关表（SA-07C / ADR-010）：当前仅计划内并行开关。

缺省无记录表示关闭；值以 "true"/"false" 字符串保存，
仅管理员可写，Agent 通过 /internal/agent/runtime-config 只读获取。
"""

from alembic import op
import sqlalchemy as sa

revision = "sa07c_system_settings"
down_revision = "p0f_slot_retry_budget"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "system_settings",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", sa.String(255), nullable=False),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )


def downgrade():
    op.drop_table("system_settings")
