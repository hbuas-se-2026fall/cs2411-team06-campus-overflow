"""要求修改动作（T-15-E）：问题/回答新增 needs_revision 标记。

置位只表示管理员要求作者修改，不改变可见性；作者编辑内容即清除。
"""

from alembic import op
import sqlalchemy as sa

revision = "t15_edit_action"
down_revision = "sa07c_system_settings"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return inspector.has_table(table) and any(
        item["name"] == column for item in inspector.get_columns(table)
    )


def upgrade():
    # 兼容只建了部分表的迁移测试库：缺表/已加列时跳过，不阻断后续 head。
    inspector = sa.inspect(op.get_bind())
    for table in ("questions", "answers"):
        if not inspector.has_table(table):
            continue
        if not any(item["name"] == "needs_revision" for item in inspector.get_columns(table)):
            op.add_column(
                table,
                sa.Column("needs_revision", sa.Boolean(), nullable=False, server_default="0"),
            )


def downgrade():
    if _has_column("answers", "needs_revision"):
        op.drop_column("answers", "needs_revision")
    if _has_column("questions", "needs_revision"):
        op.drop_column("questions", "needs_revision")
