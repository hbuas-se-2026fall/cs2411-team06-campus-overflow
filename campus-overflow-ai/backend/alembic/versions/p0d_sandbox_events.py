"""沙箱执行审计：agent_sandbox_events（P0-4）。

系统级事件，不归属用户；只存命令摘要、计数、耗时与原因码，
不落参数正文、URL、stderr 或凭据。
"""

from alembic import op
import sqlalchemy as sa

revision = "p0d_sandbox_events"
down_revision = "p0c_chat_streams"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_sandbox_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("event", sa.String(30), nullable=False, server_default="sandbox_exec"),
        sa.Column("outcome", sa.String(16), nullable=False),
        sa.Column("tool", sa.String(50), nullable=False),
        sa.Column("executable", sa.String(128), nullable=False),
        sa.Column("command_digest", sa.String(64), nullable=False),
        sa.Column("arg_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("action_class", sa.String(16), nullable=False),
        sa.Column("network_mode", sa.String(16), nullable=False),
        sa.Column("trace_id", sa.String(64), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reason_code", sa.String(40), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    for column in ("outcome", "trace_id", "created_at"):
        op.create_index(
            f"ix_agent_sandbox_events_{column}", "agent_sandbox_events", [column],
        )


def downgrade():
    for column in ("created_at", "trace_id", "outcome"):
        op.drop_index(
            f"ix_agent_sandbox_events_{column}", table_name="agent_sandbox_events",
        )
    op.drop_table("agent_sandbox_events")
