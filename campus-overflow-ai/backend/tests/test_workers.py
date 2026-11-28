from app.core.workers import compute_workers


def test_uses_all_available_cores_within_budget() -> None:
    # 4C4G、每 worker 20 连接、预算 100：4 核全部可用
    assert compute_workers(cpus=4, memory_gb=4, pool_per_worker=20, connection_budget=100) == 4


def test_database_budget_caps_workers() -> None:
    # 16 核 16G，但预算只允许 100 / 20 = 5 个 worker
    assert compute_workers(cpus=16, memory_gb=16, pool_per_worker=20, connection_budget=100) == 5


def test_memory_and_minimum_floor() -> None:
    assert compute_workers(cpus=16, memory_gb=1, pool_per_worker=20, connection_budget=100) == 1
    assert compute_workers(cpus=0, memory_gb=0, pool_per_worker=0, connection_budget=0) == 1


def test_explicit_max_workers_wins() -> None:
    assert compute_workers(
        cpus=16, memory_gb=16, pool_per_worker=20, connection_budget=100, max_workers=2,
    ) == 2
