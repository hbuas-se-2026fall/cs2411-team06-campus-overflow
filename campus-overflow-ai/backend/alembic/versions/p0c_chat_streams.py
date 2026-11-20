"""聊天可恢复流：agent_chat_streams / agent_chat_stream_events（P0-3）。

只保存运行状态与按序事件，不保存凭证；30 分钟过期由业务层机会式清理。
"""

from alembic import op
import sqlalchemy as sa

revision = "p0c_chat_streams"
down_revision = "p0a_agent_slot_leases"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_chat_streams",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.String(36), nullable=False),
        sa.Column("agent_run_id", sa.String(64), nullable=True),
        sa.Column("trace_id", sa.String(64), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="running"),
        sa.Column(
            "cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "request_id", name="uq_chat_stream_user_request"),
    )
    for column in ("user_id", "request_id", "status", "expires_at"):
        op.create_index(
            f"ix_agent_chat_streams_{column}", "agent_chat_streams", [column],
        )
    op.create_table(
        "agent_chat_stream_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "stream_id",
            sa.Integer(),
            sa.ForeignKey("agent_chat_streams.id"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(20), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("stream_id", "seq", name="uq_chat_stream_event_seq"),
    )
    op.create_index(
        "ix_agent_chat_stream_events_stream_id",
        "agent_chat_stream_events",
        ["stream_id"],
    )


def downgrade():
    op.drop_index(
        "ix_agent_chat_stream_events_stream_id", table_name="agent_chat_stream_events",
    )
    op.drop_table("agent_chat_stream_events")
    for column in ("expires_at", "status", "request_id", "user_id"):
        op.drop_index(
            f"ix_agent_chat_streams_{column}", table_name="agent_chat_streams",
        )
    op.drop_table("agent_chat_streams")
