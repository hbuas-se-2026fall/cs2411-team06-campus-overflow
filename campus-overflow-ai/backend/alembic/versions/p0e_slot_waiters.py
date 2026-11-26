"""全局问答排队票据：agent_slot_waiters（P0-5）。

容量已满时按入队顺序等待，授予后由 Agent 轮询取走租约并删除票据；
等待到期由 expires_at 判定，过期队首在下次晋升时机会式删除。
"""

from alembic import op
import sqlalchemy as sa

revision = "p0e_slot_waiters"
down_revision = "p0d_sandbox_events"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_slot_waiters",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("job_id", sa.String(64), nullable=False),
        sa.Column("instance_id", sa.String(64), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False),
        sa.Column("ttl_seconds", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="waiting"),
        sa.Column("slot_no", sa.Integer(), nullable=True),
        sa.Column("fencing_token", sa.String(64), nullable=True),
        sa.Column("enqueued_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("granted_at", sa.DateTime(), nullable=True),
    )
    for column in ("kind", "enqueued_at", "expires_at"):
        op.create_index(
            f"ix_agent_slot_waiters_{column}", "agent_slot_waiters", [column],
        )


def downgrade():
    for column in ("expires_at", "enqueued_at", "kind"):
        op.drop_index(
            f"ix_agent_slot_waiters_{column}", table_name="agent_slot_waiters",
        )
    op.drop_table("agent_slot_waiters")
