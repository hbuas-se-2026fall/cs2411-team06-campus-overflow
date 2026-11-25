"""运行控制系统命令（T-21D）：允许 requested_by 为空表示暂停超时自动取消。

管理员命令仍写入管理员 id；系统清理命令由后端定时/惰性收敛产生。
"""

from alembic import op
import sqlalchemy as sa

revision = "rc02_system_commands"
down_revision = "rc01_run_control"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("agent_run_commands") as batch:
        batch.alter_column(
            "requested_by", existing_type=sa.Integer(), nullable=True,
        )


def downgrade():
    with op.batch_alter_table("agent_run_commands") as batch:
        batch.alter_column(
            "requested_by", existing_type=sa.Integer(), nullable=False,
        )
