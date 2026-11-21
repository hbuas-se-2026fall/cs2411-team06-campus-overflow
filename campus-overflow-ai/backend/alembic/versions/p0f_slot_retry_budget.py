"""槽位租约重试预算：agent_slot_leases.retry_count（P0-6）。

同一 job 的顶替/重试各消耗 1，初始 5，归零后不可再占用该槽位；
其他 job 接管过期槽位时重置为初始预算。
"""

from alembic import op
import sqlalchemy as sa

revision = "p0f_slot_retry_budget"
down_revision = "p0e_slot_waiters"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("agent_slot_leases") as batch:
        batch.add_column(sa.Column(
            "retry_count", sa.Integer(), nullable=False, server_default="5",
        ))


def downgrade():
    with op.batch_alter_table("agent_slot_leases") as batch:
        batch.drop_column("retry_count")
