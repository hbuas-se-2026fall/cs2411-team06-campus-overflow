"""agent_runs 增加子 Agent 运行归属：parent_run_id / actor_kind / slot_kind / slot_id。"""

from alembic import op
import sqlalchemy as sa

revision = "sa03_agent_run_pool"
down_revision = "p2_scan_worker_lease"
branch_labels = None
depends_on = None

_COLUMNS = (
    ("actor_kind", sa.String(16)),
    ("parent_run_id", sa.String(64)),
    ("slot_kind", sa.String(16)),
    ("slot_id", sa.String(32)),
)
_INDEXES = (
    ("ix_agent_runs_actor_kind", "actor_kind"),
    ("ix_agent_runs_parent_run_id", "parent_run_id"),
)


def _existing_columns() -> set[str] | None:
    """返回 agent_runs 现有列；表不存在时返回 None，兼容部分基线的迁移测试。"""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("agent_runs"):
        return None
    return {column["name"] for column in inspector.get_columns("agent_runs")}


def upgrade():
    existing = _existing_columns()
    if existing is None:
        return
    for name, type_ in _COLUMNS:
        if name not in existing:
            op.add_column("agent_runs", sa.Column(name, type_, nullable=True))
    index_names = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("agent_runs")}
    for index_name, column in _INDEXES:
        if index_name not in index_names:
            op.create_index(op.f(index_name), "agent_runs", [column], unique=False)


def downgrade():
    existing = _existing_columns()
    if existing is None:
        return
    index_names = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("agent_runs")}
    for index_name, _ in _INDEXES:
        if index_name in index_names:
            op.drop_index(op.f(index_name), table_name="agent_runs")
    for name, _ in reversed(_COLUMNS):
        if name in existing:
            op.drop_column("agent_runs", name)
