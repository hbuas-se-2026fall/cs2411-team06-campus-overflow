"""旧后端记忆清理（T-14 M-04 / C-07）：个人记忆改为浏览器按账号保存。

删除一期预留的 agent_memory 表；管理员私人上下文使用独立私有文件存储，
用户偏好/课程上下文不再由业务后端持久化。
"""

from alembic import op
import sqlalchemy as sa

revision = "t14_legacy_memory_cleanup"
down_revision = "t15_risk_mark"
branch_labels = None
depends_on = None


def upgrade():
    # 兼容未创建 agent_memory 的迁移测试库
    if sa.inspect(op.get_bind()).has_table("agent_memory"):
        op.drop_table("agent_memory")


def downgrade():
    if sa.inspect(op.get_bind()).has_table("agent_memory"):
        return

    op.create_table(
        "agent_memory",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("memory_type", sa.String(20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("course_id", sa.Integer(), nullable=True),
        sa.Column("source_run_id", sa.String(64), nullable=True),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
