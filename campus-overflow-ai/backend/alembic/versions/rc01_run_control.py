"""运行控制（T-21A / RC-R01）：agent_run_controls 与 agent_run_commands 两表。

权威状态在后端，revision 单调递增用于跨实例 fencing；命令消费后清空引导正文。
"""

from alembic import op
import sqlalchemy as sa

revision = "rc01_run_control"
down_revision = "n04_mcp_call_logs"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_run_controls",
        sa.Column("agent_run_id", sa.String(64), primary_key=True),
        sa.Column("state", sa.String(16), nullable=False, server_default="running"),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pause_deadline", sa.DateTime(), nullable=True),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "agent_run_commands",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("agent_run_id", sa.String(64), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("guidance_text", sa.Text(), nullable=True),
        sa.Column("guidance_digest", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("requested_by", sa.Integer(), nullable=False),
        sa.Column("trace_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("applied_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_agent_run_commands_agent_run_id", "agent_run_commands", ["agent_run_id"])
    op.create_index(
        "ix_agent_run_commands_run_status", "agent_run_commands", ["agent_run_id", "status"]
    )


def downgrade():
    op.drop_index("ix_agent_run_commands_run_status", table_name="agent_run_commands")
    op.drop_index("ix_agent_run_commands_agent_run_id", table_name="agent_run_commands")
    op.drop_table("agent_run_commands")
    op.drop_table("agent_run_controls")
