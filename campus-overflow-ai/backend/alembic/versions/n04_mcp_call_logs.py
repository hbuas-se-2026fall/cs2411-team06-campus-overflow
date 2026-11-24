"""MCP 调用审计（T-17 N-04 / US-18）：mcp_call_logs 追加式记录脱敏摘要。

服务 token 写入，管理员只读检索；不存凭证与原始参数/结果。
"""

from alembic import op
import sqlalchemy as sa

revision = "n04_mcp_call_logs"
down_revision = "t14_legacy_memory_cleanup"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "mcp_call_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("client_name", sa.String(80), nullable=False),
        sa.Column("tool_name", sa.String(120), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("args_summary", sa.String(200), nullable=False, server_default=""),
        sa.Column("result_summary", sa.String(200), nullable=True),
        sa.Column("error_summary", sa.String(200), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("trace_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_mcp_call_logs_created_at", "mcp_call_logs", ["created_at"])
    op.create_index("ix_mcp_call_logs_trace_id", "mcp_call_logs", ["trace_id"])


def downgrade():
    op.drop_index("ix_mcp_call_logs_trace_id", table_name="mcp_call_logs")
    op.drop_index("ix_mcp_call_logs_created_at", table_name="mcp_call_logs")
    op.drop_table("mcp_call_logs")
