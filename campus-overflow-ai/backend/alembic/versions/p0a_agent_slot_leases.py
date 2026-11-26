"""跨实例槽位租约：agent_slot_leases（P0-1）。"""

from alembic import op
import sqlalchemy as sa

revision = "p0a_agent_slot_leases"
down_revision = "sa03_agent_run_pool"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_slot_leases",
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("slot_no", sa.Integer(), nullable=False),
        sa.Column("owner_instance", sa.String(64), nullable=False),
        sa.Column("job_id", sa.String(64), nullable=False),
        sa.Column("fencing_token", sa.String(64), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("kind", "slot_no"),
    )
    op.create_index(
        "ix_agent_slot_leases_lease_expires_at", "agent_slot_leases", ["lease_expires_at"],
    )


def downgrade():
    op.drop_index("ix_agent_slot_leases_lease_expires_at", table_name="agent_slot_leases")
    op.drop_table("agent_slot_leases")
