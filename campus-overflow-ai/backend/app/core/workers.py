"""运行时容量计算：worker 数由可用 CPU、内存与数据库连接预算共同决定（ADR-013）。"""


def compute_workers(
    cpus: int,
    memory_gb: int,
    pool_per_worker: int,
    connection_budget: int,
    max_workers: int | None = None,
) -> int:
    """取 CPU、内存、连接预算三者的最小值；任何输入异常时至少返回 1。"""
    cpus = max(1, cpus)
    memory_gb = max(1, memory_gb)
    pool_per_worker = max(1, pool_per_worker)
    by_budget = max(1, connection_budget // pool_per_worker)
    workers = max(1, min(cpus, memory_gb, by_budget))
    if max_workers is not None and max_workers > 0:
        workers = min(workers, max_workers)
    return workers
